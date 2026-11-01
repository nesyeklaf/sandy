import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, it } from "vitest";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolResultMessage } from "@earendil-works/pi-ai";
import { accountingEvents, reduceAccounting } from "../src/core/accounting.ts";
import { resolveConfig } from "../src/core/config.ts";
import { stableStringify } from "../src/core/continuity.ts";
import {
	evidenceBudget,
	HISTORIAN_SYSTEM_PROMPT,
	type HistorianWork,
	historianPrompt,
	selectEvidence,
	validateCompletion,
} from "../src/core/historian.ts";
import { promptTokens } from "../src/core/ledger.ts";
import { estimateTokens } from "../src/core/tokens.ts";
import { CAPTURE_BYTES, CAPTURE_LIMIT, CapturePool } from "../src/pi/captures.ts";
import {
	chooseRoute,
	FORK_FRAME,
	forkTurn,
	HistorianRequests,
	type HistorianHost,
	type RouteRecord,
} from "../src/pi/historian.ts";
import { type FakeBlock, FakeAnthropic, type FakeRequest } from "./support/anthropic-server.ts";
import type { ContextConfigInput } from "../src/core/config.ts";
import { CUT_REQUEST_CHANNEL, SUMMARY_KIND } from "../src/core/kinds.ts";
import { createContextExtension } from "../src/pi/extension.ts";
import { attemptRecords, citingAnswer, harness } from "./support/historian.ts";
import type { AttemptEntry } from "../src/core/attempts.ts";
import { piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * The historian's fork on the main model's warm cache. pi-ai's real Anthropic client talks to a local stand-in that
 * models the prompt cache, so every test sees the bytes a request carries and what the cache would have read.
 */

const VERSION = piSdk.VERSION;
const KEY = "test-key";

const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 1_500, maxOutputTokens: 1_000 },
});

/** A real piece of work: a session whose second result is larger than one stretch, so it is shown in spans. */
function work(): HistorianWork {
	const log = sessionLog();
	for (const label of ["a", "b", "c", "d"]) log.turn(label, 8_000);
	const selected = selectEvidence(log.tape().history(), evidenceBudget(config, false));
	assert.ok(selected, "the fixture has no work");
	return selected;
}

const tools = [
	{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "bash", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

/** A main conversation with tools, signed thinking and a tool call and its result, as pi would send it. */
function mainContext(model: Model<Api>): Context {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return {
		systemPrompt: "You are the main agent. RULE: answer briefly.",
		tools: tools as never,
		messages: [
			{ role: "user", content: [{ type: "text", text: "Read a.txt please." }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I should read it.", thinkingSignature: "sig-main-1" },
					{ type: "toolCall", id: "toolu_main_1", name: "read", arguments: { path: "a.txt" } },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "toolu_main_1", toolName: "read", content: [{ type: "text", text: "FACT alpha ".repeat(400) }], isError: false, timestamp: 3 },
			{ role: "user", content: [{ type: "text", text: "Now summarize what you read." }], timestamp: 4 },
		],
	} as Context;
}

type Mutation = (payload: Record<string, unknown>) => Record<string, unknown>;

interface Rig {
	readonly main: Model<Api>;
	readonly historian: Model<Api>;
	readonly mainServer: FakeAnthropic;
	readonly historianServer: FakeAnthropic;
	readonly records: RouteRecord[];
	readonly requests: HistorianRequests;
	/** Payloads handed on by pi-ai after our payload hook, before they reach the client: a later hook's change. */
	mutate?: Mutation;
	host(overrides?: Partial<HistorianHost>): HistorianHost;
	/**
	 * Sends one main request as pi would and records it as pi's `before_provider_request` hook would see it, and its
	 * answer as pi's `message_end` would. Returns the answer.
	 */
	mainTurn(seen?: Mutation): Promise<AssistantMessage>;
}

let rig: Rig;
let clock = 1_000_000;

beforeEach(async () => {
	const mainServer = await new FakeAnthropic().start();
	const historianServer = await new FakeAnthropic().start();
	const main = { ...getModel("anthropic", "claude-sonnet-5-5"), baseUrl: mainServer.baseUrl } as Model<Api>;
	const historian = { ...getModel("anthropic", "claude-fable-5"), baseUrl: historianServer.baseUrl } as Model<Api>;
	mainServer.responder = (request) => [{ type: "text", text: citingAnswer(lastText(request)) }];
	historianServer.responder = (request) => [{ type: "text", text: citingAnswer(lastText(request)) }];
	const records: RouteRecord[] = [];
	const requests = new HistorianRequests({ fork: true, now: () => clock, record: (record) => records.push(record) });
	const send = (model: Model<Api>, context: Context, options: SimpleStreamOptions): Promise<AssistantMessage> =>
		streamSimple(model, context, {
			...options,
			apiKey: KEY,
			onPayload: async (payload, model) => {
				const next = (await options.onPayload?.(payload, model)) ?? payload;
				return rig.mutate && model.baseUrl === main.baseUrl ? rig.mutate(structuredClone(next) as Record<string, unknown>) : next;
			},
		}).result();
	rig = {
		main,
		historian,
		mainServer,
		historianServer,
		records,
		requests,
		host: (overrides = {}) => ({ send, main, isolated: [{ route: "primary", model: historian }], cacheTtlMs: 300_000, sessionId: "session-1", ...overrides }),
		mainTurn: async (seen) => {
			let payload: unknown;
			const answer = await streamSimple(main, mainContext(main), {
				apiKey: KEY,
				reasoning: "low",
				sessionId: "session-1",
				onPayload: (built) => {
					payload = structuredClone(built);
					return undefined;
				},
			}).result();
			assert.ok(answer.stopReason === "stop" || answer.stopReason === "toolUse", answer.errorMessage);
			requests.captures.record(seen ? seen(structuredClone(payload) as Record<string, unknown>) : payload, main, clock);
			requests.captures.confirm(main, promptTokens(answer.usage), answer);
			return answer;
		},
	};
});

/**
 * The messages pi-ai would send the main model next, after the answer and its tool results, without sending them:
 * the reference a fork's exchange must equal. Effort markers and cache markers are left out.
 */
async function nextMainMessages(model: Model<Api>, answer: AssistantMessage, results: ToolResultMessage[] = []): Promise<unknown[]> {
	const context = mainContext(model);
	let payload: Record<string, unknown> | undefined;
	await streamSimple(model, { ...context, messages: [...context.messages, answer, ...results] }, {
		apiKey: KEY,
		reasoning: "low",
		sessionId: "session-1",
		onPayload: (built) => {
			payload = structuredClone(built) as Record<string, unknown>;
			throw new Error("not sent");
		},
	}).result();
	assert.ok(payload, "pi-ai built no request");
	return JSON.parse(JSON.stringify(messagesOf(payload).filter((message) => message.role !== "system")), (key, value) => (key === "cache_control" ? undefined : value));
}

/** A tool result for the fixture's answers, as pi's agent loop hands it on. */
const readResult = (toolCallId: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text: "FACT beta ".repeat(200) }],
	isError: false,
	timestamp: 5,
});

afterEach(async () => {
	await rig.mainServer.stop();
	await rig.historianServer.stop();
});

function lastText(request: FakeRequest): string {
	const messages = request.body.messages as { content: string | { type: string; text?: string }[] }[];
	const content = messages.at(-1)?.content;
	return typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("\n");
}

function summaryRequest(selected = work()) {
	return { system: HISTORIAN_SYSTEM_PROMPT, prompt: historianPrompt(selected), maxTokens: config.historian.maxOutputTokens, signal: new AbortController().signal };
}

const messagesOf = (payload: Record<string, unknown>) => payload.messages as Record<string, unknown>[];
/** A tool declared inside the conversation, as pi-ai sends a tool change on a model with native tool changes. */
const inlineTool = (definition: Record<string, unknown>) => ({ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition } }] });

describe(`the historian's fork on the main model's warm cache, on pi ${VERSION}`, () => {
	const matrix: [string, Mutation, string][] = [
		["tools reordered", (p) => ({ ...p, tools: [...(p.tools as unknown[])].reverse() }), "head"],
		["a tool's description changed", (p) => ({ ...p, tools: (p.tools as Record<string, unknown>[]).map((t, i) => (i === 0 ? { ...t, description: "Read." } : t)) }), "head"],
		["system instructions changed", (p) => ({ ...p, system: [{ type: "text", text: "You are a summarizer." }] }), "head"],
		["the model changed", (p) => ({ ...p, model: "claude-fable-5" }), "head"],
		["thinking settings changed", (p) => ({ ...p, thinking: { type: "disabled" } }), "head"],
		["tool choice changed", (p) => ({ ...p, tool_choice: { type: "none" } }), "head"],
		[
			"a tool call ID changed",
			(p) => ({ ...p, messages: JSON.parse(JSON.stringify(p.messages).replaceAll("toolu_main_1", "toolu_other")) }),
			"prefix",
		],
		[
			"a thinking signature changed",
			(p) => ({ ...p, messages: JSON.parse(JSON.stringify(p.messages).replace("sig-main-1", "sig-forged")) }),
			"prefix",
		],
		["a captured message dropped", (p) => ({ ...p, messages: messagesOf(p).slice(1) }), "prefix"],
		[
			"the evidence edited",
			(p) => ({ ...p, messages: JSON.parse(JSON.stringify(p.messages).replace("<existing-summary>", "<summary>")) }),
			"turn",
		],
		[
			"a second turn appended",
			(p) => ({ ...p, messages: [...messagesOf(p), { role: "user", content: [{ type: "text", text: "and more" }] }] }),
			"turn",
		],
	];

	for (const [name, mutation, reason] of matrix) {
		it(`refuses a fork whose request has ${name} before sending it, and asks the historian model instead`, async () => {
			await rig.mainTurn();
			const sentBefore = rig.mainServer.requests.length;
			rig.mutate = mutation;
			const result = await rig.requests.complete(summaryRequest(), rig.host());
			assert.equal(rig.mainServer.requests.length, sentBefore, "a fork request reached the provider");
			assert.equal(rig.historianServer.requests.length, 1);
			assert.equal(result.model, "anthropic/claude-fable-5");
			assert.equal(rig.records.length, 1, "not one ledger line for the one request sent");
			const [line] = rig.records;
			assert.equal(line?.historianVia, "isolated");
			assert.equal(line?.route, "primary");
			assert.equal(line?.status, "answered");
			assert.equal(line?.rejection, reason);
			assert.ok(line?.forkCost !== undefined && line.isolatedCost !== undefined, "the declined fork's prediction is missing");
		});
	}

	it("never forks onto another route of a same-name model, whose cache is another one", async () => {
		await rig.mainTurn();
		const elsewhere = { ...rig.main, baseUrl: "http://127.0.0.1:9" } as Model<Api>;
		await rig.requests.complete(summaryRequest(), rig.host({ main: elsewhere }));
		assert.equal(rig.mainServer.requests.length, 1);
		assert.equal(rig.records[0]?.rejection, "route");
	});

	it("forks with exactly one request: the captured prefix byte for byte, the main model's own answer, then the framed evidence once", async () => {
		rig.mainServer.responder = (request) =>
			lastText(request).includes("<transcript>")
				? [{ type: "text", text: citingAnswer(lastText(request)) }]
				: [
						{ type: "thinking", thinking: "The user wants a summary.", signature: "sig-reply-1" },
						{ type: "text", text: "Here is what a.txt says: alpha." },
					];
		const answer = await rig.mainTurn();
		const captured = rig.mainServer.requests[0] as FakeRequest;
		const request = summaryRequest();
		const result = await rig.requests.complete(request, rig.host());
		assert.equal(rig.mainServer.requests.length, 2, "not exactly one fork request");
		assert.equal(rig.historianServer.requests.length, 0);
		const fork = rig.mainServer.requests[1] as FakeRequest;
		const { messages: capturedMessages, max_tokens: capturedLimit, ...capturedHead } = captured.body;
		const { messages: forkMessages, max_tokens: forkLimit, ...forkHead } = fork.body;
		assert.deepEqual(forkHead, capturedHead, "the fork changed the request's head");
		assert.ok(capturedLimit !== request.maxTokens, "the fixture cannot tell the output limits apart");
		assert.equal(forkLimit, request.maxTokens, "the fork is not sent at the output limit it was priced at");
		assert.equal(rig.records[0]?.maxTokens, request.maxTokens);
		const prefix = JSON.stringify(capturedMessages).slice(0, -1);
		assert.ok(JSON.stringify(forkMessages).startsWith(prefix), "the fork changed a captured message");
		const captures = (capturedMessages as unknown[]).length;
		const next = await nextMainMessages(rig.main, answer);
		const reply = next.slice(next.length - 1);
		assert.equal((reply[0] as { role: string }).role, "assistant");
		assert.match(JSON.stringify(reply), /sig-reply-1/, "the reference lost the answer's signed thinking");
		assert.deepEqual((forkMessages as unknown[]).slice(captures, -1), reply, "the fork does not carry the main model's answer as pi-ai sends it");
		assert.equal((forkMessages as unknown[]).length, captures + 2);
		assert.deepEqual((forkMessages as unknown[]).at(-1), { role: "user", content: [{ type: "text", text: forkTurn(request) }] });
		assert.ok(forkTurn(request).startsWith(FORK_FRAME), "the summary turn is not framed as a separate task");
		assert.ok(!JSON.stringify((forkMessages as unknown[]).slice(captures)).includes("cache_control"), "the fork marks new content for the cache");
		const priced = chooseRoute(
			{
				promptTokens: estimateTokens(`${request.system}\n\n${request.prompt}`),
				forkPromptTokens: answer.usage.output + estimateTokens(forkTurn(request)),
				outputTokens: request.maxTokens,
			},
			{ promptTokens: rig.records[0]?.predictedCacheRead },
			{ main: rig.main, historian: rig.historian },
		);
		assert.equal(rig.records[0]?.forkCost, priced.forkCost, "the answer the fork carries is not priced as fresh input");
		assert.ok(fork.cacheRead > 0 && fork.cacheRead >= captured.cacheRead + 0, "the fork read nothing from the cache");
		assert.equal(result.model, "anthropic/claude-sonnet-5-5");
		assert.equal(rig.records[0]?.historianVia, "fork");
		assert.equal(rig.records[0]?.rejection, undefined);
		assert.equal(rig.records[0]?.cacheRead, fork.cacheRead);
	});

	it("declines the fork before sending while the main model's answer to the capture has not arrived", async () => {
		await rig.mainTurn();
		const pending = new HistorianRequests({ fork: true, now: () => clock, record: (record) => rig.records.push(record) });
		pending.captures.record(JSON.parse(rig.mainServer.requests[0]?.raw as string), rig.main, clock);
		pending.captures.confirm(rig.main, 1_000);
		await pending.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 1, "a fork without the main model's answer was sent");
		assert.equal(rig.records[0]?.historianVia, "isolated");
		assert.equal(rig.records[0]?.rejection, "exchange");
	});

	it("declines the fork before sending when the main model's answer was cut off at its output limit", async () => {
		rig.mainServer.ending = (request) => (lastText(request).includes("<transcript>") ? "complete" : "length");
		const pending = new HistorianRequests({ fork: true, now: () => clock, record: (record) => rig.records.push(record) });
		const answer = await streamSimple(rig.main, mainContext(rig.main), {
			apiKey: KEY,
			reasoning: "low",
			sessionId: "session-1",
			onPayload: (built) => {
				pending.captures.record(structuredClone(built), rig.main, clock);
				return undefined;
			},
		}).result();
		assert.equal(answer.stopReason, "length");
		pending.captures.confirm(rig.main, promptTokens(answer.usage), answer);
		await pending.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 1, "a fork after a cut-off answer was sent");
		assert.equal(rig.records[0]?.rejection, "exchange");
	});

	it("forks after an answer that called tools only once their results arrived, and carries those results as pi-ai sends them", async () => {
		rig.mainServer.responder = (request) =>
			lastText(request).includes("<transcript>")
				? [{ type: "text", text: citingAnswer(lastText(request)) }]
				: [
						{ type: "tool_use", id: "toolu_reply_1", name: "read", input: { path: "b.txt" } },
						{ type: "tool_use", id: "toolu_reply_2", name: "read", input: { path: "c.txt" } },
					];
		const answer = await rig.mainTurn();
		assert.equal(answer.stopReason, "toolUse");
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 1, "a fork without the tool results was sent");
		assert.equal(rig.records[0]?.rejection, "exchange");
		// Results arrive in the order the tools finish; the fork keeps the order of the calls, as pi-ai does.
		const results = [readResult("toolu_reply_2"), readResult("toolu_reply_1")];
		for (const result of results) rig.requests.captures.result(result);
		rig.requests.captures.result(readResult("toolu_unrelated"));
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 2, "the fork was not sent once the exchange was finished");
		const captured = messagesOf((rig.mainServer.requests[0] as FakeRequest).body).length;
		const forkMessages = messagesOf((rig.mainServer.requests[1] as FakeRequest).body);
		const next = await nextMainMessages(rig.main, answer, [readResult("toolu_reply_1"), readResult("toolu_reply_2")]);
		assert.deepEqual(forkMessages.slice(captured, -1), next.slice(-2), "the fork does not carry the answer and its results as pi-ai sends them");
		assert.equal(rig.records[1]?.historianVia, "fork");
	});

	const exchangeEdits: [string, Mutation, string][] = [
		[
			"rewrites the main model's answer",
			(p) => ({ ...p, messages: messagesOf(p).map((m, i, all) => (i === all.length - 2 ? { role: "assistant", content: [{ type: "text", text: "Forged answer." }] } : m)) }),
			"reply",
		],
		["drops the main model's answer", (p) => ({ ...p, messages: messagesOf(p).filter((_, i, all) => i !== all.length - 2) }), "reply"],
		[
			"adds an assistant turn of its own",
			(p) => ({ ...p, messages: [...messagesOf(p).slice(0, -1), { role: "assistant", content: [{ type: "text", text: "Sure." }] }, ...messagesOf(p).slice(-1)] }),
			"turn",
		],
	];
	for (const [name, edit, rejection] of exchangeEdits) {
		it(`declines the fork before sending when a later hook ${name}`, async () => {
			await rig.mainTurn();
			rig.mutate = edit;
			await rig.requests.complete(summaryRequest(), rig.host());
			assert.equal(rig.mainServer.requests.length, 1, "a fork with a changed exchange was sent");
			assert.equal(rig.historianServer.requests.length, 1);
			assert.equal(rig.records[0]?.rejection, rejection);
		});
	}

	/**
	 * One main request as pi's hook chain runs it: our hook records the very object pi hands it, then a later handler
	 * either changes that object in place, returns a replacement, or leaves it, and pi-ai sends what the chain returns.
	 */
	async function handedMainTurn(later: (payload: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<void> {
		const answer = await streamSimple(rig.main, mainContext(rig.main), {
			apiKey: KEY,
			reasoning: "low",
			sessionId: "session-1",
			onPayload: (built) => {
				rig.requests.captures.record(built, rig.main, clock);
				return later(built as Record<string, unknown>);
			},
		}).result();
		assert.ok(answer.stopReason === "stop" || answer.stopReason === "toolUse", answer.errorMessage);
		rig.requests.captures.confirm(rig.main, promptTokens(answer.usage), answer);
	}

	it("declines the fork before sending when a later handler changed the captured request in place, and asks the historian model instead", async () => {
		await handedMainTurn((payload) => {
			payload.system = [{ type: "text", text: "You are a different assistant." }];
			return undefined;
		});
		assert.match(rig.mainServer.requests[0]?.raw ?? "", /a different assistant/, "the later handler's change was not sent");
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 1, "a fork of a request that was not sent reached the provider");
		assert.equal(rig.historianServer.requests.length, 1);
		assert.deepEqual(rig.records[0] && [rig.records[0].historianVia, rig.records[0].rejection], ["isolated", "changed"]);
		const capture = rig.requests.captures.latest();
		assert.ok(capture && !rig.requests.captures.unchanged(capture), "the pool reports the changed capture unchanged");
	});

	it("forks a capture whose handed object no later handler touched: pi-ai and the client leave it as it was sent", async () => {
		await handedMainTurn(() => undefined);
		const capture = rig.requests.captures.latest();
		assert.ok(capture && rig.requests.captures.unchanged(capture), "sending the request changed the captured object");
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.records[0]?.historianVia, "fork");
	});

	it("cannot see a later handler that returns a replacement request: the capture reads unchanged and the fork goes", async () => {
		await handedMainTurn((payload) => ({ ...payload, system: [{ type: "text", text: "You are a different assistant." }] }));
		assert.match(rig.mainServer.requests[0]?.raw ?? "", /a different assistant/, "the replacement was not sent");
		const capture = rig.requests.captures.latest();
		assert.ok(capture && rig.requests.captures.unchanged(capture));
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.records[0]?.historianVia, "fork", "the documented limit changed: update README and this test");
	});

	it("declines the fork before sending when the capture, the answer, the summary turn and the output limit pass the main model's context", async () => {
		const answer = await rig.mainTurn();
		const request = summaryRequest();
		const needed = promptTokens(answer.usage) + answer.usage.output + estimateTokens(forkTurn(request)) + request.maxTokens;
		await rig.requests.complete(request, rig.host({ main: { ...rig.main, contextWindow: needed - 1 } }));
		assert.equal(rig.mainServer.requests.length, 1, "a fork past the main model's context was sent");
		assert.equal(rig.records[0]?.rejection, "context");
		await rig.requests.complete(request, rig.host({ main: { ...rig.main, contextWindow: needed } }));
		assert.equal(rig.records[1]?.historianVia, "fork");
	});

	it("validates a fork's answer about an entry shown in spans, which our cut removes from the main context", async () => {
		const selected = work();
		assert.ok(selected.spans.some((span) => span.from > 0 || span.to < span.total), "no entry was split into spans");
		await rig.mainTurn();
		const result = await rig.requests.complete(summaryRequest(selected), rig.host());
		assert.equal(rig.records[0]?.historianVia, "fork");
		const verdict = validateCompletion(result, selected);
		assert.equal(verdict.ok, true, JSON.stringify(verdict));
	});

	it("counts a fork the cache did not serve as a miss and stops forking for the session", async () => {
		// A later `before_provider_request` handler replaced what we saw: the cache holds a request we never captured.
		await rig.mainTurn((payload) => ({ ...payload, system: [{ type: "text", text: "what an earlier handler saw" }] }));
		rig.mutate = undefined;
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 2, "the fork was not sent");
		assert.equal(rig.records[0]?.historianVia, "fork");
		assert.equal(rig.records[0]?.rejection, "miss");
		assert.equal(rig.requests.forkDisabled, true);
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 2);
		assert.equal(rig.records[1]?.rejection, "disabled");
	});

	it("hands a fork's tool call back unexecuted, for validation to reject as a paid attempt, and stops forking", async () => {
		await rig.mainTurn();
		rig.mainServer.responder = (request) => [
			{ type: "text", text: citingAnswer(lastText(request)) },
			{ type: "tool_use", id: "toolu_fork", name: "bash", input: { command: "rm -rf /" } },
		];
		const result = await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(result.toolCalls, 1);
		assert.equal(rig.historianServer.requests.length, 0, "the tool call was resent to the historian model");
		const verdict = validateCompletion(result, work());
		assert.equal(verdict.ok, false);
		assert.equal(!verdict.ok && verdict.reason, "tool-call");
		assert.equal(rig.records[0]?.rejection, "tool-call");
		assert.equal(rig.requests.forkDisabled, true);
	});

	it("lets a fork that failed after it was sent fail its attempt, without resending it anywhere", async () => {
		await rig.mainTurn();
		rig.mainServer.responder = () => {
			throw new Error("overloaded");
		};
		await assert.rejects(rig.requests.complete(summaryRequest(), rig.host()));
		assert.equal(rig.mainServer.requests.length, 2, "the fork was not sent exactly once");
		assert.equal(rig.historianServer.requests.length, 0, "a sent fork fell back to another request");
	});

	const failures: [string, (server: FakeAnthropic, abort: AbortController) => void, RouteRecord["status"]][] = [
		["a transport error", (server) => (server.responder = () => { throw new Error("overloaded"); }), "failed"],
		["a stream that breaks off", (server) => (server.ending = () => "partial"), "failed"],
		["an error event in the stream", (server) => (server.ending = () => "error"), "failed"],
		["a stop at the output limit", (server) => (server.ending = () => "length"), "failed"],
		[
			"an abort while it streams",
			(server, abort) => {
				const answer = server.responder;
				server.responder = (request, index) => {
					abort.abort(new Error("the run ended"));
					return answer(request, index);
				};
			},
			"aborted",
		],
	];
	for (const [name, fail, status] of failures) {
		it(`fails a fork that ends in ${name} after it was sent, labels it a fork, and resends it nowhere`, async () => {
			await rig.mainTurn();
			const abort = new AbortController();
			fail(rig.mainServer, abort);
			await assert.rejects(rig.requests.complete({ ...summaryRequest(), signal: abort.signal }, rig.host()));
			assert.equal(rig.mainServer.requests.length, 2, "the fork was not sent exactly once");
			assert.equal(rig.historianServer.requests.length, 0, "a sent fork fell back to another request");
			assert.deepEqual(rig.records.map((line) => [line.historianVia, line.route, line.status]), [["fork", "fork", status]]);
		});
	}

	it("counts a fork that missed the cache and stopped at the output limit as a miss, and stops forking", async () => {
		await rig.mainTurn((payload) => ({ ...payload, system: [{ type: "text", text: "what an earlier handler saw" }] }));
		rig.mutate = undefined;
		rig.mainServer.ending = () => "length";
		await assert.rejects(rig.requests.complete(summaryRequest(), rig.host()), /output limit/);
		assert.deepEqual(rig.records[0] && [rig.records[0].historianVia, rig.records[0].status, rig.records[0].rejection], ["fork", "failed", "miss"]);
		assert.equal(rig.requests.forkDisabled, true);
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.mainServer.requests.length, 2, "a second fork was sent after a miss");
		assert.equal(rig.records[1]?.rejection, "disabled");
	});

	it("keeps forking after a fork that the cache served stopped at the output limit", async () => {
		await rig.mainTurn();
		rig.mainServer.ending = () => "length";
		await assert.rejects(rig.requests.complete(summaryRequest(), rig.host()), /output limit/);
		assert.equal(rig.records[0]?.rejection, undefined);
		assert.equal(rig.requests.forkDisabled, false);
	});

	it("keeps forking after a fork that failed before any usage came back", async () => {
		await rig.mainTurn();
		rig.mainServer.responder = () => {
			throw new Error("overloaded");
		};
		await assert.rejects(rig.requests.complete(summaryRequest(), rig.host()));
		assert.equal(rig.records[0]?.status, "failed");
		assert.equal(rig.requests.forkDisabled, false, "a fork that never reached the model turned the fork off");
	});

	it("refuses a second request from the fork's client, which only a resend would make", async () => {
		await rig.mainTurn();
		let resent: unknown = "not refused";
		const host = rig.host();
		const send: HistorianHost["send"] = async (model, context, options) => {
			const answer = await host.send(model, context, options);
			const guard = (options as { fetch?: typeof fetch }).fetch;
			await guard?.(rig.mainServer.baseUrl + "/v1/messages", { method: "POST", body: "{}" }).catch((error: unknown) => {
				resent = error;
			});
			return answer;
		};
		await rig.requests.complete(summaryRequest(), { ...host, send });
		assert.equal(rig.mainServer.requests.length, 2, "the resend reached the provider");
		assert.match(String(resent), /refused to resend/);
	});

	it("does not fork without a switch, a warm capture, or a known price", async () => {
		await rig.mainTurn();
		const off = new HistorianRequests({ fork: false, now: () => clock, record: (record) => rig.records.push(record) });
		await off.complete(summaryRequest(), rig.host());
		const cold = new HistorianRequests({ fork: true, now: () => clock + 300_000, record: (record) => rig.records.push(record) });
		cold.captures.record(JSON.parse(rig.mainServer.requests[0]?.raw as string), rig.main, clock);
		cold.captures.confirm(rig.main, 1_000);
		await cold.complete(summaryRequest(), rig.host());
		const free = { ...rig.main, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
		await rig.requests.complete(summaryRequest(), rig.host({ main: free }));
		assert.deepEqual(
			rig.records.map((record) => record.rejection),
			["off", "expired", "unpriced"],
		);
		assert.equal(rig.mainServer.requests.length, 1);
		assert.equal(rig.historianServer.requests.length, 3);
	});

	describe("a main model with a fixed thinking budget", () => {
		const budgeted = () => ({ ...getModel("anthropic", "claude-haiku-4-5"), baseUrl: rig.mainServer.baseUrl }) as Model<Api>;
		const budgetedTurn = async (main: Model<Api>) => {
			const answer = await streamSimple(main, mainContext(main), {
				apiKey: KEY,
				reasoning: "low",
				sessionId: "session-1",
				onPayload: (built) => {
					rig.requests.captures.record(structuredClone(built), main, clock);
					return undefined;
				},
			}).result();
			assert.equal(answer.stopReason, "stop", answer.errorMessage);
			rig.requests.captures.confirm(main, promptTokens(answer.usage), answer);
			const thinking = (rig.mainServer.requests.at(-1) as FakeRequest).body.thinking as { type: string; budget_tokens: number };
			assert.equal(thinking.type, "enabled", "the fixture's main request has no fixed thinking budget");
			return { thinking, answer };
		};

		it("forks with the thinking settings unchanged and an output limit of the thinking budget plus the summary's, priced at that", async () => {
			const main = budgeted();
			const { thinking, answer } = await budgetedTurn(main);
			const request = summaryRequest();
			await rig.requests.complete(request, rig.host({ main }));
			assert.equal(rig.mainServer.requests.length, 2, "the fork was not sent");
			const fork = rig.mainServer.requests[1] as FakeRequest;
			assert.deepEqual(fork.body.thinking, thinking, "the fork changed the thinking settings");
			assert.equal(fork.body.max_tokens, thinking.budget_tokens + request.maxTokens);
			const line = rig.records[0];
			assert.equal(line?.maxTokens, thinking.budget_tokens + request.maxTokens);
			const priced = chooseRoute(
				{
					promptTokens: estimateTokens(`${request.system}\n\n${request.prompt}`),
					forkPromptTokens: answer.usage.output + estimateTokens(forkTurn(request)),
					outputTokens: request.maxTokens,
					forkOutputTokens: thinking.budget_tokens + request.maxTokens,
				},
				{ promptTokens: line?.predictedCacheRead },
				{ main, historian: rig.historian },
			);
			assert.equal(line?.forkCost, priced.forkCost, "the fork was not priced at the output limit it was sent with");
		});

		it("declines the fork before sending when the thinking budget and the summary pass the main model's output limit", async () => {
			const main = budgeted();
			const { thinking } = await budgetedTurn(main);
			const request = { ...summaryRequest(), maxTokens: main.maxTokens - thinking.budget_tokens + 1 };
			await rig.requests.complete(request, rig.host({ main }));
			assert.equal(rig.mainServer.requests.length, 1, "a fork over the output limit was sent");
			assert.equal(rig.historianServer.requests.length, 1);
			assert.equal(rig.records[0]?.rejection, "budget");
		});
	});

	const serverSide: [string, Mutation][] = [
		["a web search tool", (p) => ({ ...p, tools: [...(p.tools as unknown[]), { type: "web_search_20250305", name: "web_search", max_uses: 1 }] })],
		["a code execution tool", (p) => ({ ...p, tools: [...(p.tools as unknown[]), { type: "code_execution_20250825", name: "code_execution" }] })],
		["a server-side text editor tool", (p) => ({ ...p, tools: [...(p.tools as unknown[]), { type: "text_editor_20250728", name: "str_replace_based_edit_tool" }] })],
		["MCP servers", (p) => ({ ...p, mcp_servers: [{ type: "url", url: "https://mcp.example", name: "example" }] })],
		["a container", (p) => ({ ...p, container: "container_1" })],
		["a web search tool declared inline in a message", (p) => ({ ...p, messages: [...messagesOf(p), inlineTool({ type: "web_search_20250305", name: "web_search", max_uses: 1 })] })],
		[
			"a tool declared inline in a form it does not know",
			(p) => ({ ...p, messages: [...messagesOf(p), { role: "user", content: [{ type: "tool_addition", tool: { type: "tool_search_result", name: "web_search" } }] }] }),
		],
		[
			"a provider's own tool call in a message",
			(p) => ({ ...p, messages: [...messagesOf(p), { role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } }] }] }),
		],
	];
	for (const [name, seen] of serverSide) {
		it(`never forks a capture that has the provider run ${name}, and asks the historian model instead`, async () => {
			await rig.mainTurn(seen);
			await rig.requests.complete(summaryRequest(), rig.host());
			assert.equal(rig.mainServer.requests.length, 1, "a fork with server-side work was sent");
			assert.equal(rig.historianServer.requests.length, 1);
			assert.equal(rig.records[0]?.rejection, "server-tools");
		});
	}

	it("forks a capture that declares a client tool inline in a message", async () => {
		await rig.mainTurn((p) => ({ ...p, messages: [...messagesOf(p), inlineTool({ name: "grep", description: "Search.", input_schema: { type: "object", properties: {} } })] }));
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.records[0]?.historianVia, "fork");
	});

	it("forks a capture whose tools are all client tools, typed custom or untyped", async () => {
		await rig.mainTurn((p) => ({ ...p, tools: (p.tools as Record<string, unknown>[]).map((tool, index) => (index === 0 ? { ...tool, type: "custom" } : tool)) }));
		rig.mutate = (p) => ({ ...p, tools: (p.tools as Record<string, unknown>[]).map((tool, index) => (index === 0 ? { ...tool, type: "custom" } : tool)) });
		await rig.requests.complete(summaryRequest(), rig.host());
		assert.equal(rig.records[0]?.historianVia, "fork");
	});
});

describe(`receipts and ledger lines of the fork and the isolated route, on pi ${VERSION}`, () => {
	/** The historian's runner over a real session, asking pi's routes: the fork, then the historian model. */
	function runner(options: { readonly isolated?: HistorianHost["isolated"]; readonly config?: typeof config } = {}) {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d"]) log.turn(label, 8_000);
		const host = rig.host(options.isolated ? { isolated: options.isolated } : {});
		const run = harness(log, options.config ?? config, { routes: () => rig.requests.routes(host), now: () => clock });
		const starts = () => attemptRecords(log).filter((record) => record.type === "start") as Extract<AttemptEntry, { type: "start" }>[];
		const ends = () => attemptRecords(log).filter((record) => record.type === "end") as Extract<AttemptEntry, { type: "end" }>[];
		/** Each request on the wire, and how many receipts were stored when it arrived. */
		const wire: { server: string; receipts: number }[] = [];
		for (const [name, server] of [["main", rig.mainServer], ["historian", rig.historianServer]] as const) {
			const answer = server.responder;
			server.responder = (request, index) => {
				wire.push({ server: name, receipts: starts().length });
				return answer(request, index);
			};
		}
		/** Every request on the wire found its own receipt stored: the n-th arrived with n receipts. */
		const receiptFirst = () => {
			assert.ok(wire.length > 0, "nothing was sent");
			assert.deepEqual(wire.map((sent) => sent.receipts), wire.map((_, index) => index + 1), "a request was sent without its receipt stored first");
			assert.equal(starts().length, wire.length, "a receipt without a request");
		};
		return { log, run, starts, ends, wire, receiptFirst };
	}

	it("stores one fork receipt before the fork is sent, and one ledger line for it", async () => {
		await rig.mainTurn();
		const { run, starts, ends, wire, receiptFirst } = runner();
		await run.run();
		receiptFirst();
		assert.ok(wire.every((sent) => sent.server === "main"), "a summary was not forked");
		assert.ok(starts().every((start) => start.route === "fork" && start.model === "anthropic/claude-sonnet-5-5"));
		assert.ok(ends().every((end) => end.outcome === "stored"));
		assert.equal(rig.records.length, wire.length, "not one ledger line per request sent");
		assert.ok(rig.records.every((line) => line.historianVia === "fork" && line.route === "fork" && line.status === "answered"));
		assert.ok((rig.records[0]?.usage?.cacheRead ?? 0) > 0, "the fork's usage is missing");
	});

	it("stores no receipt for a fork declined before sending; the isolated request stores its own", async () => {
		await rig.mainTurn();
		rig.mutate = (p) => ({ ...p, tools: [...(p.tools as unknown[])].reverse() });
		const { run, starts, wire, receiptFirst } = runner();
		await run.run();
		receiptFirst();
		assert.ok(wire.every((sent) => sent.server === "historian"), "a refused fork was sent");
		assert.ok(starts().every((start) => start.route === "primary"), "the declined fork stored a receipt");
		assert.equal(rig.records.length, wire.length, "not one ledger line per request sent");
		assert.deepEqual(rig.records[0] && [rig.records[0].historianVia, rig.records[0].route, rig.records[0].status, rig.records[0].rejection], ["isolated", "primary", "answered", "head"]);
	});

	it("fails a fork that failed after sending: one receipt, one failed ledger line, resent nowhere", async () => {
		await rig.mainTurn();
		rig.mainServer.responder = () => {
			throw new Error("overloaded");
		};
		const { run, starts, ends, wire } = runner();
		await run.run();
		assert.deepEqual(wire, [{ server: "main", receipts: 1 }], "the failed fork was resent");
		assert.deepEqual(starts().map((start) => start.route), ["fork"]);
		assert.deepEqual(ends().map((end) => end.outcome), ["failed"]);
		assert.deepEqual(rig.records.map((line) => [line.historianVia, line.route, line.status]), [["fork", "fork", "failed"]], "the sent failure is not on the ledger as a fork");
	});

	/** The historian line of the cost report over the session's records. */
	const historianCharges = (log: ReturnType<typeof sessionLog>) => reduceAccounting(accountingEvents(log.manager.getEntries())).bySource.historian;

	it("ends a sent fork cut off at its output limit with the usage the provider reported: a known charge in the cost report", async () => {
		await rig.mainTurn();
		rig.mainServer.ending = () => "length";
		const { log, run, ends } = runner();
		await run.run();
		const [end] = ends();
		assert.equal(end?.outcome, "failed");
		const line = rig.records[0];
		assert.deepEqual([line?.historianVia, line?.status], ["fork", "failed"]);
		assert.ok(end?.usage && end.usage.cacheRead > 0, "the failed fork's end record has no usage");
		assert.deepEqual(end.usage, { ...line?.usage, cost: line?.usage?.cost }, "the end record and the ledger line disagree on what the fork used");
		const historian = historianCharges(log);
		assert.deepEqual([historian.requests, historian.known, historian.unknown], [1, 1, 0]);
		assert.equal(historian.cost, end.usage.cost);
	});

	it("ends a sent isolated request whose stream broke with an error with the usage it reported, and one with no response as unknown", async () => {
		rig.historianServer.ending = (_, index) => (index === 0 ? "error" : "complete");
		rig.historianServer.responder = (request, index) => {
			if (index === 1) throw new Error("overloaded");
			return [{ type: "text", text: citingAnswer(lastText(request)) }];
		};
		const second = { ...getModel("anthropic", "claude-haiku-4-5"), baseUrl: rig.historianServer.baseUrl } as Model<Api>;
		const { log, run, ends } = runner({ isolated: [{ route: "primary", model: rig.historian }, { route: "fallback", model: second }] });
		await run.run();
		const [broken, unanswered] = ends();
		assert.deepEqual([broken?.outcome, unanswered?.outcome], ["failed", "failed"]);
		assert.ok(broken?.usage && broken.usage.input > 0, "the broken stream's usage is missing from its end record");
		assert.equal(unanswered && "usage" in unanswered, false, "a request without a response was given a usage");
		const historian = historianCharges(log);
		assert.equal(historian.known, 1 + (historian.requests - 2), "the broken stream is not a known charge");
		assert.equal(historian.unknown, 1);
	});

	it("counts the isolated fallback after a failed historian model: two receipts, two ledger lines", async () => {
		const second = { ...getModel("anthropic", "claude-haiku-4-5"), baseUrl: rig.historianServer.baseUrl } as Model<Api>;
		rig.historianServer.responder = (request) => {
			if (request.body.model === "claude-fable-5") throw new Error("overloaded");
			return [{ type: "text", text: citingAnswer(lastText(request)) }];
		};
		const { run, starts, ends, receiptFirst } = runner({ isolated: [{ route: "primary", model: rig.historian }, { route: "fallback", model: second }] });
		await run.run();
		receiptFirst();
		assert.deepEqual(starts().slice(0, 2).map((start) => start.route), ["primary", "fallback"]);
		assert.deepEqual(ends().slice(0, 2).map((end) => end.outcome), ["failed", "stored"]);
		assert.equal(rig.records.length, starts().length, "not one ledger line per request sent");
		assert.deepEqual(
			rig.records.slice(0, 2).map((line) => [line.historianVia, line.route, line.status, line.rejection]),
			[["isolated", "primary", "failed", "no-capture"], ["isolated", "fallback", "answered", "no-capture"]],
		);
	});

	it("gives the condenser's request a receipt and a ledger line of its own", async () => {
		await rig.mainTurn();
		const small = resolveConfig({ ...config, summaryTokens: 400, historian: { ...config.historian } });
		const oversized = (request: FakeRequest) => {
			const id = /<entry id="([^"]+)"/.exec(lastText(request))?.[1] ?? "none";
			return "## Facts and findings\n" + Array.from({ length: 12 }, (_, i) => `- fact ${i}: ${"detail ".repeat(35)} (#${id})`).join("\n");
		};
		rig.mainServer.responder = (request) => [{ type: "text", text: lastText(request).includes("<records>") ? "malformed" : oversized(request) }];
		const { run, starts, receiptFirst } = runner({ config: small });
		await run.run();
		receiptFirst();
		assert.deepEqual(starts().slice(0, 2).map((start) => [start.step, start.route]), [["summarize", "fork"], ["condense", "fork"]]);
		assert.equal(rig.records.length, starts().length, "not one ledger line per request sent");
	});
});

describe("choosing the route by catalogue prices", () => {
	const priced = (provider: string, id: string) => ({ ...getModel(provider as "anthropic", id as never) }) as Model<Api>;
	const work = { promptTokens: 20_000, outputTokens: 4_096 };

	it("keeps an Opus session's summary on a cheap historian model: the main model's output price outweighs the cache saving", () => {
		const choice = chooseRoute(work, { promptTokens: 150_000 }, { main: priced("anthropic", "claude-opus-5-5"), historian: priced("anthropic", "claude-haiku-5-5") });
		assert.equal(choice.via, "isolated");
		assert.ok(choice.forkCost !== undefined && choice.isolatedCost !== undefined && choice.forkCost > choice.isolatedCost);
	});

	it("keeps a short stretch isolated when the session model also answers summaries", () => {
		const choice = chooseRoute({ promptTokens: 3_000, outputTokens: 1_000 }, { promptTokens: 150_000 }, { main: priced("anthropic", "claude-opus-5-5"), historian: priced("anthropic", "claude-opus-5-5") });
		assert.equal(choice.via, "isolated");
	});

	it("forks when the historian model costs more than reading the warm prefix on the main model", () => {
		const choice = chooseRoute(work, { promptTokens: 150_000 }, { main: priced("anthropic", "claude-sonnet-5-5"), historian: priced("anthropic", "claude-fable-5") });
		assert.equal(choice.via, "fork");
	});

	it("prices a fork whose whole prompt passes a catalogue tier at that tier, cached prefix included", () => {
		const main = priced("anthropic", "claude-haiku-5-5");
		const historian = priced("anthropic", "claude-haiku-4-5");
		const tier = main.cost.tiers?.[0];
		assert.ok(tier && tier.inputTokensAbove < 150_000, "the catalogue no longer tiers this model below the test's prompt");
		const small = { promptTokens: 3_000, outputTokens: 1_000 };
		const choice = chooseRoute(small, { promptTokens: 150_000 }, { main, historian });
		const perMillion = (tokens: number, price: number) => (tokens * price) / 1_000_000;
		assert.ok(Math.abs((choice.forkCost ?? 0) - (perMillion(150_000, tier.cacheRead) + perMillion(3_000, tier.input) + perMillion(1_000, tier.output))) < 1e-12);
		assert.ok(Math.abs((choice.isolatedCost ?? 0) - (perMillion(3_000, historian.cost.input) + perMillion(1_000, historian.cost.output))) < 1e-12);
		assert.equal(choice.via, "isolated", "the fork was priced at the base rates below the tier");
		const below = chooseRoute(small, { promptTokens: 90_000 }, { main, historian });
		assert.equal(below.via, "fork", "a fork below the tier is not priced at the base rates");
	});

	it("does not fork without a price for either model", () => {
		const free = { ...priced("anthropic", "claude-sonnet-5-5"), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
		assert.deepEqual(chooseRoute(work, { promptTokens: 1 }, { main: free, historian: priced("anthropic", "claude-fable-5") }), { via: "isolated", reason: "unpriced" });
	});
});

describe("the capture pool", () => {
	const model = { provider: "anthropic", id: "m", api: "anthropic-messages", baseUrl: "http://x" };
	const payload = (text: string, extra: Record<string, unknown> = {}) => ({ model: "m", max_tokens: 1000, messages: [{ role: "user", content: text }], ...extra });

	it("keeps the newest main requests up to its limit, ignores cache-warming requests, and keeps a copy", () => {
		const pool = new CapturePool();
		const first = payload("one");
		pool.record(first, model, 1);
		(first.messages[0] as { content: string }).content = "changed after capture";
		pool.confirm(model, 10);
		assert.equal(pool.record(payload("ping", { max_tokens: 1 }), model, 2), "warming");
		assert.ok(pool.latest()?.json.includes('"one"'));
		for (let index = 0; index < CAPTURE_LIMIT + 2; index++) pool.record(payload("n" + index), model, 3 + index);
		assert.equal(pool.latest(), undefined, "an unanswered capture was offered");
		assert.ok(pool.bytes < 4 * JSON.stringify(payload("n0")).length);
	});

	// "€" is one UTF-16 unit and three UTF-8 bytes: these sizes tell bytes from string length.
	const euros = (bytes: number) => payload("€".repeat(Math.ceil(bytes / 3)));
	const answered = (pool: CapturePool, bytes: number, at: number) => {
		assert.equal(pool.record(euros(bytes), model, at), "kept");
		pool.confirm(model, 10);
	};

	const reply = (bytes: number, id = "call-1"): AssistantMessage => ({
		role: "assistant",
		content: [
			{ type: "text", text: "€".repeat(Math.ceil(bytes / 3)) },
			{ type: "toolCall", id, name: "read", arguments: {} },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	});
	const result = (toolCallId: string, bytes = 10): ToolResultMessage => ({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "€".repeat(Math.ceil(bytes / 3)) }],
		isError: false,
		timestamp: 2,
	});

	it("counts the main model's answer and its tool results against the ceiling, dropping older captures first", () => {
		const pool = new CapturePool();
		answered(pool, 0.3 * CAPTURE_BYTES, 1);
		assert.equal(pool.record(euros(0.3 * CAPTURE_BYTES), model, 2), "kept");
		const answer = reply(0.3 * CAPTURE_BYTES);
		pool.confirm(model, 10, answer);
		assert.equal(pool.latest()?.at, 2);
		assert.equal(pool.latest()?.reply, answer);
		const before = pool.bytes;
		pool.result(result("call-1", 0.2 * CAPTURE_BYTES));
		assert.equal(pool.latest()?.results.length, 1);
		assert.ok(pool.bytes <= CAPTURE_BYTES, "the pool holds more bytes than the ceiling");
		assert.ok(pool.bytes < before + Buffer.byteLength(JSON.stringify(result("call-1", 0.2 * CAPTURE_BYTES))), "the older capture was kept past the ceiling");
		pool.result(result("call-1"));
		pool.result(result("unknown"));
		assert.equal(pool.latest()?.results.length, 1, "a repeated or unrelated result joined the exchange");
	});

	it("drops a capture whose exchange alone passes the ceiling, rather than keep it without its answer", () => {
		const pool = new CapturePool();
		assert.equal(pool.record(euros(0.5 * CAPTURE_BYTES), model, 1), "kept");
		pool.confirm(model, 10, reply(0.6 * CAPTURE_BYTES));
		assert.equal(pool.latest(), undefined);
		assert.equal(pool.bytes, 0);
	});

	it("counts UTF-8 bytes: a capture larger than the ceiling is never kept", () => {
		const pool = new CapturePool();
		const big = euros(CAPTURE_BYTES + 1_000);
		assert.ok(JSON.stringify(big).length < CAPTURE_BYTES, "the string is shorter than the ceiling");
		assert.equal(pool.record(big, model, 1), "oversized");
		assert.equal(pool.bytes, 0);
	});

	it("drops the older capture when both together pass the ceiling in UTF-8 bytes", () => {
		const pool = new CapturePool();
		answered(pool, 0.6 * CAPTURE_BYTES, 1);
		answered(pool, 0.6 * CAPTURE_BYTES, 2);
		assert.equal(pool.latest()?.at, 2);
		assert.equal(pool.bytes, Buffer.byteLength(JSON.stringify(euros(0.6 * CAPTURE_BYTES))), "only the newest is kept");
	});

	it("keeps two captures that fit together, and never holds more bytes than the ceiling", () => {
		const pool = new CapturePool();
		answered(pool, 0.4 * CAPTURE_BYTES, 1);
		answered(pool, 0.45 * CAPTURE_BYTES, 2);
		const both = Buffer.byteLength(JSON.stringify(euros(0.4 * CAPTURE_BYTES))) + Buffer.byteLength(JSON.stringify(euros(0.45 * CAPTURE_BYTES)));
		assert.equal(pool.bytes, both, "both are kept, counted in bytes");
		assert.ok(pool.bytes <= CAPTURE_BYTES);
		answered(pool, 0.5 * CAPTURE_BYTES, 3);
		assert.ok(pool.bytes <= CAPTURE_BYTES, "a third one pushes the oldest out");
		assert.equal(pool.bytes, Buffer.byteLength(JSON.stringify(euros(0.5 * CAPTURE_BYTES))) + Buffer.byteLength(JSON.stringify(euros(0.45 * CAPTURE_BYTES))));
	});
});

/** A real pi session on a local Anthropic stand-in, with the context extension forking its historian. */
async function forkSession(options: {
	/** Answers a fork; main requests read f0.txt to f5.txt one by one, then answer "done". */
	readonly fork: (request: FakeRequest) => FakeBlock[];
	/** Another extension, loaded before the context extension. */
	readonly extension?: (pi: ExtensionAPI) => void;
	readonly config?: ContextConfigInput;
}) {
	const server = await new FakeAnthropic().start();
	const dir = mkdtempSync(join(tmpdir(), "context-fork-"));
	const ledgerFile = join(dir, "ledger.jsonl");
	for (let index = 0; index < 6; index++) writeFileSync(join(dir, `f${index}.txt`), `FACT ${index}\n` + "y".repeat(8_000));
	const isFork = (request: FakeRequest) => request.body.model === "claude-sonnet-5-5" && lastText(request).includes("<existing-summary>");
	let mains = 0;
	server.responder = (request) => {
		if (isFork(request)) return options.fork(request);
		if (lastText(request).includes("<existing-summary>")) return [{ type: "text", text: citingAnswer(lastText(request), "Isolated summary of the reads") }];
		const index = mains++ % 7;
		return index < 6 ? [{ type: "tool_use", id: `toolu_${mains}`, name: "read", input: { path: `f${index}.txt` } }] : [{ type: "text", text: "done" }];
	};
	let events: ExtensionAPI["events"] | undefined;
	const probe = (pi: ExtensionAPI) => {
		events = pi.events;
		pi.registerProvider("anthropic", { baseUrl: server.baseUrl, apiKey: KEY });
	};
	const context = createContextExtension({
		configFile: false,
		ledgerFile,
		keepWarm: false,
		config: {
			keepRecentTokens: 1_000,
			maskedTokens: 500,
			pinnedUserTokens: 500,
			...options.config,
			historian: { fork: true, model: "anthropic/claude-fable-5", startTokens: 1_000, chunkMinTokens: 1_000, chunkMaxTokens: 3_000, maxOutputTokens: 1_000 },
		},
	});
	const create: Parameters<typeof piSdk.createAgentSessionRuntime>[0] = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await piSdk.createAgentSessionServices({
			cwd,
			agentDir: dir,
			// Pi's manual compaction refuses to run without history older than its own keepRecentTokens (default 20k).
			settingsManager: piSdk.SettingsManager.inMemory({ compaction: { keepRecentTokens: 2_000 } }),
			resourceLoaderOptions: {
				extensionFactories: [probe, ...(options.extension ? [options.extension] : []), context],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-5-5");
		const session = await piSdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: model as never, thinkingLevel: "low" });
		return { ...session, services, diagnostics: services.diagnostics };
	};
	const runtime = await piSdk.createAgentSessionRuntime(create, { cwd: dir, agentDir: dir, sessionManager: piSdk.SessionManager.inMemory() });
	await runtime.session.bindExtensions({});
	const routes = () =>
		existsSync(ledgerFile)
			? readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.class === "historian-route")
			: [];
	const until = async (done: () => boolean) => {
		for (let wait = 0; wait < 100 && !done(); wait++) await new Promise((resolve) => setTimeout(resolve, 50));
	};
	return {
		server,
		dir,
		runtime,
		routes,
		until,
		isFork,
		events: () => events,
		close: async () => {
			await runtime.dispose();
			await server.stop();
		},
	};
}

describe(`the fork inside a pi session, on pi ${VERSION}`, () => {
	it("forks from the request pi sent last, once, and never runs a tool the fork's answer calls", async () => {
		let dir = "";
		const session = await forkSession({
			fork: (request) => [
				{ type: "text", text: citingAnswer(lastText(request)) },
				{ type: "tool_use", id: "toolu_fork", name: "bash", input: { command: `touch ${join(dir, "executed")}` } },
			],
		});
		dir = session.dir;
		const { server, routes, until, isFork } = session;
		try {
			await session.runtime.session.prompt("Read f0.txt to f5.txt one by one.");
			await until(() => server.requests.some(isFork));
			await until(() => routes().length > 0);
			const forks = server.requests.filter(isFork);
			assert.equal(forks.length, 1, "not exactly one fork request");
			const fork = forks[0] as FakeRequest;
			const mains = server.requests.filter((request) => !isFork(request) && request.body.model === "claude-sonnet-5-5");
			const { messages: forkMessages, max_tokens: forkLimit, ...forkHead } = fork.body as { messages: unknown[]; max_tokens: unknown };
			// The capture: the newest main request sent before the fork that the fork's messages start with.
			const before = mains.filter((request) => server.requests.indexOf(request) < server.requests.indexOf(fork));
			const base = before.findLast((request) => stableStringify(forkMessages.slice(0, messagesOf(request.body).length)) === stableStringify(messagesOf(request.body)));
			assert.ok(base, "the fork does not start with a main request's messages");
			const { messages: mainMessages, max_tokens: _, ...mainHead } = base.body as { messages: unknown[]; max_tokens?: unknown };
			assert.deepEqual(forkHead, mainHead);
			assert.equal(forkLimit, 1_000, "the fork is not sent at the historian's output limit");
			// What follows the capture is the main model's real exchange: the next main request carries the same messages.
			const exchange = forkMessages.slice(mainMessages.length, -1);
			assert.equal((exchange[0] as { role: string }).role, "assistant", "the fork does not carry the main model's answer");
			const unmarked = (value: unknown) => JSON.parse(JSON.stringify(value), (key, item) => (key === "cache_control" ? undefined : item)) as unknown;
			const later = mains.find((request) => request.body.messages !== undefined && request !== base && messagesOf(request.body).length > mainMessages.length);
			assert.ok(later, "no later main request to compare the exchange with");
			const following = messagesOf(later.body).slice(mainMessages.length).filter((message) => message.role !== "system");
			assert.deepEqual(exchange, unmarked(following.slice(0, exchange.length)), "the fork's exchange is not the one pi sent the main model");
			assert.match(JSON.stringify(exchange), /tool_result/, "the fixture's exchange has no tool results");
			assert.ok(fork.cacheRead > 0);
			assert.equal(routes()[0]?.historianVia, "fork");
			assert.equal(routes()[0]?.rejection, "tool-call");
			assert.equal(existsSync(join(dir, "executed")), false, "the fork's tool call ran");
			assert.ok(!server.requests.some((request) => JSON.stringify(request.body).includes("toolu_fork")), "the fork's tool call went back to a model");
		} finally {
			await session.close();
		}
	}, 30_000);

	it("never forks a session whose requests another extension gave a provider-run tool, and summarizes isolated", async () => {
		const webSearch = { type: "web_search_20250305", name: "web_search", max_uses: 1 };
		const session = await forkSession({
			fork: (request) => [{ type: "text", text: citingAnswer(lastText(request)) }],
			extension: (pi) =>
				pi.on("before_provider_request", (event) => {
					const payload = event.payload as Record<string, unknown>;
					return { ...payload, tools: [...((payload.tools as unknown[]) ?? []), webSearch] };
				}),
		});
		const { server, routes, until, isFork } = session;
		try {
			await session.runtime.session.prompt("Read f0.txt to f5.txt one by one.");
			await until(() => routes().length > 0);
			assert.ok(server.requests.some((request) => JSON.stringify(request.body.tools).includes("web_search_20250305")), "the main requests do not carry the server tool");
			assert.equal(server.requests.filter(isFork).length, 0, "a capture with a server-run tool was forked");
			assert.ok(server.requests.some((request) => request.body.model === "claude-fable-5"), "the summary was not asked isolated");
			assert.equal(routes()[0]?.historianVia, "isolated");
			assert.equal(routes()[0]?.rejection, "server-tools");
		} finally {
			await session.close();
		}
	}, 30_000);

	it("cuts with the fork's summary: the archived reads are carried by what the fork wrote, and the next request starts from it", async () => {
		const session = await forkSession({
			fork: (request) => [{ type: "text", text: citingAnswer(lastText(request), "Forked summary of the reads") }],
			config: { taskCutMinTokens: 2_000 },
		});
		const { server, routes, until, isFork, runtime } = session;
		try {
			await runtime.session.prompt("Read f0.txt to f5.txt one by one.");
			const stored = () => runtime.session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SUMMARY_KIND);
			await until(stored);
			assert.ok(server.requests.some(isFork), "the summary was not forked");
			assert.equal(routes()[0]?.historianVia, "fork");
			assert.equal(routes()[0]?.status, "answered");
			assert.ok(stored(), "the fork's summary was not stored");
			session.events()?.emit(CUT_REQUEST_CHANNEL, { reason: "task done" });
			const sentBefore = server.requests.length;
			await runtime.session.prompt("Read f0.txt to f5.txt once more.");
			const cuts = runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			assert.equal(cuts.length, 1, "no cut happened");
			const cut = cuts[0] as { summary: string };
			assert.match(cut.summary, /Forked summary of the reads \(#\w+\)/, "the cut does not carry the fork's summary");
			const next = server.requests.slice(sentBefore).find((request) => request.body.model === "claude-sonnet-5-5" && !isFork(request)) as FakeRequest;
			assert.ok(JSON.stringify(next.body.messages).includes("Forked summary of the reads"), "the request after the cut does not start from the fork's summary");
			assert.ok(!JSON.stringify(next.body.messages).includes("FACT 0"), "the archived reads are still in the prompt");
		} finally {
			await session.close();
		}
	}, 30_000);

	it("sends the fork with the headers another extension added to the main request, and pi's own credential", async () => {
		const session = await forkSession({
			fork: (request) => [{ type: "text", text: citingAnswer(lastText(request)) }],
			extension: (pi) =>
				pi.on("before_provider_headers", (event) => {
					event.headers["x-cache-route"] = "tenant-route-A";
				}),
		});
		const { server, routes, until, isFork, runtime } = session;
		try {
			await runtime.session.prompt("Read f0.txt to f5.txt one by one.");
			await until(() => routes().length > 0);
			const forks = server.requests.filter(isFork);
			assert.ok(forks.length > 0, "the summary was not forked");
			assert.equal(server.requests.find((request) => !isFork(request))?.headers?.["x-cache-route"], "tenant-route-A");
			assert.deepEqual(
				forks.map((request) => request.headers?.["x-cache-route"]),
				forks.map(() => "tenant-route-A"),
				"a fork left without the main request's routing header",
			);
			assert.ok(forks.every((request) => request.headers?.["x-api-key"] === KEY), "the fork does not carry pi's credential");
		} finally {
			await session.close();
		}
	}, 30_000);
});

describe(`the historian's fork next to a refresh already reading the prefix, on pi ${VERSION}`, () => {
	/** Lets the fork's admission run: event-loop turns, enough for a fork that does not wait to reach the server. */
	const turns = async (count = 40) => {
		for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve));
	};
	const capture = () => {
		const latest = rig.requests.captures.latest();
		assert.ok(latest, "no capture");
		return latest;
	};

	it("waits for pi's warmer to answer, then forks from the prefix it kept", async () => {
		await rig.mainTurn();
		clock += 250_000;
		const nativeAt = clock;
		const end = rig.requests.captures.refresh("native", 120_000);
		const summary = rig.requests.complete(summaryRequest(), rig.host());
		await turns();
		assert.equal(rig.mainServer.requests.length, 1, "the fork read the prefix while pi's warmer was reading it");
		// The warmer answers late: by the main request's clock the prefix expired, by the warmer's read it lives.
		clock += 100_000;
		rig.requests.captures.touch(capture(), nativeAt);
		end();
		await summary;
		assert.equal(rig.mainServer.requests.length, 2);
		assert.equal(rig.records[0]?.historianVia, "fork");
		assert.ok(Number(rig.records[0]?.cacheRead) > 0);
	});

	it("plans again after a ping that failed: a prefix that expired meanwhile goes isolated", async () => {
		await rig.mainTurn();
		clock += 250_000;
		const end = rig.requests.captures.refresh("warm");
		const summary = rig.requests.complete(summaryRequest(), rig.host());
		await turns();
		assert.equal(rig.mainServer.requests.length, 1, "the fork read the prefix while the ping was reading it");
		clock += 100_000;
		end();
		await summary;
		assert.equal(rig.mainServer.requests.length, 1, "the fork went on a prefix nothing kept");
		assert.equal(rig.records[0]?.historianVia, "isolated");
		assert.equal(rig.records[0]?.rejection, "expired");
	});

	it("waits for a refresh that never ends no longer than its lease", async () => {
		await rig.mainTurn();
		rig.requests.captures.refresh("warm", 400);
		const started = Date.now();
		const summary = rig.requests.complete(summaryRequest(), rig.host());
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(rig.mainServer.requests.length, 1, "the fork did not wait for the refresh out");
		await summary;
		assert.ok(Date.now() - started >= 390, "the fork went before the lease ended");
		assert.equal(rig.records[0]?.historianVia, "fork");
	});

	it("ends the wait when the historian's run is aborted, and sends nothing", async () => {
		await rig.mainTurn();
		const end = rig.requests.captures.refresh("warm");
		const controller = new AbortController();
		const summary = rig.requests.complete({ ...summaryRequest(), signal: controller.signal }, rig.host());
		await turns();
		controller.abort(new Error("run ended"));
		await assert.rejects(summary, /run ended/);
		end();
		await turns();
		assert.equal(rig.mainServer.requests.length, 1, "a fork went out after the abort");
		assert.equal(rig.historianServer.requests.length, 0);
		assert.deepEqual(rig.records, []);
	});
});
