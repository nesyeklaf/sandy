import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import { isModelError, resolveHistorianModels, summarizeWith } from "../src/historian/model.ts";
import { attemptRecords, citingAnswer, harness, storedSummaries } from "./support/historian.ts";
import { sessionLog } from "./support/session-log.ts";

const model = { provider: "p", id: "m" };
const request = { system: "s", prompt: "p", maxTokens: 100 } as Parameters<typeof summarizeWith>[2];
const answer = (text: string, stopReason: string) => async () =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason, usage: {} }) as unknown as AssistantMessage;

describe("the historian's model call", () => {
	it("returns a complete answer", async () => {
		const result = await summarizeWith(answer("## Goal\n- g", "stop"), model, request);
		assert.equal(result.model, "p/m");
	});

	it("refuses an answer cut off at the output limit, so coverage does not advance", async () => {
		await assert.rejects(summarizeWith(answer("## Goal\n- g", "length"), model, request), /output limit/);
	});

	it("refuses an empty answer", async () => {
		await assert.rejects(summarizeWith(answer("  \n", "stop"), model, request), /empty/);
	});

	// Session 01a171b8: without a reasoning option the Anthropic models thought at effort "high" and spent the 4096
	// output tokens on thinking. The historian asks for no thinking, or the least a model allows.
	it("asks for no thinking, or the least thinking a model allows", async () => {
		const asked: unknown[] = [];
		const capture = async (_context: unknown, options: { reasoning?: unknown }) => {
			asked.push(options.reasoning);
			return { role: "assistant", content: [{ type: "text", text: "## Goal\n- g" }], stopReason: "stop", usage: {} } as unknown as AssistantMessage;
		};
		const levels = { minimal: null, low: "low", medium: "medium", high: "high" };
		await summarizeWith(capture, { ...model, reasoning: true, thinkingLevelMap: levels }, request);
		await summarizeWith(capture, { ...model, reasoning: true, thinkingLevelMap: { ...levels, off: null } }, request);
		await summarizeWith(capture, { ...model, reasoning: false }, request);
		assert.deepEqual(asked, [undefined, "low", undefined]);
	});

	// An attempt record stands for one paid request only if nothing resends it unseen: a WebSocket transport reconnects
	// and falls back to SSE inside one call, and providers retry when asked to.
	it("pins one request on the wire: SSE and no provider retries", async () => {
		const asked: { transport?: unknown; maxRetries?: unknown }[] = [];
		const capture = async (_context: unknown, options: { transport?: unknown; maxRetries?: unknown }) => {
			asked.push({ transport: options.transport, maxRetries: options.maxRetries });
			return { role: "assistant", content: [{ type: "text", text: "## Goal\n- g" }], stopReason: "stop", usage: {} } as unknown as AssistantMessage;
		};
		await summarizeWith(capture, model, request);
		assert.deepEqual(asked, [{ transport: "sse", maxRetries: 0 }]);
	});
});

// Session 01a171b8: the session model (claude-opus-5-5) cannot turn thinking off, so 19 of 22 historian calls spent the
// output limit on thinking. A fallback model answers instead, as a request of its own.
describe("the historian's fallback", () => {
	const config = resolveConfig({
		keepRecentTokens: 1_000,
		maskedTokens: 500,
		pinnedUserTokens: 1_000,
		historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
	});
	const models = ["p/primary", "p/fallback"];
	const scene = () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		return log;
	};
	const starts = (log: ReturnType<typeof sessionLog>) =>
		attemptRecords(log).flatMap((record) => (record.type === "start" ? [[record.route, record.model]] : []));

	it("asks the next model when one fails, each request with a receipt naming its model", async () => {
		const log = scene();
		const asked: string[] = [];
		const run = harness(log, config, {
			models,
			answer: (request, model) => {
				asked.push(model);
				if (model === "p/primary") return Promise.reject(new Error("historian answer hit the output limit"));
				return citingAnswer(request.prompt);
			},
		});
		await run.run();
		assert.deepEqual(asked, models);
		assert.equal(storedSummaries(log).length, 1);
		assert.deepEqual(starts(log), [
			["primary", "p/primary"],
			["fallback", "p/fallback"],
		]);
		const ends = attemptRecords(log).flatMap((record) => (record.type === "end" ? [record.outcome] : []));
		assert.deepEqual(ends, ["failed", "stored"]);
	});

	it("reports every failure when all models fail", async () => {
		const log = scene();
		const failures = ["output limit", "overloaded"];
		const run = harness(log, config, { models, answer: () => Promise.reject(new Error(failures.shift())) });
		await run.run();
		assert.match(String(run.failures[0]), /output limit.*overloaded/s);
	});

	it("does not ask the next model once the run was aborted", async () => {
		const log = scene();
		const asked: string[] = [];
		const run = harness(log, config, {
			models,
			answer: (request, model) => {
				asked.push(model);
				return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
			},
		});
		run.start();
		for (let i = 0; i < 2_000 && asked.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(await run.lifecycle.shutdown("quit"), "aborted");
		assert.deepEqual(asked, ["p/primary"]);
		assert.equal(starts(log).length, 1);
	});
});

// A typo in historian.model used to fall through to the session model, the most expensive one.
describe("the historian's configured models", () => {
	const known = new Map([
		["anthropic/claude-haiku", { name: "haiku" }],
		["openai-codex/gpt-6-luna", { name: "luna" }],
	]);
	const registry = { find: (provider: string, id: string) => known.get(`${provider}/${id}`) };
	const configured = (historian: Record<string, string>) => resolveConfig({ historian });

	it("leaves the session's model to answer when none is configured", () => {
		assert.deepEqual(resolveHistorianModels(configured({}), registry), { primary: undefined, fallback: undefined });
	});

	it("finds the configured model and fallback", () => {
		const resolved = resolveHistorianModels(
			configured({ model: "anthropic/claude-haiku", fallbackModel: "openai-codex/gpt-6-luna" }),
			registry,
		);
		assert.ok(!isModelError(resolved));
		assert.equal(resolved.primary?.name, "haiku");
		assert.equal(resolved.fallback?.name, "luna");
	});

	it("fails on a model the registry does not know, with no fallback to the session model", () => {
		const resolved = resolveHistorianModels(configured({ model: "anthropic/claude-haiku-typo" }), registry);
		assert.ok(isModelError(resolved));
		assert.match(resolved.modelError, /historian\.model "anthropic\/claude-haiku-typo" is not a model this pi knows/);
	});

	it("refuses a model whose client retries unseen, so every paid request has its receipt", () => {
		const bedrock = { find: () => ({ name: "claude", api: "bedrock-converse-stream" }) };
		const resolved = resolveHistorianModels(configured({ fallbackModel: "amazon-bedrock/claude" }), bedrock);
		assert.ok(isModelError(resolved));
		assert.match(resolved.modelError, /historian\.fallbackModel "amazon-bedrock\/claude" uses bedrock-converse-stream/);
	});

	it("fails on an unknown fallback model and names both problems", () => {
		const resolved = resolveHistorianModels(configured({ model: "a/b", fallbackModel: "c/d" }), registry);
		assert.ok(isModelError(resolved));
		assert.match(resolved.modelError, /historian\.model "a\/b".*historian\.fallbackModel "c\/d"/);
	});
});
