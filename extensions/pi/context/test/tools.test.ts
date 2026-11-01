import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { checkNotebook, TOOLS } from "../src/core/tools.ts";
import { historyReadParameters, historySearchParameters, notebookParameters } from "../src/tools/schemas.ts";

describe("history tools", () => {
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
