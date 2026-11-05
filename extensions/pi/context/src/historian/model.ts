/**
 * The historian's model call, the same on both hosts: one pi-ai request without prompt caching, on a transport that
 * sends it exactly once, so each attempt record stands for one paid request.
 */
import type { AssistantMessage, Context, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { type ContextConfig, type ModelRef, parseModelRef } from "../core/config.ts";
import type { SummarizeRequest, SummarizeResult } from "./run.ts";

/** A model registry as far as the historian needs it: pi's `ctx.modelRegistry` fits. */
export interface ModelLookup<M> {
	find(provider: string, id: string): M | undefined;
}

/**
 * The models the historian asks. `primary` is the configured `historian.model`; undefined when none is configured,
 * so the session's own model answers. `fallback` is asked when the first model fails; undefined for none.
 */
export interface ResolvedPolicy<M> {
	readonly primary: M | undefined;
	readonly fallback: M | undefined;
}

/** Why a configured historian model cannot be used. There is no fallback to the session model for it. */
export interface ModelError {
	readonly modelError: string;
}

export function isModelError(result: unknown): result is ModelError {
	return typeof result === "object" && result !== null && "modelError" in result;
}

/**
 * Look up the models `historian.model` and `historian.fallbackModel` name. A name the registry does not know is an
 * error, because answering with the session's model instead would spend the most expensive model on summaries
 * without anyone having asked. Only an unset `historian.model` leaves the session's model to answer.
 */
export function resolveHistorianModels<M>(config: ContextConfig, registry: ModelLookup<M>): ResolvedPolicy<M> | ModelError {
	const problems: string[] = [];
	const resolve = (setting: "model" | "fallbackModel"): M | undefined => {
		const name = config.historian[setting];
		if (name === undefined) return undefined;
		const ref = parseModelRef(name);
		const model = ref && registry.find(ref.provider, ref.id);
		if (!model) problems.push(`historian.${setting} "${name}" is not a model this pi knows`);
		return model || undefined;
	};
	const primary = resolve("model");
	const fallback = resolve("fallbackModel");
	for (const [setting, model] of [["model", primary], ["fallbackModel", fallback]] as const) {
		const refused = model && refusedTransport(model);
		if (refused) problems.push(`historian.${setting} "${config.historian[setting]}" ${refused}`);
	}
	return problems.length > 0 ? { modelError: problems.join("; ") } : { primary, fallback };
}

/**
 * APIs whose client resends a failed request on its own, out of the historian's sight, so one attempt record could
 * stand for several paid requests. pi-ai builds Bedrock's AWS SDK client with the SDK's default of three attempts and
 * no option to lower it.
 */
const RESENDING_APIS: ReadonlyMap<string, string> = new Map([["bedrock-converse-stream", "Amazon Bedrock"]]);

/** Why the historian cannot ask `model`, or undefined when it can. */
export function refusedTransport(model: unknown): string | undefined {
	const api = typeof model === "object" && model !== null ? (model as { api?: unknown }).api : undefined;
	const service = typeof api === "string" ? RESENDING_APIS.get(api) : undefined;
	return service
		? `uses ${api} (${service}), whose client retries a request unseen; the historian counts every request it pays for`
		: undefined;
}

/** What the historian reads of a model's thinking support, as pi-ai's catalogue declares it. */
export interface ThinkingSupport {
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Readonly<Partial<Record<string, string | null>>>;
}

const LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * The reasoning option for a summary: none, which turns thinking off, unless the model cannot turn it off
 * (`thinkingLevelMap.off` is null); then the lowest level it supports. Thinking spends the output limit the summary needs.
 */
export function quietestReasoning(model: ThinkingSupport): ThinkingLevel | undefined {
	const map = model.thinkingLevelMap;
	if (!model.reasoning || map?.off !== null) return undefined;
	return LEVELS.find((level) => map[level] !== null);
}

/**
 * Ask `model` through `complete`, a host's simple pi-ai completion (`streamSimple`, which maps the reasoning
 * option), with the least thinking the model allows and no cache retention: a summary request shares no prefix with
 * the session's. The transport is pinned to one request: plain SSE, since a WebSocket transport reconnects and falls
 * back to SSE unseen, and no provider retries. A response that failed or was aborted throws; how it ended and its
 * tool calls are handed on.
 */
export async function summarizeWith(
	complete: (request: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>,
	model: ModelRef & ThinkingSupport,
	request: SummarizeRequest,
): Promise<SummarizeResult> {
	const reasoning = quietestReasoning(model);
	const response = await complete(
		{
			systemPrompt: request.system,
			messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
		},
		{
			maxTokens: request.maxTokens,
			signal: request.signal,
			cacheRetention: "none",
			transport: "sse",
			maxRetries: 0,
			...(reasoning ? { reasoning } : {}),
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `historian request ${response.stopReason}`);
	}
	const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	// A cut-off or empty answer would advance the summary's coverage over a stretch it never described.
	if (response.stopReason === "length") throw new Error("historian answer hit the output limit");
	if (text.trim() === "") throw new Error("historian answer was empty");
	// How it ended and any tool call go to the validator, which rejects an answer that is not a plain summary.
	const toolCalls = response.content.filter((block) => block.type === "toolCall").length;
	return { text, usage: response.usage, model: `${model.provider}/${model.id}`, stopReason: response.stopReason, toolCalls };
}
