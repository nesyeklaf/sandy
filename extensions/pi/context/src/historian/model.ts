/** The historian's model call, the same on both hosts: one pi-ai request without prompt caching. */
import type { AssistantMessage, Context, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ContextConfig } from "../core/config.ts";
import type { SummarizeRequest, SummarizeResult } from "./run.ts";

export interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

/** A `provider/model` reference; undefined when it names none. */
function modelRef(name: string | undefined): ModelRef | undefined {
	const slash = name?.indexOf("/") ?? -1;
	return name && slash > 0 ? { provider: name.slice(0, slash), id: name.slice(slash + 1) } : undefined;
}

/** The model `historian.model` names; undefined when it names none, so the session's model answers. */
export function historianModel(config: ContextConfig): ModelRef | undefined {
	return modelRef(config.historian.model);
}

/** The model `historian.fallbackModel` names, asked when the first model fails; undefined for no fallback. */
export function historianFallbackModel(config: ContextConfig): ModelRef | undefined {
	return modelRef(config.historian.fallbackModel);
}

/**
 * The first answer of `calls`, tried in order: a failed call hands over to the next one. When every call fails, the
 * error names each failure. An aborted run asks no further model.
 */
export async function firstAnswer<T>(calls: readonly (() => Promise<T>)[], signal?: AbortSignal): Promise<T> {
	const failures: string[] = [];
	for (const call of calls) {
		try {
			return await call();
		} catch (error) {
			if (signal?.aborted) throw error;
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(failures.length > 0 ? failures.join("; then: ") : "no model available for the historian");
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
 * the session's. A response that failed or was aborted throws.
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
	return { text, usage: response.usage, model: `${model.provider}/${model.id}` };
}
