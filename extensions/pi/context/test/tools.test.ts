import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { checkNotebook, newestFirstPages, readHistory, searchHistory, TOOLS } from "../src/core/tools.ts";
import { historyReadParameters, historySearchParameters, notebookParameters } from "../src/tools/schemas.ts";
import { entry, session } from "./helpers.ts";

describe("history tools", () => {
	it("searches the history without the history tools' own calls", async () => {
		const own = [
			entry("q1", "assistant", "looking", {
				toolCalls: [{ id: "c", name: TOOLS.historySearch.name, args: { query: "zebra" } }],
			}),
			entry("q2", "tool", "No matches for zebra", { toolName: TOOLS.historySearch.name }),
			entry("q3", "user", "zebra crossing"),
		];
		const result = await searchHistory(() => newestFirstPages(own, 2), { query: "zebra", limit: 5 });
		assert.deepEqual(
			result.hits.map((hit) => hit.id),
			["q3"],
		);
	});

	it("reads an entry by its id or a unique prefix, with neighbors and in parts", () => {
		const entries = session(3);
		const read = readHistory(entries, { id: "#u1", around: 1 });
		assert.equal(read.id, "u1");
		assert.match(read.text, /^Before:\n\[#r0/);
		assert.match(read.text, /After:\n\[#a1/);
		assert.equal(readHistory(entries, { id: "r1" }).id, "r1");
		const long = [entry("abcd1234", "tool", "z".repeat(1_500), { toolName: "bash" })];
		assert.equal(readHistory(long, { id: "abcd" }).id, "abcd1234");
		const part = readHistory(long, { id: "abcd1234", maxChars: 500 });
		assert.match(part.text, /\[\d+ more characters: history_read id=abcd1234 offset=500\]/);
		assert.ok(readHistory(long, { id: "abcd1234", offset: 1_000, maxChars: 500 }).text.length < part.text.length);
		assert.throws(() => readHistory(entries, { id: "#nope" }), /No entry #nope/);
		assert.throws(() => readHistory([entry("ab1", "user", "x"), entry("ab2", "user", "y")], { id: "ab" }), /No entry/);
	});

	it("limits the notebook by its bytes and words the answers", () => {
		assert.deepEqual(checkNotebook("plan", 100), { ok: true, message: expectedSaved(4) });
		assert.deepEqual(checkNotebook("", 100), { ok: true, message: "Notebook cleared." });
		const tooLong = checkNotebook("é".repeat(60), 100);
		assert.equal(tooLong.ok, false);
		assert.match(tooLong.ok ? "" : tooLong.message, /120 bytes, the limit is 100/);
	});

	function expectedSaved(bytes: number): string {
		return `Notebook saved (${bytes} bytes). It is carried into your context whenever older history is archived.`;
	}

	it("declares schemas that carry the core's texts and bounds", () => {
		const properties = (schema: unknown) =>
			(schema as { properties: Record<string, { description?: string; minimum?: number; maximum?: number }> })
				.properties;
		for (const [schema, tool] of [
			[historySearchParameters, TOOLS.historySearch],
			[historyReadParameters, TOOLS.historyRead],
			[notebookParameters, TOOLS.notebook],
		] as const) {
			const declared = properties(schema);
			assert.deepEqual(Object.keys(declared).sort(), Object.keys(tool.parameters).sort());
			for (const [name, text] of Object.entries(tool.parameters)) assert.equal(declared[name]?.description, text);
		}
		const chars = properties(historyReadParameters).maxChars;
		assert.deepEqual([chars?.minimum, chars?.maximum], [500, 60_000]);
	});
});
