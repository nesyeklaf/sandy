import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { resolveConfig } from "../src/core/config.ts";
import { evidenceBudget, HISTORIAN_SYSTEM_PROMPT, historianPrompt, selectEvidence } from "../src/core/historian.ts";
import { promptTokens } from "../src/core/ledger.ts";
import { isServerSide, parseBody } from "../src/pi/captures.ts";
import { forkTurn, HistorianRequests, type HistorianHost, type RouteRecord } from "../src/pi/historian.ts";
import * as zlib from "node:zlib";
import { replayRefusal } from "../src/pi/keep-warm.ts";
import { citingAnswer } from "./support/historian.ts";
import { FakeOpenAI, type FakeFormat, type FakeOpenAIRequest } from "./support/openai-server.ts";
import { piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * The fork on formats other than Anthropic's: pi-ai's real OpenAI Responses, Codex and Chat Completions clients talk to
 * a local stand-in, so the fork is checked on the bytes each format sends, with no format named in the fork's code.
 */

const VERSION = piSdk.VERSION;
const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 1_500, maxOutputTokens: 1_000 },
});

function summaryRequest() {
	const log = sessionLog();
	for (const label of ["a", "b", "c", "d"]) log.turn(label, 8_000);
	const history = log.tape().history();
	const selected = selectEvidence(history, evidenceBudget(config, false));
	assert.ok(selected, "the fixture has no work");
	return {
		system: HISTORIAN_SYSTEM_PROMPT,
		prompt: historianPrompt(selected),
		referencing: (above: Parameters<typeof historianPrompt>[1] & {}) => historianPrompt(selected, above),
		maxTokens: config.historian.maxOutputTokens,
		signal: new AbortController().signal,
		/** The text of the first entry the summary covers whose text is long enough to be named. */
		long: history.entries.find((entry) => selected.spans.some((span) => span.entryId === entry.id && span.probes))?.text,
	};
}

/** A ChatGPT login token as the Codex client reads it: a JWT whose claims name the account. */
const CODEX_KEY = ["e30", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fake" } })).toString("base64url"), "sig"].join(".");

interface Format {
	readonly name: string;
	readonly wire: FakeFormat;
	readonly main: () => Model<Api>;
	/** A pricier model of the same format, so the fork is the cheaper route. */
	readonly historian: () => Model<Api>;
	readonly key: string;
	/** The output limit field the main request carries, none for Codex. */
	readonly limit?: string;
	readonly listKey: "input" | "messages";
	readonly reasons: boolean;
}

const pricey = (model: Model<Api>): Model<Api> => ({ ...model, id: `${model.id}-pricey`, cost: { input: 300, output: 600, cacheRead: 30, cacheWrite: 0 } }) as Model<Api>;

const FORMATS: Format[] = [
	{
		name: "OpenAI Responses",
		wire: "responses",
		main: () => getModel("openai", "gpt-4.1") as Model<Api>,
		historian: () => pricey(getModel("openai", "gpt-4.1") as Model<Api>),
		key: "test-key",
		limit: "max_output_tokens",
		listKey: "input",
		reasons: false,
	},
	{
		name: "Codex",
		wire: "responses",
		main: () => getModel("openai-codex", "gpt-5.6-luna") as Model<Api>,
		historian: () => pricey(getModel("openai-codex", "gpt-5.6-luna") as Model<Api>),
		key: CODEX_KEY,
		listKey: "input",
		reasons: true,
	},
	{
		name: "Chat Completions",
		wire: "completions",
		main: () => getModel("deepseek", "deepseek-flash") as Model<Api>,
		historian: () => pricey(getModel("deepseek", "deepseek-flash") as Model<Api>),
		key: "test-key",
		// DeepSeek's compat sets the older field; OpenAI's own models set `max_completion_tokens`.
		limit: "max_tokens",
		listKey: "messages",
		reasons: false,
	},
];

const tools = [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

function mainContext(held?: string): Context {
	return {
		systemPrompt: "You are the main agent. RULE: answer briefly.",
		tools: tools as never,
		messages: [{ role: "user", content: [{ type: "text", text: (held ? held + "\n\n" : "") + "FACT alpha ".repeat(400) + "Summarize that." }], timestamp: 1 }],
	} as Context;
}

const lastText = (request: FakeOpenAIRequest): string => {
	const list = (request.body.input ?? request.body.messages) as { content: unknown }[];
	return JSON.stringify(list.at(-1)?.content ?? "");
};

for (const format of FORMATS) {
	describe(`the historian's fork on ${format.name}, on pi ${VERSION}`, () => {
		let mainServer: FakeOpenAI;
		let historianServer: FakeOpenAI;
		let main: Model<Api>;
		let historian: Model<Api>;
		let records: RouteRecord[];
		let requests: HistorianRequests;
		const clock = 1_000_000;

		beforeEach(async () => {
			mainServer = await new FakeOpenAI(format.wire).start();
			historianServer = await new FakeOpenAI(format.wire).start();
			main = { ...format.main(), baseUrl: mainServer.baseUrl } as Model<Api>;
			historian = { ...format.historian(), baseUrl: historianServer.baseUrl } as Model<Api>;
			const answer = (request: FakeOpenAIRequest) =>
				lastText(request).includes("transcript")
					? [{ type: "text" as const, text: citingAnswer(JSON.parse(lastText(request)) instanceof Array ? (JSON.parse(lastText(request)) as { text?: string }[]).map((part) => part.text ?? "").join("") : String(JSON.parse(lastText(request)))) }]
					: [
							...(format.reasons ? [{ type: "reasoning" as const, summary: "The user wants a summary.", encrypted: "enc-reply-1" }] : []),
							{ type: "text" as const, text: "Here is what it says: alpha." },
						];
			mainServer.responder = answer;
			historianServer.responder = answer;
			records = [];
			requests = new HistorianRequests({ fork: true, now: () => clock, record: (record) => records.push(record) });
		});

		afterEach(async () => {
			await mainServer.stop();
			await historianServer.stop();
		});

		const send = (model: Model<Api>, context: Context, options: SimpleStreamOptions): Promise<AssistantMessage> =>
			streamSimple(model, context, { ...options, apiKey: format.key }).result();
		const host = (): HistorianHost => ({ send, main, isolated: [{ route: "primary", model: historian }], cacheTtlMs: 300_000, sessionId: "session-1" });

		async function mainTurn(held?: string): Promise<AssistantMessage> {
			let payload: unknown;
			const answer = await streamSimple(main, mainContext(held), {
				apiKey: format.key,
				reasoning: format.reasons ? "low" : undefined,
				sessionId: "session-1",
				transport: "sse",
				onPayload: (built) => {
					payload = structuredClone(built);
					return undefined;
				},
			} as SimpleStreamOptions).result();
			assert.equal(answer.stopReason, "stop", answer.errorMessage);
			requests.captures.record(payload, main, clock);
			requests.captures.confirm(main, promptTokens(answer.usage), answer);
			return answer;
		}

		it("forks with exactly one request: the captured request byte for byte, the main model's answer as pi-ai sends it, then the summary turn", async () => {
			await mainTurn();
			const captured = mainServer.requests[0] as FakeOpenAIRequest;
			const request = summaryRequest();
			const result = await requests.complete(request, host());
			assert.equal(historianServer.requests.length, 0, "the historian model was asked");
			assert.equal(mainServer.requests.length, 2, "not exactly one fork request");
			const fork = mainServer.requests[1] as FakeOpenAIRequest;
			const strip = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== format.listKey && key !== format.limit));
			assert.deepEqual(strip(fork.body), strip(captured.body), "the fork changed the request's head");
			if (format.limit) assert.equal(fork.body[format.limit], (format.reasons ? 2 : 1) * request.maxTokens, "the fork is not sent at its priced output limit");
			else for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) assert.equal(fork.body[field], undefined, `the fork set ${field}, which the capture has not`);
			const before = captured.body[format.listKey] as unknown[];
			const after = fork.body[format.listKey] as unknown[];
			assert.deepEqual(after.slice(0, before.length), before, "the fork changed a captured item");
			const added = after.slice(before.length);
			assert.ok(added.length >= 2, "the fork carries no answer and turn");
			assert.match(JSON.stringify(added.slice(0, -1)), /Here is what it says: alpha\./, "the main model's answer is missing");
			if (format.reasons) assert.match(JSON.stringify(added.slice(0, -1)), /enc-reply-1/, "the answer lost its encrypted reasoning");
			assert.ok(JSON.stringify(added.at(-1)).includes(JSON.stringify(forkTurn(request)).slice(1, -1)), "the last item is not the summary turn");
			assert.ok(!added.some((item) => (item as { role?: string }).role === "system" || (item as { role?: string }).role === "developer"), "the fork resent a settings message");
			assert.ok(fork.cacheRead > 0, "the fork read nothing from the cache");
			assert.equal(records[0]?.historianVia, "fork");
			assert.equal(records[0]?.rejection, undefined);
			assert.equal(records[0]?.cacheRead, fork.cacheRead);
			assert.equal(result.model, `${main.provider}/${main.id}`);
		});

		it("names an entry the captured request holds instead of sending it again", async () => {
			const request = summaryRequest();
			assert.ok(request.long, "the fixture has no long entry");
			await mainTurn(request.long);
			await requests.complete(request, host());
			assert.equal(records[0]?.historianVia, "fork", records[0]?.rejection);
			const fork = mainServer.requests[1] as FakeOpenAIRequest;
			const turn = JSON.stringify((fork.body[format.listKey] as unknown[]).at(-1));
			assert.match(turn, /shown=\\"above\\"/, "the fork's turn names no entry");
			// Unreferenced, a long tool output is shown as its 2,000-character head and tail; named, as 300 characters.
			assert.ok(turn.length < JSON.stringify(forkTurn(request)).length - 1_500, "the fork's turn sent the held entry again");
			assert.ok(!historianServer.requests.length, "the historian model was asked");
		});

		it("counts a fork the cache did not serve as a miss and stops forking for the session", async () => {
			await mainTurn();
			mainServer.forget();
			await requests.complete(summaryRequest(), host());
			assert.equal(records[0]?.historianVia, "fork");
			assert.equal(records[0]?.rejection, "miss");
			await mainTurn();
			await requests.complete(summaryRequest(), host());
			assert.equal(records.at(-1)?.historianVia, "isolated");
		});

		it("declines the fork before sending when a later hook changed the head, and asks the historian model instead", async () => {
			await mainTurn();
			const sentBefore = mainServer.requests.length;
			const changed: HistorianHost = {
				...host(),
				send: (model, context, options) =>
					streamSimple(model, context, {
						...options,
						apiKey: format.key,
						onPayload: async (payload, model) => {
							const next = ((await options.onPayload?.(payload, model)) ?? payload) as Record<string, unknown>;
							return model.baseUrl === main.baseUrl ? { ...next, tools: [] } : next;
						},
					}).result(),
			};
			await requests.complete(summaryRequest(), changed);
			assert.equal(mainServer.requests.length, sentBefore, "a changed fork reached the provider");
			assert.equal(historianServer.requests.length, 1);
			assert.equal(records[0]?.historianVia, "isolated");
			assert.equal(records[0]?.rejection, "head");
		});

		it("records the format's output limit field with the capture, and leaves its cache to the provider: no one-token ping", async () => {
			await mainTurn();
			const capture = requests.captures.latest();
			assert.ok(capture);
			assert.equal(capture.outputLimit, format.limit);
			assert.equal(replayRefusal(capture), "api");
		});
	});
}

describe("reading requests of formats other than Anthropic's", () => {
	const client = { model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], tools: [{ type: "function", name: "read", parameters: {} }] };

	it("takes Responses requests of client tools, messages, reasoning and tool results as running nothing on the provider", () => {
		const input = [
			...client.input,
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
			{ type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "FACT" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
		];
		assert.equal(isServerSide({ ...client, input }), false);
	});

	const provider: [string, Record<string, unknown>][] = [
		["a provider tool", { ...client, tools: [...client.tools, { type: "web_search" }] }],
		["a provider tool call in the history", { ...client, input: [...client.input, { type: "web_search_call", id: "ws_1", status: "completed" }] }],
		["a tool search the provider ran", { ...client, input: [...client.input, { type: "tool_search_call", execution: "server" }] }],
		["an unknown content block", { ...client, input: [{ role: "user", content: [{ type: "input_audio" }] }] }],
	];
	for (const [name, payload] of provider) it(`takes a Responses request with ${name} as running work on the provider`, () => assert.equal(isServerSide(payload), true));

	it("reads a request body as pi-ai hands it to fetch: text, bytes, or zstd bytes as the Codex client sends", () => {
		const json = JSON.stringify(client);
		assert.deepEqual(parseBody(json), client);
		assert.deepEqual(parseBody(new TextEncoder().encode(json)), client);
		const zstd = (zlib as unknown as { zstdCompressSync?: (input: string) => Buffer }).zstdCompressSync;
		if (zstd) assert.deepEqual(parseBody(new Uint8Array(zstd(json))), client);
		assert.equal(parseBody(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2])), undefined);
	});
});
