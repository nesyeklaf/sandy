import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	aliasText,
	canonicalCall,
	duplicatePromotions,
	duplicateReadEdits,
	promotionsFromKept,
	liveAliases,
	MIN_DUPLICATE_TOKENS,
	type ReadObservation,
	readDuplicateRecord,
	replacementDigest,
	textDigest,
} from "../src/core/duplicates.ts";
import { DUPLICATE_KIND } from "../src/core/kinds.ts";
import { decodeContextRecord } from "../src/core/records.ts";

/*
 * Identical reads kept once, as pure rules: which fresh read is replaced, which is left alone, when a note is ours, and
 * when it gets its text back.
 */

const body = (label: string) => [{ type: "text", text: label + "\n" + "x".repeat(2_000) }];
let counter = 0;
function read(over: Partial<ReadObservation> & { label?: string; args?: unknown } = {}): ReadObservation {
	const id = over.id ?? "r" + ++counter;
	const content = body(over.label ?? "same");
	return {
		id,
		toolCallId: "call-" + id,
		call: canonicalCall(over.args ?? { path: "src/a.ts" })!,
		content: textDigest(content),
		tokens: 500,
		path: "src/a.ts",
		state: "full",
		original: content,
		...over,
	};
}
const fresh = (...reads: ReadObservation[]) => new Set(reads.map((one) => one.toolCallId));

describe("which reads collapse", () => {
	it("replaces the fresh newer copy of an identical read and names the earlier one", () => {
		const older = read({ id: "old" });
		const newer = read({ id: "new" });
		const [one, ...rest] = duplicateReadEdits({ reads: [older, newer], fresh: fresh(newer) });
		assert.equal(rest.length, 0);
		assert.equal(one?.targetId, "new");
		assert.equal(one?.record.of, "old");
		assert.match(JSON.stringify(one?.replacement), /#old/);
		assert.ok(one && one.record.tokens > MIN_DUPLICATE_TOKENS && one.record.tokens < 500);
		assert.equal(one?.record.digest, replacementDigest(one?.replacement.content));
	});

	it("never replaces the older copy, nor a newer one a request has already carried", () => {
		const older = read({ id: "old" });
		const newer = read({ id: "new" });
		assert.deepEqual(duplicateReadEdits({ reads: [older, newer], fresh: fresh(older) }), []);
		assert.deepEqual(duplicateReadEdits({ reads: [older, newer], fresh: new Set() }), []);
	});

	it("keeps the first of three as the one representative: no chain of notes", () => {
		const [a, b, c] = [read({ id: "a" }), read({ id: "b" }), read({ id: "c" })] as const;
		const edits = duplicateReadEdits({ reads: [a, b, c], fresh: fresh(b, c) });
		assert.deepEqual(edits.map((one) => [one.targetId, one.record.of]), [["b", "a"], ["c", "a"]]);
	});

	it("does not collapse another range, other arguments, or changed content", () => {
		const older = read({ id: "old" });
		const range = read({ id: "range", args: { path: "src/a.ts", offset: 10, limit: 20 } });
		const other = read({ id: "other", args: { path: "src/b.ts" } });
		const changed = read({ id: "changed", label: "different" });
		const reads = [older, range, other, changed];
		assert.deepEqual(duplicateReadEdits({ reads, fresh: fresh(range, other, changed) }), []);
	});

	it("reads the same arguments written in another order or with empty values as the same call", () => {
		const older = read({ id: "old", args: { path: "src/a.ts", offset: undefined, limit: null } });
		const newer = read({ id: "new", args: { path: "src/a.ts" } });
		assert.equal(duplicateReadEdits({ reads: [older, newer], fresh: fresh(newer) }).length, 1);
		assert.equal(canonicalCall({ offset: 1, path: "p" }), canonicalCall({ path: "p", offset: 1 }));
		assert.notEqual(canonicalCall({ path: "p", offset: 1 }), canonicalCall({ path: "p" }));
	});

	it("skips results that are not whole plain text: edited by another extension, a note, or without a digest (image, error)", () => {
		const older = read({ id: "old" });
		const foreign = read({ id: "foreign", state: "foreign" });
		const image = read({ id: "image", content: undefined });
		const note = read({ id: "note", state: "alias" });
		assert.deepEqual(duplicateReadEdits({ reads: [older, foreign, image, note], fresh: fresh(foreign, image, note) }), []);
		// an edited earlier copy is no representative either
		const edited = read({ id: "edited", state: "foreign" });
		const newer = read({ id: "newer" });
		assert.deepEqual(duplicateReadEdits({ reads: [edited, newer], fresh: fresh(newer) }), []);
	});

	it("compares the whole content, not a text a block's type or a second block could change", () => {
		assert.equal(textDigest([{ type: "text", text: "a" }]), textDigest([{ type: "text", text: "a" }]));
		assert.notEqual(textDigest([{ type: "text", text: "a" }]), textDigest([{ type: "text", text: "a" }, { type: "text", text: "" }]));
		assert.equal(textDigest([{ type: "text", text: "a" }, { type: "image", data: "x" }]), undefined);
		assert.equal(textDigest("a"), undefined);
		assert.equal(textDigest([]), undefined);
	});

	it("leaves a saving too small for a note alone, and what a cut archives", () => {
		const older = read({ id: "old", tokens: 100 });
		const small = read({ id: "small", tokens: 100 });
		assert.deepEqual(duplicateReadEdits({ reads: [older, small], fresh: fresh(small) }), []);
		const newer = read({ id: "new" });
		assert.deepEqual(duplicateReadEdits({ reads: [older, newer], fresh: fresh(newer), archived: new Set(["old"]) }), []);
		assert.deepEqual(duplicateReadEdits({ reads: [older, newer], fresh: fresh(newer), archived: new Set(["new"]) }), []);
	});
});

describe("when a note is ours", () => {
	const edit = (targetId: string, text: string | null) => ({
		type: "context_edit",
		id: "e-" + targetId + "-" + String(text),
		targetId,
		replacement: text === null ? null : { content: [{ type: "text", text }] },
	});
	const record = (alias: string, text: string, of = "old") => ({
		type: "custom",
		customType: DUPLICATE_KIND,
		data: { alias, of, tokens: 400, digest: replacementDigest([{ type: "text", text }]) },
	});

	it("owns the edit its record describes", () => {
		const live = liveAliases([edit("new", "note"), record("new", "note")]);
		assert.deepEqual([...live.keys()], ["new"]);
		assert.equal(live.get("new")?.of, "old");
	});

	it("does not own an edit without a record, nor a record whose edit is not the latest", () => {
		assert.equal(liveAliases([edit("new", "note")]).size, 0);
		assert.equal(liveAliases([record("new", "note")]).size, 0);
		assert.equal(liveAliases([edit("new", "other"), record("new", "note")]).size, 0);
	});

	it("loses the note to any later edit: another extension's, an omission, or our promotion", () => {
		for (const later of [edit("new", "theirs"), edit("new", null)]) {
			assert.equal(liveAliases([edit("new", "note"), record("new", "note"), later]).size, 0);
		}
		assert.equal(liveAliases([edit("new", "note"), record("new", "note"), edit("other", "x")]).size, 1);
	});

	it("reads a record only with all its fields", () => {
		assert.ok(readDuplicateRecord({ alias: "a", of: "b", tokens: 3, digest: "d" }));
		for (const bad of [null, "x", { alias: "a" }, { alias: "a", of: "b", tokens: -1, digest: "d" }, { alias: "a", of: "b", tokens: "3", digest: "d" }]) {
			assert.equal(readDuplicateRecord(bad), undefined);
		}
		const decoded = decodeContextRecord(record("new", "note"));
		assert.equal(decoded.kind, "duplicate");
		assert.equal(decodeContextRecord({ type: "custom", customType: DUPLICATE_KIND, data: {} }).kind, "invalid");
	});

	it("keeps no content in the record", () => {
		const text = aliasText("src/a.ts", "old");
		const data = JSON.stringify(record("new", text).data);
		assert.ok(!data.includes("src/a.ts"));
	});

	it("words the note so it stays true once the earlier read has left the context, and claims no unchanged file", () => {
		const text = aliasText("src/a.ts", "old");
		assert.match(text, /^\[Same as the earlier read of src\/a\.ts/);
		assert.match(text, /history_read #old/);
		assert.match(text, /once it has left your context/);
		assert.doesNotMatch(text, /unchanged/);
	});
});

describe("when a note gets its text back", () => {
	const note = (id: string, label?: string): ReadObservation => read({ id, state: "alias", tokens: 40, ...(label ? { label } : {}) });
	const aliases = (...pairs: [string, string][]) => new Map(pairs.map(([alias, of]) => [alias, { alias, of, tokens: 400, digest: "d" }]));
	const none = new Set<string>();

	it("promotes a note whose earlier read the cut archives, to the text the tool wrote, and names what that puts back", () => {
		const older = read({ id: "old" });
		const newer = note("new");
		const [one, ...rest] = duplicatePromotions([older, newer], aliases(["new", "old"]), new Set(["old"]));
		assert.equal(rest.length, 0);
		assert.equal(one?.targetId, "new");
		assert.equal(one?.replacement.content, newer.original);
		assert.ok((one?.tokens ?? 0) > 400, "the whole text less the note: " + one?.tokens);
	});

	it("leaves a note whose earlier read stays whole, one the cut archives itself, and any entry that is not our note", () => {
		const older = read({ id: "old" });
		assert.deepEqual(duplicatePromotions([older, note("new")], aliases(["new", "old"]), none), []);
		assert.deepEqual(duplicatePromotions([older, note("new")], aliases(["new", "old"]), new Set(["old", "new"])), []);
		assert.deepEqual(duplicatePromotions([read({ id: "new", state: "foreign" })], aliases(["new", "old"]), new Set(["old"])), []);
		assert.deepEqual(duplicatePromotions([note("new")], new Map(), new Set(["old"])), []);
	});

	it("finds the promotions of a cut from the reads it keeps alone, the same as from all reads with the archived prefix", () => {
		// Alternating texts a, b with a note after each pair, and a cut that keeps from different points.
		const reads: ReadObservation[] = [];
		const records: string[][] = [];
		for (let i = 0; i < 12; i++) {
			const label = i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c";
			if (i < 3) reads.push(read({ id: "w" + i, label }));
			else {
				reads.push(note("n" + i, label));
				records.push(["n" + i, "w" + (i % 3)]);
			}
		}
		const known = aliases(...(records as [string, string][]));
		for (let from = 0; from <= reads.length; from++) {
			const kept = new Set(reads.slice(from).map((one) => one.id));
			const archived = new Set(reads.slice(0, from).map((one) => one.id));
			assert.deepEqual(promotionsFromKept(reads, known, (id) => kept.has(id)), duplicatePromotions(reads, known, archived), "keeping from read " + from);
		}
	});

	it("reads only the reads a cut keeps, however many came before them", () => {
		const touched = (older: number): number => {
			const reads = [...Array.from({ length: older }, (_, i) => read({ id: "o" + i, label: "o" + i })), read({ id: "old" }), note("new")];
			let count = 0;
			const watched = new Proxy(reads, {
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) count++;
					return Reflect.get(target, key, receiver);
				},
			});
			const kept = new Set(["new"]);
			assert.deepEqual(promotionsFromKept(watched, aliases(["new", "old"]), (id) => kept.has(id)).map((one) => one.targetId), ["new"]);
			return count;
		};
		assert.equal(touched(20_000), touched(10), "the same reads for 10 and for 20,000 older ones");
	});

	it("promotes one note per text, and none while another whole copy of that text stays", () => {
		const [first, second] = [note("n1"), note("n2")];
		const promoted = duplicatePromotions([read({ id: "old" }), first, second], aliases(["n1", "old"], ["n2", "old"]), new Set(["old"]));
		assert.deepEqual(promoted.map((one) => one.targetId), ["n1"]);
		const kept = read({ id: "kept" });
		assert.deepEqual(duplicatePromotions([read({ id: "old" }), first, kept], aliases(["n1", "old"]), new Set(["old"])), []);
	});
});
