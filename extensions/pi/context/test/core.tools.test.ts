import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { planCut } from "../src/core/cut.ts";
import { SearchIndex } from "../src/core/search.ts";
import { historyText, newestFirstPages, renderSearch, searchHistory } from "../src/core/tools.ts";
import { entry, session } from "./helpers.ts";
import { small } from "./support/core.ts";

describe("history tools", () => {
	/** A long log with a shared vocabulary, a few rare words and one needle far back. */
	const log = Array.from({ length: 600 }, (_, i) =>
		entry(
			`e${i}`,
			i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool",
			[
				`step ${i} of the deploy touches module${i % 17}`,
				i % 5 === 0 ? "timeout while waiting" : "",
				i % 7 === 0 ? "retry scheduled" : "",
				i === 10 ? "needlexyz found here" : "",
				i === 590 ? "recently seen retry" : "",
			].join(" "),
			i % 3 === 2 ? { toolName: "bash" } : {},
		),
	);

	it("resolves #12 and #1a2b3c4d to the entries the history holds", async () => {
		const history = [
			...Array.from({ length: 40 }, (_, i) => entry(String(i), "user", `message ${i} about deploys`)),
			entry("1a2b3c4d", "assistant", "the migration finished"),
			entry("ff", "tool", "see #12 for the plan", { toolName: "bash" }),
		];
		const direct = (query: string) =>
			searchHistory(() => newestFirstPages(history, 7), { query, limit: 10 }).then((result) =>
				result.hits.filter((hit) => hit.score === Number.POSITIVE_INFINITY).map((hit) => hit.id),
			);
		assert.deepEqual(await direct("what did #12 and #1a2b3c4d say"), ["12", "1a2b3c4d"]);
		assert.deepEqual(await direct("#99 #12"), ["12"], "an ID absent from the history does not resolve");
		assert.deepEqual(await direct("#nowhere"), []);
		assert.deepEqual(await direct("12"), [], "a bare number is a keyword, not an ID");
		assert.deepEqual(await direct("#ff #12 #ff"), ["ff", "12"], "each ID once, in the order of the query");
		const keywords = await searchHistory(() => newestFirstPages(history, 7), { query: "#ff", limit: 3 });
		assert.deepEqual(keywords.hits[0], { id: "ff", score: Number.POSITIVE_INFINITY });
		const plan = planCut({
			entries: session(12),
			minKeptIndex: 0,
			visibleFromIndex: 0,
			config: small,
			reason: "watermark",
		});
		assert.ok(plan);
		assert.doesNotMatch(plan.text.split("\n").slice(0, 3).join("\n"), /hex|decimal|digit|format/i);
	});

	it("ranks pages of history like the whole index and returns a cursor to older entries", async () => {
		const index = new SearchIndex();
		for (const e of log) index.add(e.id, historyText(e));
		const query = "timeout retry module3 needlexyz";
		const whole = index.search(query, { limit: 10 });
		assert.equal(whole.length, 10);
		for (const size of [1, 7, 256, 1_000]) {
			const paged = await searchHistory(() => newestFirstPages(log, size), { query, limit: 10 });
			assert.deepEqual(paged.hits, whole, `page size ${size}`);
			assert.equal(paged.cursor, undefined);
			assert.equal(paged.scanned, log.length);
		}
		const accepted = index.search(query, { limit: 5, accept: (id) => Number(id.slice(1)) < 300 });
		const filtered = await searchHistory(() => newestFirstPages(log, 64), {
			query,
			limit: 5,
			accept: (id) => Number(id.slice(1)) < 300,
		});
		assert.deepEqual(filtered.hits, accepted);

		const rare = "needlexyz";
		assert.deepEqual(
			(await searchHistory(() => newestFirstPages(log, 50), { query: rare, limit: 5 })).hits.map((hit) => hit.id),
			["e10"],
		);
		const first = await searchHistory(() => newestFirstPages(log, 50), { query: rare, limit: 5, scanLimit: 200 });
		assert.deepEqual(first.hits, []);
		assert.equal(first.scanned, 200);
		assert.equal(first.cursor, "e400", "the oldest entry scanned");
		const second = await searchHistory(() => newestFirstPages(log, 50, first.cursor), {
			query: rare,
			limit: 5,
			scanLimit: 200,
		});
		assert.equal(second.scanned, 200);
		assert.equal(second.cursor, "e200");
		const third = await searchHistory(() => newestFirstPages(log, 50, second.cursor), {
			query: rare,
			limit: 5,
			scanLimit: 200,
		});
		assert.deepEqual(
			third.hits.map((hit) => hit.id),
			["e10"],
		);
		assert.equal(third.cursor, undefined, "the end of the history");
		assert.throws(() => [...newestFirstPages(log, 50, "nowhere")], /nowhere/);
		const { text } = renderSearch({
			query: rare,
			archivedOnly: false,
			found: [],
			cursor: first.cursor,
			scanned: 200,
		});
		assert.match(text, /No matches/);
		assert.match(text, /cursor="e400"/);
	});
});
