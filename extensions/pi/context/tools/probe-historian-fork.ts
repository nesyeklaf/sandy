/**
 * Live comparison of the historian's two routes on a real provider:
 * `node --experimental-strip-types tools/probe-historian-fork.ts [--send] [--main=provider/model] [--historian=provider/model]
 * [--prefix=tokens] [--evidence=tokens] [--output=tokens] [--first-output=tokens] [--thinking=level] [--answers]`.
 *
 * It sends one main request (a system prompt, two tools and a long user turn) as pi would, keeps the main model's
 * answer as pi's `message_end` would, then asks for the same summary twice: as a fork of that exchange on the main
 * model's warm cache, and isolated on the historian model. It prints each request's usage and cost, what the route
 * choice predicted and whether the prediction held. Credentials come from pi's auth file.
 *
 * Spending: every request is sent with provider retries off and an explicit output limit, and is priced before it
 * leaves at its worst case: the payload as built, at the catalogue's input or cache-write rate (whichever is dearer, at
 * the tier the whole prompt reaches) with a margin on the token estimate, plus its full output limit. A request that
 * would take the sum past the budget is not sent. Without `--send` it is a dry run: it builds the main request
 * offline, prints the plan and the worst case of all three requests, and sends nothing.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, type AssistantMessage, type Context, calculateCost, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HISTORIAN_SYSTEM_PROMPT, type HistorianWork, historianPrompt, validateCompletion } from "../src/core/historian.ts";
import { promptTokens } from "../src/core/ledger.ts";
import { estimateTokens } from "../src/core/tokens.ts";
import { chooseRoute, forkTurn, HistorianRequests, type RouteRecord } from "../src/pi/historian.ts";

const BUDGET_DOLLARS = 1.5;
/**
 * The token estimate counts characters; a tokenizer counts more on markup: on 2026-10-31 the main request's JSON was
 * estimated at 39,789 tokens and Sonnet 5.5 counted 53,197 (1.34 times).
 */
const INPUT_MARGIN = 1.6;
const flag = (name: string, fallback: string) =>
	process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const send = process.argv.includes("--send");
const mainRef = flag("main", "anthropic/claude-sonnet-5-5");
const historianRef = flag("historian", "anthropic/claude-fable-5");
const prefixTokens = Number(flag("prefix", "30000"));
const evidenceTokens = Number(flag("evidence", "6000"));
const thinking = flag("thinking", "low");
const maxOutputTokens = Number(flag("output", "4000"));
const firstOutputTokens = Number(flag("first-output", "1024"));

const runtime = await ModelRuntime.create({ authPath: join(getAgentDir(), "auth.json") });
const find = (ref: string) => {
	const [provider, ...id] = ref.split("/");
	const model = runtime.getModel(provider as string, id.join("/")) as Model<Api> | undefined;
	if (!model) throw new Error(`unknown model ${ref}`);
	return model;
};
const main = find(mainRef);
const historian = find(historianRef);

const source = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const repeat = (tokens: number) => {
	let text = "";
	for (let part = 0; estimateTokens(text) < tokens; part++) text += `\n## Part ${part}\n${source}`;
	return text;
};
const context: Context = {
	systemPrompt: "You are a coding agent. Answer briefly.",
	tools: [
		{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		{ name: "bash", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
	] as never,
	messages: [{ role: "user", content: [{ type: "text", text: `Here is the project documentation.\n${repeat(prefixTokens)}\n\nReply with OK.` }], timestamp: Date.now() }],
};

/** One stretch of a coding session: tool results with facts in them, as the historian is shown it. */
function work(): HistorianWork {
	const spans = [];
	for (let index = 0; estimateTokens(spans.map((span) => span.text).join("")) < evidenceTokens; index++) {
		const text = `[tool result: read src/module-${index}.ts]\nFACT module-${index} exports run${index}() and caches for ${index * 7} seconds.\n${source.slice(index * 1500, index * 1500 + 1500)}`;
		spans.push({ entryId: `e${index}`, from: 0, to: text.length, total: text.length, text, digest: String(index) });
	}
	return { previous: undefined, spans, coverage: { throughId: spans.at(-1)?.entryId ?? "" }, readAt: undefined, known: new Set(spans.map((span) => span.entryId)), tokens: evidenceTokens } as unknown as HistorianWork;
}
const shown = work();
const request = { system: HISTORIAN_SYSTEM_PROMPT, prompt: historianPrompt(shown), maxTokens: maxOutputTokens, signal: new AbortController().signal };
const turn = forkTurn(request);
const isolatedPromptTokens = estimateTokens(`${request.system}\n\n${request.prompt}`);
const reasoning = thinking !== "off" ? { reasoning: thinking as NonNullable<SimpleStreamOptions["reasoning"]> } : {};
const mainOptions = { ...reasoning, maxTokens: firstOutputTokens, maxRetries: 0 };

/**
 * The most a request can cost: its payload as fresh input or as a cache write of either retention (pi's settings may
 * ask for the hour, which Anthropic charges at twice the input rate), whichever is dearest, and its full output limit.
 */
function worstCase(model: Model<Api>, inputTokens: number, outputTokens: number): number {
	const priced = (fields: { input?: number; cacheWrite?: number; cacheWrite1h?: number }) =>
		calculateCost(model, { input: 0, output: outputTokens, cacheRead: 0, cacheWrite: 0, ...fields, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
	return Math.max(priced({ input: inputTokens }), priced({ cacheWrite: inputTokens }), priced({ cacheWrite: inputTokens, cacheWrite1h: inputTokens }));
}
const outputLimit = (payload: unknown) => Number((payload as { max_tokens?: unknown }).max_tokens);
const payloadTokens = (payload: unknown) => Math.ceil(estimateTokens(JSON.stringify(payload)) * INPUT_MARGIN);

/** The spend so far, at each sent request's worst case; a request that would pass the budget is refused before it leaves. */
const spent: { label: string; inputTokens: number; maxTokens: number; worstCase: number }[] = [];
let refused: string | undefined;
function charge(label: string, model: Model<Api>, payload: unknown): void {
	const maxTokens = outputLimit(payload);
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw new Error(`${label}: the request has no output limit`);
	const inputTokens = payloadTokens(payload);
	const cost = worstCase(model, inputTokens, maxTokens);
	const total = spent.reduce((sum, item) => sum + item.worstCase, 0) + cost;
	if (total > BUDGET_DOLLARS) {
		refused = `${label}: the worst case so far would be $${total.toFixed(3)}, past $${BUDGET_DOLLARS}`;
		throw new Error(refused);
	}
	spent.push({ label, inputTokens, maxTokens, worstCase: Number(cost.toFixed(5)) });
}

// The main request as built, offline: a key that is never used, and a payload hook that stops before anything leaves.
let built: unknown;
await streamSimple(main, context, {
	...mainOptions,
	apiKey: "dry-run",
	onPayload: (payload: unknown) => {
		built = structuredClone(payload);
		throw new Error("dry run");
	},
}).result();
if (built === undefined) throw new Error("pi-ai built no main request");
const mainLimit = outputLimit(built);
const mainInput = payloadTokens(built);
// Before the main answer exists: the fork carries an answer at its limit, and keeps the main request's thinking budget.
const forkLimit = maxOutputTokens + Math.max(0, mainLimit - firstOutputTokens);
const forkInput = mainInput + firstOutputTokens + Math.ceil(estimateTokens(turn) * INPUT_MARGIN);
const ceiling = {
	main: worstCase(main, mainInput, mainLimit),
	fork: worstCase(main, forkInput, forkLimit),
	isolated: worstCase(historian, Math.ceil(isolatedPromptTokens * INPUT_MARGIN), maxOutputTokens),
};
const worst = ceiling.main + ceiling.fork + ceiling.isolated;
const predicted = chooseRoute(
	{ promptTokens: isolatedPromptTokens, forkPromptTokens: firstOutputTokens + estimateTokens(turn), outputTokens: maxOutputTokens, forkOutputTokens: forkLimit },
	{ promptTokens: estimateTokens(JSON.stringify(built)) },
	{ main, historian },
);
const plan = { main: mainRef, historian: historianRef, mainPromptTokens: estimateTokens(JSON.stringify(built)), mainOutputLimit: mainLimit, evidenceTokens: estimateTokens(turn), thinking, predicted, worstCase: ceiling };
console.log(JSON.stringify({ plan }, null, 2));
if (!send) {
	console.log(`dry run: nothing sent. Worst case $${worst.toFixed(3)} of $${BUDGET_DOLLARS} for all three requests at their output limits. Add --send to run.`);
	process.exit(0);
}
if (worst > BUDGET_DOLLARS) throw new Error(`worst case $${worst.toFixed(2)} exceeds $${BUDGET_DOLLARS}`);

const sessionId = randomUUID();
const records: RouteRecord[] = [];
const requests = new HistorianRequests({ fork: true, now: Date.now, record: (record) => records.push(record) });
const first = await runtime
	.streamSimple(main, context, {
		...mainOptions,
		sessionId,
		onPayload: (payload) => {
			charge("main", main, payload);
			requests.captures.record(payload, main, Date.now());
			return undefined;
		},
	})
	.result();
if (first.stopReason !== "stop") throw new Error(`main request: ${first.stopReason} ${first.errorMessage ?? ""}`);
requests.captures.confirm(main, promptTokens(first.usage), first);
const host = (label: string, fork: boolean) => ({
	send: (model: Model<Api>, ctx: Context, options: SimpleStreamOptions): Promise<AssistantMessage> =>
		runtime
			.streamSimple(model, ctx, {
				...options,
				maxRetries: 0,
				// After the historian's own hook: the payload priced is the one that leaves.
				onPayload: async (payload, model) => {
					const next = (await options.onPayload?.(payload, model)) ?? payload;
					charge(label, model as Model<Api>, next);
					return next;
				},
			})
			.result(),
	main,
	isolated: [{ route: "primary", model: historian }],
	cacheTtlMs: 300_000,
	sessionId: fork ? sessionId : undefined,
});
const verdict = (answer: { text: string; model?: string }) => {
	const result = validateCompletion(answer as never, shown);
	if (process.argv.includes("--answers")) console.log(answer.model, answer.text);
	return result.ok ? true : result.reason;
};
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
const show = (usage: unknown) => {
	const u = usage as Usage;
	return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: Number(u.cost.total.toFixed(5)) };
};
const forked = await requests.complete(request, host("fork", true));
if (refused) throw new Error(refused);
const forkLine = records.find((record) => record.historianVia === "fork");
if (!forkLine) {
	// The route choice declined the fork and asked the historian model: there is no fork to compare.
	console.log(JSON.stringify({ main: show(first.usage), forkDeclined: records, isolated: { model: forked.model, usage: show(forked.usage), valid: verdict(forked) }, spent }, null, 2));
	process.exit(1);
}
const isolatedRecords: RouteRecord[] = [];
const isolated = await new HistorianRequests({ fork: false, now: Date.now, record: (record) => isolatedRecords.push(record) }).complete(request, host("isolated", false));
if (refused) throw new Error(refused);
const forkCost = (forked.usage as Usage).cost.total;
const isolatedCost = (isolated.usage as Usage).cost.total;
console.log(
	JSON.stringify(
		{
			main: { ...show(first.usage), answer: first.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") },
			fork: { route: records, model: forked.model, usage: show(forked.usage), answerChars: forked.text.length, valid: verdict(forked) },
			isolated: { route: isolatedRecords, model: isolated.model, usage: show(isolated.usage), answerChars: isolated.text.length, valid: verdict(isolated) },
			predicted: { forkCost: forkLine.forkCost, isolatedCost: forkLine.isolatedCost },
			cheaper: forkCost < isolatedCost ? "fork" : "isolated",
			predictionHeld: (forkCost < isolatedCost) === ((forkLine.forkCost ?? Infinity) < (forkLine.isolatedCost ?? 0)),
			spent,
			totalCost: Number(((first.usage as Usage).cost.total + forkCost + isolatedCost).toFixed(4)),
		},
		null,
		2,
	),
);
