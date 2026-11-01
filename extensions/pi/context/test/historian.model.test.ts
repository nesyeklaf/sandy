import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import { firstAnswer, summarizeWith } from "../src/historian/model.ts";

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
});

// Session 01a171b8: the session model (claude-opus-5-5) cannot turn thinking off, so 19 of 22 historian calls spent the
// output limit on thinking. A fallback model answers instead.
describe("the historian's fallback", () => {
	const fail = (message: string) => async () => {
		throw new Error(message);
	};

	it("asks the next model when one fails", async () => {
		const calls: string[] = [];
		const result = await firstAnswer([
			async () => {
				calls.push("primary");
				throw new Error("historian answer hit the output limit");
			},
			async () => {
				calls.push("fallback");
				return "summary";
			},
		]);
		assert.equal(result, "summary");
		assert.deepEqual(calls, ["primary", "fallback"]);
	});

	it("reports every failure when all models fail", async () => {
		await assert.rejects(firstAnswer([fail("output limit"), fail("overloaded")]), /output limit.*overloaded/s);
	});

	it("does not ask the next model once the run was aborted", async () => {
		const abort = new AbortController();
		let asked = false;
		const first = async () => {
			abort.abort();
			throw new Error("aborted");
		};
		const second = async () => {
			asked = true;
			return "summary";
		};
		await assert.rejects(firstAnswer([first, second], abort.signal), /aborted/);
		assert.equal(asked, false);
	});
});
