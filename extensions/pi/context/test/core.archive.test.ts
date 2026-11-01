import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { openArchive } from "../src/core/archive.ts";
import { SearchIndex } from "../src/core/search.ts";
import { chunkPieces, jsonPieces, renderChunks, renderPieces } from "../src/core/serialize.ts";
import { TOOLS } from "../src/core/tools.ts";
import type { ArchiveReader, LogEntry } from "../src/core/types.ts";
import { entry } from "./helpers.ts";
import { archiveOf, compactionItem, entryItems, hasLoneSurrogate } from "./support/archive.ts";

/** What a page shows of the rendering: without the notices before it and the pointer to the next page after it. */
const body = (text: string) =>
	text.replace(/^(\[(?:Historical|No longer|Replaced|Omitted|A summary)[^\n]*\]\n)+/, "").replace(/\n\[more: [^\]]*\]$/, "");

const whole = (e: LogEntry) => [...renderPieces(e)].map((piece) => piece.text).join("");

/** Every page of an entry, followed through the pointers each one names. */
async function readAll(archive: ArchiveReader, id: string, maxChars: number): Promise<string> {
	let text = "";
	let offset: number | undefined = 0;
	for (let pages = 0; offset !== undefined; pages++) {
		assert.ok(pages < 10_000, "paging ends");
		const page = await archive.read({ id, offset, maxChars });
		text += body(page.text);
		offset = page.next;
	}
	return text;
}

const big = (marker: string, at: number, total: number) =>
	"a ".repeat(Math.floor(at / 2)) + marker + " b".repeat(Math.floor((total - at) / 2));

describe("the archive: the whole text of an entry", () => {
	it("finds a marker at character 100,000 of one argument and reads it back", async () => {
		const content = big("DEEPMARKERQUUX", 100_000, 120_000);
		const huge = entry("big1", "assistant", "writing", { toolCalls: [{ id: "c", name: "write", args: { path: "a.ts", content } }] });
		const archive = archiveOf([entry("u1", "user", "write the file"), huge, entry("r1", "assistant", "done")]);
		const found = await archive.search({ query: "DEEPMARKERQUUX" });
		assert.deepEqual(found.hits, ["big1"]);
		const hint = /history_read id=big1 offset=(\d+)/.exec(found.text);
		assert.ok(hint, "the hit says where to read");
		const page = await archive.read({ id: "big1", offset: Number(hint[1]), maxChars: 500 });
		assert.match(page.text, /DEEPMARKERQUUX/);
		assert.equal(await readAll(archive, "big1", 60_000), whole(huge), "the pages put together are the whole rendering");
		assert.match(whole(huge), /DEEPMARKERQUUX/);
	});

	it("pages a giant entry without walking the rest of its rendering", async () => {
		let touched = 0;
		const items = new Proxy(Array.from({ length: 200_000 }, (_, i) => "item-" + i), {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) touched++;
				return Reflect.get(target, key, receiver);
			},
		});
		const huge = entry("giant", "assistant", "", { toolCalls: [{ id: "c", name: "write", args: { items } }] });
		const archive = openArchive(entryItems([huge]), { chunk: 1_000, scanChars: 10_000, scanEntries: 10 });
		const page = await archive.read({ id: "giant", maxChars: 500 });
		assert.ok(page.next !== undefined && page.next <= 500);
		assert.ok(touched < 200, "read " + touched + " elements for a page of 500 characters");
		touched = 0;
		const found = await archive.search({ query: "item-3" });
		assert.ok(touched < 5_000, "searched " + touched + " elements within a bound of 10,000 characters");
		assert.ok(found.cursor, "the search hands out a cursor for the rest");
		touched = 0;
		await archive.read({ id: "giant", offset: 400_000, maxChars: 500 });
		assert.ok(touched < 100_000, "skipping to an offset walks pieces without building them");
	});

	it("renders the same text as JSON.stringify and splits no piece mid-pair", () => {
		const args = { a: "😀".repeat(5_000), n: [1, null, undefined, "x"], nested: { s: 'quote"\n', big: 12n, skip: undefined } };
		const lazy = [...jsonPieces({ ...args, nested: { s: 'quote"\n', skip: undefined } })].map((piece) => piece.text).join("");
		assert.equal(lazy, JSON.stringify({ ...args, nested: { s: 'quote"\n', skip: undefined } }));
		for (const piece of jsonPieces(args)) assert.equal(hasLoneSurrogate(piece.text), false);
	});
});

describe("the archive: work per page", () => {
	const countingValues = (length: number, onRead: () => void) =>
		new Proxy(Array.from({ length }, () => "abcdefghijklmnopqrstuvwxyz"), {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) onRead();
				return Reflect.get(target, key, receiver);
			},
		});
	const giantOf = (values: unknown) =>
		entry("giant", "assistant", "", { toolCalls: [{ id: "call", name: "write", args: { values } }] });

	it("costs a late continuation about what the first page costs", async () => {
		let visited = 0;
		const archive = openArchive(entryItems([giantOf(countingValues(10_000, () => visited++))]), { chunk: 1_000, scanChars: 10_000 });
		const work: number[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page++) {
			visited = 0;
			const answer = await archive.search({ query: "absent", ...(cursor ? { cursor } : {}) });
			work.push(visited);
			cursor = answer.cursor;
			assert.ok(cursor, "page " + page + " has an older rest");
		}
		const first = work[0] as number;
		assert.ok(Math.max(...work) <= first * 2 + 50, "elements visited per page: " + work.join(", "));
	});

	it("stops promptly when the signal aborts in the middle of rendering", async () => {
		const control = new AbortController();
		let afterAbort = 0;
		let armed = false;
		const values = countingValues(10_000, () => {
			if (!armed) return;
			if (!control.signal.aborted) control.abort();
			else afterAbort++;
		});
		const archive = openArchive(entryItems([giantOf(values)]), { chunk: 1_000, scanChars: 10_000 });
		let cursor: string | undefined;
		for (let page = 0; page < 15; page++) cursor = (await archive.search({ query: "absent", ...(cursor ? { cursor } : {}) })).cursor;
		armed = true;
		await assert.rejects(archive.search({ query: "absent", cursor }, control.signal), (error: Error) => error.name === "AbortError");
		assert.ok(afterAbort < 200, "elements read after the abort: " + afterAbort);
	});

	it("reads a short page of a wide object without enumerating it", async () => {
		let descriptors = 0;
		const wide = new Proxy(Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => ["key" + i, "value"])), {
			getOwnPropertyDescriptor(target, key) {
				descriptors++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		const archive = openArchive(entryItems([giantOf(wide)]));
		const page = await archive.read({ id: "giant", maxChars: 500 });
		assert.ok(page.next !== undefined);
		assert.ok(descriptors < 200, "property descriptors read for a page of 500 characters: " + descriptors);
	});

	it("lists the keys of a wide object once, however many pages stay inside its first field", async () => {
		const width = 100_000;
		let listed = 0;
		const wide = new Proxy({ first: "padding ".repeat(20_000), ...Object.fromEntries(Array.from({ length: width }, (_, i) => ["k" + i, "value"])) }, {
			ownKeys(target) {
				const keys = Reflect.ownKeys(target);
				listed += keys.length;
				return keys;
			},
		});
		const archive = openArchive(entryItems([giantOf(wide)]), { chunk: 1_000, scanChars: 2_000 });
		await archive.read({ id: "giant", maxChars: 500 });
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const answer = await archive.search({ query: "needle", ...(cursor ? { cursor } : {}) });
			cursor = answer.cursor;
			assert.ok(cursor, "page " + page + " stays inside the first field and has more");
		}
		await archive.read({ id: "giant", offset: 100, maxChars: 500 });
		assert.ok(listed <= width + 1, "keys listed by a read and three search pages: " + listed);
	});
});

describe("the archive: resuming a rendering", () => {
	const nested = {
		list: Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? { k: "v".repeat(5_000 + i), n: [i, null, undefined, "x"] } : i % 3 === 1 ? "s".repeat(9_000) : i)),
		gap: { skip: undefined, drop: () => 1, keep: [[], {}, [[1]]] },
		tail: "end",
	};
	const rich = entry("rich", "assistant", "text", {
		toolCalls: [
			{ id: "c1", name: "write", args: nested },
			{ id: "c2", name: TOOLS.historySearch.name, args: nested },
			{ id: "c3", name: "read", args: "plain" },
		],
	});

	it("renders from the mark of any piece exactly the rest of the rendering", () => {
		for (const hidden of [undefined, (name: string) => name === TOOLS.historySearch.name]) {
			const pieces = [...renderPieces(rich, hidden)];
			const reference = pieces.map((piece) => piece.text).join("");
			let offset = 0;
			for (const [at, piece] of pieces.entries()) {
				const rest = [...renderPieces(rich, hidden, piece)].map((one) => one.text).join("");
				assert.equal(rest, reference.slice(offset), "from piece " + at + " of " + pieces.length);
				offset += piece.text.length;
			}
		}
	});

	it("rejects a mark that points into something else", () => {
		assert.throws(() => [...renderPieces(rich, undefined, { part: 99, json: [] })], /not in the entry/);
		assert.throws(() => [...renderPieces(rich, undefined, { part: 0, json: [{ a: 1, c: 0 }] })], /not in the entry/);
	});

	it("finds a marker deep in nested arguments across cursor pages, as a single page does", async () => {
		const marked = { head: "a ".repeat(3_000), rows: Array.from({ length: 200 }, (_, i) => ({ id: i, body: "b ".repeat(300) + (i === 150 ? "DEEPNESTEDQUUX" : ""), alt: { z: ["c ".repeat(100)] } })) };
		const giant = entry("nest", "assistant", "", { toolCalls: [{ id: "c", name: "write", args: marked }] });
		const items = entryItems([entry("u", "user", "go"), giant]);
		const one = await openArchive(items).search({ query: "DEEPNESTEDQUUX" });
		assert.deepEqual(one.hits, ["nest"]);
		const paged = openArchive(items, { chunk: 500, scanChars: 2_000, scanEntries: 10 });
		let cursor: string | undefined;
		let pages = 0;
		const hits: string[] = [];
		do {
			const page = await paged.search({ query: "DEEPNESTEDQUUX", ...(cursor ? { cursor } : {}) });
			hits.push(...page.hits);
			cursor = page.cursor;
			pages++;
		} while (cursor && pages < 1_000);
		assert.deepEqual(hits, ["nest"]);
		assert.ok(pages > 20, "the entry took " + pages + " pages");
		const hint = /offset=(\d+)/.exec(one.text);
		assert.match((await paged.read({ id: "nest", offset: Number(hint?.[1]), maxChars: 400 })).text, /DEEPNESTEDQUUX/);
	});

	it("continues a search through arguments nested deeper than the old cursor allowed, to a late keyword", async () => {
		for (const depth of [70, 1_500]) {
			let args: unknown = "a ".repeat(2_520_000) + "LATEDEEPQUUX";
			for (let level = 0; level < depth; level++) args = { next: args };
			const giant = entry("deep", "assistant", "", { toolCalls: [{ id: "c", name: "write", args }] });
			const archive = openArchive(entryItems([entry("u", "user", "go"), giant]));
			let cursor: string | undefined;
			const hits: string[] = [];
			let pages = 0;
			do {
				const page = await archive.search({ query: "LATEDEEPQUUX", ...(cursor ? { cursor } : {}) });
				hits.push(...page.hits);
				cursor = page.cursor;
				pages++;
			} while (cursor && pages < 10);
			assert.deepEqual(hits, ["deep"], "depth " + depth);
			assert.ok(pages >= 2, "depth " + depth + " took " + pages + " pages");
		}
	});

	it("refuses a cursor far larger than any search hands out", async () => {
		const giant = entry("g", "tool", "w ".repeat(10_000), { toolName: "bash" });
		const archive = openArchive(entryItems([giant]), { chunk: 500, scanChars: 500, scanEntries: 10 });
		const first = await archive.search({ query: "w" });
		assert.ok(first.cursor);
		const forged = JSON.parse(Buffer.from(first.cursor, "base64url").toString());
		forged.anchor = { offset: 0, part: 0, json: Array.from({ length: 200_000 }, () => ({ a: 0, c: 0 })) };
		const cursor = Buffer.from(JSON.stringify(forged)).toString("base64url");
		await assert.rejects(archive.search({ query: "w", cursor }), /not one this tool returned/);
	});

	it("refuses a cursor whose place is not in the entry", async () => {
		const giant = entry("g", "tool", "w ".repeat(10_000), { toolName: "bash" });
		const archive = openArchive(entryItems([giant]), { chunk: 500, scanChars: 500, scanEntries: 10 });
		const first = await archive.search({ query: "w" });
		assert.ok(first.cursor);
		const forged = JSON.parse(Buffer.from(first.cursor, "base64url").toString());
		forged.anchor = { offset: 0, part: 0, json: [{ a: 3, c: 0 }] };
		const cursor = Buffer.from(JSON.stringify(forged)).toString("base64url");
		await assert.rejects(archive.search({ query: "w", cursor }), /not in the entry/);
		forged.anchor = { offset: 0, part: 0, json: [{ bad: true }] };
		await assert.rejects(archive.search({ query: "w", cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") }), /not one this tool returned/);
	});
});

describe("the archive: Unicode boundaries", () => {
	const emoji = entry("e1", "assistant", "α😀".repeat(40) + "end 𝒳𝒴𝒵");

	it("never splits a surrogate pair, whatever the budget, and the chunks put together are the rendering", () => {
		const reference = whole(emoji);
		for (const budget of [2, 3, 4, 5, 7, 8, 9, 31]) {
			const chunks = [...renderChunks(emoji, budget)];
			assert.equal(chunks.map((chunk) => chunk.text).join(""), reference, "budget " + budget);
			let at = 0;
			for (const chunk of chunks) {
				assert.equal(chunk.offset, at);
				assert.ok(chunk.text.length <= budget);
				assert.equal(hasLoneSurrogate(chunk.text), false, "budget " + budget + " at " + chunk.offset);
				at += chunk.text.length;
			}
		}
	});

	it("moves an offset in the middle of a pair back to the pair and pages read whole", async () => {
		const reference = whole(emoji);
		const middle = reference.indexOf("😀") + 1;
		const [chunk] = [...chunkPieces([{ text: reference, part: 0, json: [] }], 5, middle)];
		assert.equal(chunk?.offset, middle - 1);
		assert.equal(chunk?.text.startsWith("😀"), true);
		const archive = archiveOf([emoji]);
		const page = await archive.read({ id: "e1", offset: middle, maxChars: 1 });
		assert.equal(hasLoneSurrogate(page.text), false);
		for (const size of [1, 2, 3, 50]) assert.equal(await readAll(archive, "e1", size), reference, "page size " + size);
	});

	it("finds a word on either side of a chunk boundary", async () => {
		const text = "😀".repeat(30) + " boundaryword " + "😀".repeat(30);
		const archive = openArchive(entryItems([entry("e2", "user", text)]), { chunk: 41, scanChars: 10_000, scanEntries: 10 });
		assert.deepEqual((await archive.search({ query: "boundaryword" })).hits, ["e2"]);
	});
});

describe("the archive: ids", () => {
	const archive = archiveOf([
		entry("abcd1111", "user", "first"),
		entry("abcd2222", "user", "second"),
		entry("abcd", "user", "short id"),
		entry("xyz98765", "user", "third"),
	]);

	it("resolves ambiguous prefixes by listing the candidates, never by guessing", async () => {
		assert.equal((await archive.read({ id: "abcd1" })).id, "abcd1111", "a unique prefix resolves");
		const two = archiveOf([entry("abcd1111", "user", "first"), entry("abcd2222", "user", "second")]);
		await assert.rejects(two.read({ id: "abcd" }), /ambiguous.*#abcd1111.*#abcd2222/);
		await assert.rejects(two.read({ id: "abc" }), /No entry #abc/, "a prefix needs four characters");
		assert.equal((await archive.read({ id: "abcd" })).id, "abcd", "an exact id wins over longer ids it prefixes");
		assert.equal((await archive.read({ id: "#xyz9" })).id, "xyz98765");
		await assert.rejects(archive.read({ id: "#nope" }), /No entry #nope/);
	});

	it("resolves #id references in a query to the entries the archive holds", async () => {
		const found = await archive.search({ query: "what did #xyz98765 and #abcd1111 say #nowhere" });
		assert.deepEqual(found.hits, ["xyz98765", "abcd1111"]);
		assert.deepEqual((await archive.search({ query: "xyz98765" })).hits, [], "a bare id is a keyword, not a reference");
		assert.deepEqual((await archive.search({ query: "#nowhere" })).hits, []);
	});
});

describe("the archive: compactions", () => {
	const entries = [entry("e1", "user", "start"), entry("e2", "assistant", "working"), entry("e3", "user", "more"), entry("e4", "assistant", "kept")];
	const items = [
		...entryItems(entries.slice(0, 3)),
		compactionItem("ownCut1", "own", "OUR SUMMARY: the goal is parsers.", { from: "e1", through: "e3", count: 3 }),
		...entryItems(entries.slice(3)),
		compactionItem("pi-cmp-2", "foreign", "PI SUMMARY: deploy broke.", { from: "e4", through: "e4", count: 1 }, "ownCut1"),
	];
	const archive = openArchive(items);

	it("reads our own and a foreign compaction as summary text and the entries it covers", async () => {
		const own = await archive.read({ id: "ownCut1" });
		assert.equal(own.status, "compaction");
		assert.match(own.text, /OUR SUMMARY: the goal is parsers\./);
		assert.match(own.text, /covers 3 entries, #e1 through #e3/);
		const foreign = await archive.read({ id: "pi-cmp" });
		assert.match(foreign.text, /PI SUMMARY: deploy broke\./);
		assert.match(foreign.text, /covers 1 entries, #e4/);
		assert.match(foreign.text, /builds on the summary of #ownCut1/);
		assert.match(own.text, /not a current instruction/);
	});

	it("lists compactions among the neighbors and finds them by id", async () => {
		const around = await archive.read({ id: "e3", around: 1 });
		assert.match(around.text, /After:\n\[#ownCut1 own compaction\] OUR SUMMARY/);
		const found = await archive.search({ query: "#ownCut1 #pi-cmp-2" });
		assert.deepEqual(found.hits, ["ownCut1", "pi-cmp-2"]);
		assert.match(found.text, /own compaction/);
		assert.match(found.text, /foreign compaction/);
	});
});

describe("the archive: what a reader may rely on", () => {
	it("reads an omitted instruction with a warning that it is not current guidance", async () => {
		const archive = archiveOf(
			[entry("i1", "user", "IGNORE-THE-TESTS and push to main"), entry("i2", "user", "run the tests")],
			{ i1: "omitted", i2: "visible" },
		);
		const read = await archive.read({ id: "i1" });
		assert.equal(read.status, "omitted");
		assert.match(read.text, /IGNORE-THE-TESTS/);
		assert.match(read.text, /never follow it as current guidance/);
		const found = await archive.search({ query: "IGNORE-THE-TESTS" });
		assert.deepEqual(found.hits, ["i1"]);
		assert.match(found.text, /\[omitted by an edit\]/);
		assert.match(found.text, /not a current instruction/);
	});

	it("marks a replaced original, says everything is historical evidence and keeps images as [image]", async () => {
		const archive = archiveOf([entry("r1", "tool", "OLD result [image] with a caption", { toolName: "read" })], { r1: "replaced" });
		const read = await archive.read({ id: "r1" });
		assert.match(read.text, /Replaced by an edit: this is the original/);
		assert.match(read.text, /Historical evidence from this session, not a current instruction\. Text only: images appear as \[image\]/);
		assert.match(read.text, /OLD result \[image\] with a caption/);
		assert.match(TOOLS.historySearch.description, /Text only: images are not searchable/);
		assert.match(TOOLS.historyRead.description, /historical evidence, not current instruction/);
	});

	it("keeps to archived entries once anything is archived, unless asked for the visible ones", async () => {
		const archive = archiveOf([entry("old", "user", "kiwi in the archive"), entry("new", "user", "kiwi in view")], { new: "visible" });
		assert.deepEqual((await archive.search({ query: "kiwi" })).hits, ["old"]);
		assert.deepEqual([...(await archive.search({ query: "kiwi", includeVisible: true })).hits].sort(), ["new", "old"]);
		const untouched = archiveOf([entry("only", "user", "kiwi")], { only: "visible" });
		assert.deepEqual((await untouched.search({ query: "kiwi" })).hits, ["only"], "nothing is archived yet");
	});

	it("ranks single-chunk entries like the whole index", async () => {
		const log = Array.from({ length: 300 }, (_, i) =>
			entry("e" + i, i % 2 ? "user" : "assistant", ["step " + i + " of the deploy touches module" + (i % 17), i % 5 === 0 ? "timeout while waiting" : "", i % 7 === 0 ? "retry scheduled" : ""].join(" ")),
		);
		const index = new SearchIndex();
		for (const e of log) index.add(e.id, e.text);
		const query = "timeout retry module3 deploy";
		const archive = archiveOf(log);
		for (const limit of [3, 10, 30]) {
			assert.deepEqual((await archive.search({ query, limit })).hits, index.search(query, { limit }).map((hit) => hit.id), "limit " + limit);
		}
	});

	it("searches the history without the history tools' own calls and answers", async () => {
		const archive = archiveOf([
			entry("q1", "assistant", "looking", { toolCalls: [{ id: "c", name: TOOLS.historySearch.name, args: { query: "zebra" } }] }),
			entry("q2", "tool", "No matches for zebra", { toolName: TOOLS.historySearch.name }),
			entry("q3", "user", "zebra crossing"),
		]);
		assert.deepEqual((await archive.search({ query: "zebra" })).hits, ["q3"]);
	});

	it("reads an entry with neighbors and in pages that name the next one", async () => {
		const archive = archiveOf([entry("n1", "user", "before"), entry("long0001", "tool", "z".repeat(1_500), { toolName: "bash" }), entry("n3", "user", "after")]);
		const first = await archive.read({ id: "long", around: 1, maxChars: 500 });
		assert.match(first.text, /^Before:\n\[#n1 user\] before/);
		assert.match(first.text, /\[more: history_read id=long0001 offset=500\]/);
		assert.match(first.text, /After:\n\[#n3 user\] after/);
		assert.equal(first.next, 500);
		const last = await archive.read({ id: "long0001", offset: 1_500, maxChars: 500 });
		assert.equal(last.next, undefined);
		assert.doesNotMatch(last.text, /\[more:/);
	});
});

describe("the archive: bounds, cursors and the branch", () => {
	/** Twelve entries of 30,000 characters, a needle in the middle of each. */
	const long = Array.from({ length: 12 }, (_, i) => entry("L" + i, "tool", "p ".repeat(7_500) + "needle" + i + " q ".repeat(2_500), { toolName: "bash" }));
	const tuned = (entries: readonly LogEntry[], tuning = { chunk: 1_000, scanChars: 20_000, scanEntries: 100 }) => openArchive(entryItems(entries), tuning);

	async function pagesOf(archive: ArchiveReader, request: { query: string; limit?: number }) {
		const pages = [];
		let cursor: string | undefined;
		do {
			assert.ok(pages.length < 500, "the search ends");
			const page = await archive.search({ ...request, ...(cursor ? { cursor } : {}) });
			pages.push(page);
			cursor = page.cursor;
		} while (cursor);
		return pages;
	}

	it("bounds a page by characters of work, makes progress and skips no region on the way back", async () => {
		const archive = tuned(long);
		const pages = await pagesOf(archive, { query: "needle3 needle7 needle11 needle0" });
		assert.ok(pages.length > 10, "work is bounded by characters, not entries: " + pages.length + " pages for 12 entries");
		assert.ok(pages.every((page) => page.scanned <= 2), "a page of 20,000 characters touches at most two of these entries");
		const found = new Set(pages.flatMap((page) => page.hits));
		assert.deepEqual([...found].sort(), ["L0", "L11", "L3", "L7"], "every needle is found once on the way back");
		assert.equal(new Set(pages.map((page) => page.cursor)).size, pages.length, "no cursor repeats");
	});

	it("covers the middle of a single giant entry across pages", async () => {
		const giant = entry("G", "tool", "w ".repeat(100_000) + "middleneedle" + " w".repeat(100_000), { toolName: "bash" });
		const pages = await pagesOf(tuned([giant]), { query: "middleneedle" });
		assert.ok(pages.length >= 10);
		assert.deepEqual(pages.flatMap((page) => page.hits), ["G"]);
	});

	it("makes progress even when one chunk exceeds every bound", async () => {
		const archive = openArchive(entryItems(long.slice(0, 3)), { chunk: 1_000, scanChars: 1, scanEntries: 1 });
		const pages = await pagesOf(archive, { query: "needle1" });
		assert.deepEqual(pages.flatMap((page) => page.hits), ["L1"]);
	});

	it("continues a search after a summary and a telemetry entry were appended, and says what is new", async () => {
		const items = entryItems(long.slice(0, 4));
		const first = await openArchive(items, { chunk: 1_000, scanChars: 20_000, scanEntries: 100 }).search({ query: "needle0" });
		assert.ok(first.cursor);
		const later = openArchive(
			[...items, compactionItem("sum1", "own", "summary text"), ...entryItems([entry("T1", "user", "needle0 newer")])],
			{ chunk: 1_000, scanChars: 20_000, scanEntries: 100 },
		);
		const next = await later.search({ query: "needle0", cursor: first.cursor });
		assert.equal(next.newer, 1, "the entry, not the summary, is new");
		assert.match(next.text, /1 newer entry was added since this search began/);
		assert.ok(!next.hits.includes("T1"), "the search stays on the snapshot it began on");
		const summaryOnly = openArchive([...items, compactionItem("sum1", "own", "summary text")], { chunk: 1_000, scanChars: 20_000, scanEntries: 100 });
		const quiet = await summaryOnly.search({ query: "needle0", cursor: first.cursor });
		assert.equal(quiet.newer, 0);
		assert.doesNotMatch(quiet.text, /newer/);
	});

	it("does not count a search result appended to the history as new, nor find it", async () => {
		const items = entryItems([...long.slice(0, 3), entry("u1", "user", "kiwi pie")]);
		const tuning = { chunk: 1_000, scanChars: 20_000, scanEntries: 100 };
		const first = await openArchive(items, tuning).search({ query: "kiwi" });
		assert.deepEqual(first.hits, ["u1"]);
		const persisted = entry("p1", "tool", first.text, { toolName: TOOLS.historySearch.name });
		const call = entry("p0", "assistant", "", { toolCalls: [{ id: "c", name: TOOLS.historySearch.name, args: { query: "kiwi" } }] });
		const later = openArchive([...items, ...entryItems([call, persisted])], tuning);
		assert.deepEqual((await later.search({ query: "kiwi" })).hits, ["u1"], "the persisted result does not find itself");
		const cursorFirst = await openArchive(items, tuning).search({ query: "needle0 needle1" });
		assert.ok(cursorFirst.cursor);
		const again = await later.search({ query: "needle0 needle1", cursor: cursorFirst.cursor });
		assert.equal(again.newer, 1, "the call counts, the history tool's answer does not");
	});

	it("rejects a cursor when the branch changed under it", async () => {
		const tuning = { chunk: 1_000, scanChars: 20_000, scanEntries: 100 };
		const first = await openArchive(entryItems(long), tuning).search({ query: "needle1" });
		assert.ok(first.cursor);
		const rewound = openArchive(entryItems([...long.slice(0, 11), entry("other", "user", "a different branch")]), tuning);
		await assert.rejects(rewound.search({ query: "needle1", cursor: first.cursor }), /branch changed/);
		const cut = openArchive(entryItems(long.slice(0, 5)), tuning);
		await assert.rejects(cut.search({ query: "needle1", cursor: first.cursor }), /branch changed/);
		await assert.rejects(rewound.search({ query: "x", cursor: "not-a-cursor" }), /not one this tool returned/);
	});

	it("honors cancellation before and during a search and before a read", async () => {
		const many = Array.from({ length: 400 }, (_, i) => entry("m" + i, "tool", ("word" + i + " ").repeat(400), { toolName: "bash" }));
		const archive = openArchive(entryItems(many), { chunk: 500, scanChars: 10_000_000, scanEntries: 10_000 });
		const before = new AbortController();
		before.abort();
		await assert.rejects(archive.search({ query: "word7" }, before.signal), (error: Error) => error.name === "AbortError");
		await assert.rejects(archive.read({ id: "m1" }, before.signal), (error: Error) => error.name === "AbortError");
		const during = new AbortController();
		setTimeout(() => during.abort(), 0);
		await assert.rejects(archive.search({ query: "word7" }, during.signal), (error: Error) => error.name === "AbortError");
	});
});
