import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { foldCut } from "../src/core/cut.ts";
import { isHistoryTool, newestFirstPages, TOOLS } from "../src/core/tools.ts";
import { entry, session } from "./helpers.ts";
import { small } from "./support/core.ts";

describe("history tools", () => {
	it("names the history tools whose own traffic a search leaves out", () => {
		assert.equal(isHistoryTool(TOOLS.historySearch.name), true);
		assert.equal(isHistoryTool(TOOLS.historyRead.name), true);
		assert.equal(isHistoryTool(TOOLS.notebook.name), false);
		assert.equal(isHistoryTool("read"), false);
	});

	it("tells the agent a cursor is opaque and an offset counts UTF-16 code units", () => {
		assert.match(TOOLS.historySearch.parameters.cursor, /Opaque cursor/);
		assert.match(TOOLS.historyRead.parameters.offset, /UTF-16/);
	});

	it("reads the log newest first in pages from an entry and names an entry it lacks", () => {
		const log = Array.from({ length: 10 }, (_, i) => entry("e" + i, "user", "m" + i));
		assert.deepEqual([...newestFirstPages(log, 4)].map((page) => page.map((e) => e.id)), [
			["e9", "e8", "e7", "e6"],
			["e5", "e4", "e3", "e2"],
			["e1", "e0"],
		]);
		assert.deepEqual([...newestFirstPages(log, 4, "e3")].flat().map((e) => e.id), ["e2", "e1", "e0"]);
		assert.throws(() => [...newestFirstPages(log, 4, "nowhere")], /nowhere/);
	});

	it("plans a cut whose text does not explain ids", () => {
		const plan = foldCut({
			entries: session(12),
			minKeptIndex: 0,
			visibleFromIndex: 0,
			config: small,
			reason: "watermark",
		});
		assert.ok(plan);
		assert.doesNotMatch(plan.text.split("\n").slice(0, 3).join("\n"), /hex|decimal|digit|format/i);
	});
});
