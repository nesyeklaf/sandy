import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { logEntry } from "../src/core/messages.ts";
import { cutAccepted, cutShrinks, projectedTokens } from "../src/core/policy.ts";
import { archivedReads, ContextSignals, isDelegation, readPath } from "../src/core/signals.ts";
import type { LogEntry } from "../src/core/types.ts";

const none = () => false;

function readResult(id: string, path: string): LogEntry {
	return logEntry(id, "tool", 0, "file text", { toolName: "read", call: { id: `c${id}`, name: "read", args: { path } } });
}

describe("context signals", () => {
	it("counts tool output per request and per run", () => {
		const signals = new ContextSignals();
		signals.observe({ name: "read", input: { path: "a.ts" }, outputTokens: 1_000 }, none);
		signals.observe({ name: "bash", input: { command: "ls" }, outputTokens: 500 }, none);
		assert.equal(signals.request().toolTokens, 1_500);
		signals.observe({ name: "grep", input: {}, outputTokens: 200 }, none);
		const second = signals.request();
		assert.equal(second.toolTokens, 200);
		assert.equal(second.runToolTokens, 1_700);
		signals.startRun();
		assert.equal(signals.snapshot().runToolTokens, 0);
	});

	it("counts history calls and re-reads of archived files only after a cut", () => {
		const signals = new ContextSignals();
		const archived = (path: string) => path === "old.ts";
		signals.observe({ name: "history_search", input: { query: "x" }, outputTokens: 10 }, archived);
		assert.equal(signals.snapshot().requestsSinceCut, undefined);
		assert.equal(signals.snapshot().historyCallsSinceCut, 0);

		signals.cut();
		signals.observe({ name: "history_read", input: { id: "1" }, outputTokens: 10 }, archived);
		signals.observe({ name: "read", input: { path: "old.ts" }, outputTokens: 10 }, archived);
		signals.observe({ name: "read", input: { path: "new.ts" }, outputTokens: 10 }, archived);
		signals.request();
		const after = signals.snapshot();
		assert.equal(after.requestsSinceCut, 1);
		assert.equal(after.historyCallsSinceCut, 1);
		assert.equal(after.rereadsSinceCut, 1);
	});

	it("recognizes agents started through sandy", () => {
		assert.equal(isDelegation("bash", { command: "sandy workflows run --name review" }), true);
		assert.equal(isDelegation("bash", { command: "sandy thread new --prompt x" }), true);
		assert.equal(isDelegation("mcp__sandy_pi_extension__sandy_workflow_run", {}), true);
		assert.equal(isDelegation("bash", { command: "sandy thread list" }), false);
		assert.equal(isDelegation("read", { path: "sandy workflows run" }), false);
	});

	it("resumes the after-cut counters from the log of a branch cut by another process", () => {
		const entries: LogEntry[] = [
			readResult("1", "old.ts"),
			logEntry("2", "assistant", 0, "answer"),
			readResult("3", "old.ts"),
			logEntry("4", "tool", 0, "hits", {
				toolName: "history_search",
				call: { id: "c4", name: "history_search", args: { query: "x" } },
			}),
		];
		assert.deepEqual([...archivedReads(entries, 1)], ["old.ts"]);
		const signals = new ContextSignals();
		signals.resume(entries, 1, 1);
		const resumed = signals.snapshot();
		assert.equal(resumed.requestsSinceCut, 1);
		assert.equal(resumed.rereadsSinceCut, 1);
		assert.equal(resumed.historyCallsSinceCut, 1);
	});

	it("takes the path only from read calls", () => {
		assert.equal(readPath("read", { path: "a.ts" }), "a.ts");
		assert.equal(readPath("write", { path: "a.ts" }), undefined);
		assert.equal(readPath("read", {}), undefined);
	});
});

describe("cut size guard", () => {
	it("accepts a cut only when it brings the prompt below the limit", () => {
		const cut = { visibleTokens: 130_000, blockTokens: 10_000, limit: 120_000 };
		assert.equal(cutShrinks({ ...cut, contextTokens: 130_000, archivedTokens: 100_000 }), true);
		assert.equal(cutShrinks({ ...cut, contextTokens: 130_000, archivedTokens: 5_000 }), false);
	});

	// Session 01a171b8: the provider counted ~1.8 tokens per four characters, so the estimated archive was set against a
	// real prompt and every cut was refused while the prompt grew to 375k tokens.
	it("measures the archived history in the provider's tokens, not in the four-characters estimate", () => {
		const cut = { contextTokens: 374_000, visibleTokens: 200_000, archivedTokens: 175_000, blockTokens: 20_000 };
		assert.equal(cutShrinks({ ...cut, limit: 120_000 }), true);
		assert.equal(cutShrinks({ ...cut, limit: 80_000 }), false);
	});

	// Session 01a17c8b (thr_6vthb5nb84): a 100k watermark, and what a cut carried came to ~128k. Every cut was refused,
	// also past the hard threshold, and the prompt grew to 331k because pi compacts only near the 1M window.
	const stuck = { contextTokens: 331_281, visibleTokens: 172_209, archivedTokens: 122_796, blockTokens: 16_937, limit: 100_000 };

	it("projects the prompt after a cut", () => {
		assert.equal(Math.round(projectedTokens(stuck)), 127_638);
	});

	it("cuts past the hard threshold when the cut frees a quarter of the prompt, even above the limit", () => {
		assert.equal(cutShrinks(stuck), false);
		assert.equal(cutAccepted(stuck, 150_000), true);
	});

	it("still refuses a cut that misses the limit below the hard threshold", () => {
		assert.equal(cutAccepted({ ...stuck, contextTokens: 140_000, visibleTokens: 75_000, archivedTokens: 30_000 }, 150_000), false);
	});

	it("refuses a cut past the hard threshold that frees too little, so cuts do not follow each other", () => {
		// Right after a cut that stayed above the limit: little new history to archive.
		const after = { contextTokens: 150_000, visibleTokens: 80_000, archivedTokens: 20_000, blockTokens: 15_000, limit: 100_000 };
		assert.equal(cutAccepted(after, 150_000), false);
	});
});
