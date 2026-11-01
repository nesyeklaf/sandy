import { describe, expect, it } from "vitest";
import { formatRetrievalReport, reduceRetrieval, retrievalEvents } from "../src/core/retrieval.ts";
import { assistant, compaction, type RawEntry, retrieval, toolCall, toolResult, user } from "./support/accounting.ts";

const report = (entries: RawEntry[], needed?: string[]) => reduceRetrieval(retrievalEvents(entries), needed ? { needed: new Set(needed) } : undefined);

const search = (call: string, hits: string[]): RawEntry[] => [toolCall(call, "history_search", { query: "q" }), toolResult(call, "history_search", { hits })];
const read = (call: string, id: string): RawEntry[] => [toolCall(call, "history_read", { id }), toolResult(call, "history_read")];
const file = (call: string, path: string): RawEntry[] => [toolCall(call, "read", { path }), toolResult(call, "read")];
const nested = (call: string, tool: string, data: Record<string, unknown>) => retrieval({ call, parent: call.split("/")[0], tool, ...data });
/** A request that spent `fresh` new tokens. */
const turn = (fresh: number) => assistant(0, { input: fresh, output: 0, cacheRead: 5_000 });

describe("the retrieval report of a session", () => {
	it("counts re-reads of files read before the latest cut, top level and inside codemode", () => {
		const r = report([
			...file("r1", "a.ts"),
			...file("r2", "b.ts"),
			compaction({ ours: true }),
			...file("r3", "a.ts"),
			nested("r4/1", "read", { path: "b.ts" }),
			...file("r5", "c.ts"),
		]);
		expect(r.fileReads).toBe(5);
		expect(r.rereads).toBe(2);
		expect(r.rereadsNested).toBe(1);
	});

	it("counts a nested call once, whether its record or its parent's result tells of it", () => {
		const r = report([...file("r1", "a.ts"), ...file("r1", "a.ts"), compaction({ ours: true }), nested("r2/1", "read", { path: "a.ts" }), nested("r2/1", "read", { path: "a.ts" })]);
		expect(r.fileReads).toBe(2);
		expect(r.rereads).toBe(1);
	});

	it("separates a search that found something from a search that found the entry that was needed", () => {
		const entries = [
			compaction({ ours: true }),
			...search("s1", ["e1", "e2"]),
			...search("s2", []),
			...search("s3", ["e3"]),
			...read("h1", "e3"),
		];
		const labelled = report(entries, ["e3"]);
		expect(labelled.basis).toBe("labelled");
		expect(labelled.searches).toMatchObject({ total: 3, withHits: 2, relevant: 1 });
		const live = report(entries);
		expect(live.basis).toBe("proxy");
		expect(live.searches).toMatchObject({ total: 3, withHits: 2, relevant: 1 });
	});

	it("takes ten irrelevant search hits as no recovered context", () => {
		const ids = Array.from({ length: 10 }, (_, i) => "n" + i);
		const entries = [compaction({ ours: true }), turn(100), ...search("s1", ids), turn(100)];
		for (const r of [report(entries), report(entries, ["needed"])]) {
			expect(r.searches).toMatchObject({ total: 1, withHits: 1, relevant: 0 });
			expect(r.episodes).toHaveLength(1);
			expect(r.episodes[0]).toMatchObject({ searches: 1, relevantRead: false });
			expect(r.episodes[0]?.tokensToFirstRelevantRead).toBeUndefined();
			expect(r.recovered).toBe(0);
		}
	});

	it("in a live session counts a hit only when the same entry is read within the next two turns", () => {
		const entries = [
			compaction({ ours: true }),
			...search("s1", ["e1"]),
			turn(1),
			turn(1),
			turn(1),
			...read("h1", "e1"), // three turns later: too late
			...search("s2", ["e2"]),
			turn(1),
			...read("h2", "e2"), // one turn later
		];
		const r = report(entries);
		expect(r.searches).toMatchObject({ total: 2, withHits: 2, relevant: 1 });
	});

	it("measures the fresh tokens spent from the cut to the first relevant read, per episode", () => {
		const entries = [
			compaction({ ours: true }),
			turn(100),
			turn(50),
			...search("s1", ["x1"]),
			...read("h1", "x1"), // relevant (labelled)
			turn(1_000), // after the first relevant read: not counted
			compaction({ ours: true }),
			turn(30),
			...search("s2", ["y9"]),
			turn(10),
			compaction({ ours: true }),
			turn(7),
			nested("n1/1", "history_read", { ids: ["z1"] }),
		];
		const r = report(entries, ["x1", "z1"]);
		expect(r.episodes.map((e) => e.tokensToFirstRelevantRead)).toEqual([150, undefined, 7]);
		expect(r.episodes.map((e) => ({ searches: e.searches, reads: e.reads }))).toEqual([
			{ searches: 1, reads: 1 },
			{ searches: 1, reads: 0 },
			{ searches: 0, reads: 1 },
		]);
		expect(r.recovered).toBe(2);
	});

	it("counts a read inside codemode as a read of that entry", () => {
		const r = report([compaction({ ours: true }), nested("c1/1", "history_search", { ids: ["e1"] }), nested("c1/2", "history_read", { ids: ["e1"] })]);
		expect(r.searches).toMatchObject({ total: 1, withHits: 1, relevant: 1 });
		expect(r.entryReads).toBe(1);
		expect(r.entryReadsNested).toBe(1);
	});

	it("reports no episodes for a session that was never cut", () => {
		const r = report([user(), ...file("r1", "a.ts"), ...search("s1", ["e1"])]);
		expect(r.episodes).toEqual([]);
		expect(r.rereads).toBe(0);
	});

	it("formats the report with its basis named", () => {
		expect(formatRetrievalReport(report([compaction({ ours: true }), ...search("s1", ["e1"])])).join("\n")).toMatch(/proxy/i);
		expect(formatRetrievalReport(report([compaction({ ours: true })], ["e1"])).join("\n")).toMatch(/labelled/i);
	});
});

describe("the retrieval report across branches, failures and resolved ids", () => {
	/** The entries as one chain under `parent`, each a child of the one before, as pi links them. */
	const chain = (parent: string | null, ...entries: RawEntry[][]): RawEntry[] => {
		let at = parent;
		return entries.flat().map((entry) => {
			const linked = { ...entry, parentId: at };
			at = entry.id as string;
			return linked;
		});
	};
	const idOf = (entries: RawEntry[]) => (entries.at(-1) as RawEntry).id as string;
	const failed = (entry: RawEntry): RawEntry => ({ ...entry, message: { ...(entry.message as object), isError: true } });

	it("does not credit a search on one branch to a read on its sibling", () => {
		const root = chain(null, [user()], [compaction({ ours: true })]);
		const left = chain(idOf(root), search("s1", ["need"]));
		const right = chain(idOf(root), [turn(10)], read("h1", "need"));
		const r = report([...root, ...left, ...right]);
		expect(r.searches).toMatchObject({ total: 1, withHits: 1, relevant: 0 });
		expect(r.recovered).toBe(0);
		expect(r.episodes).toEqual([{ searches: 1, reads: 1, relevantRead: false, tokensToFirstRelevantRead: undefined }]);
	});

	it("credits a search to a read after it on the same branch, and a branch's cut to that branch only", () => {
		const root = chain(null, [user()], file("r1", "a.ts"));
		const cut = chain(idOf(root), [compaction({ ours: true })], search("s1", ["need"]), read("h1", "need"));
		const uncut = chain(idOf(root), file("r2", "a.ts"));
		const r = report([...root, ...cut, ...uncut]);
		expect(r.searches.relevant).toBe(1);
		expect(r.recovered).toBe(1);
		expect(r.rereads).toBe(0);
	});

	it("counts a re-read only of a file the cut archived, not one it kept", () => {
		const archived = file("r1", "archived.ts");
		const kept = file("r2", "kept.ts");
		const cut = { ...compaction({ ours: true }), firstKeptEntryId: kept[0]?.id };
		const r = report([...archived, ...kept, cut, ...file("r3", "kept.ts"), ...file("r4", "archived.ts")]);
		expect(r.fileReads).toBe(4);
		expect(r.rereads).toBe(1);
	});

	it("counts a read for the entry the archive resolved, not the prefix the model typed", () => {
		const resolved = [toolCall("h1", "history_read", { id: "#ab12" }), toolResult("h1", "history_read", { id: "ab12cd34" })];
		const r = report([compaction({ ours: true }), ...search("s1", ["ab12cd34"]), ...resolved], ["ab12cd34"]);
		expect(r.recovered).toBe(1);
		const proxy = report([compaction({ ours: true }), ...search("s1", ["ab12cd34"]), ...resolved]);
		expect(proxy.searches.relevant).toBe(1);
	});

	it("counts a failed read apart, neither as a read nor as recovery", () => {
		const failedRead = [toolCall("h1", "history_read", { id: "need" }), failed(toolResult("h1", "history_read"))];
		const failedFile = [toolCall("r2", "read", { path: "a.ts" }), failed(toolResult("r2", "read"))];
		const r = report([...file("r1", "a.ts"), compaction({ ours: true }), ...search("s1", ["need"]), ...failedRead, ...failedFile, nested("c1/1", "history_read", { ids: ["need"], failed: true })]);
		expect(r).toMatchObject({ entryReads: 0, fileReads: 1, rereads: 0, failedReads: 3, recovered: 0, searches: { relevant: 0 } });
		expect(formatRetrievalReport(r)[1]).toContain("3 failed reads not counted");
	});

	it("reads a long session in time linear in its calls", () => {
		const build = (pairs: number): RawEntry[] => {
			const entries: RawEntry[] = [compaction({ ours: true })];
			for (let i = 0; i < pairs; i++) entries.push(...search(`s${i}`, [`hit${i}`, "common"]), turn(1), ...read(`h${i}`, i % 2 === 0 ? `hit${i}` : "common"));
			// Linked as pi links them: one deep branch.
			return chain(null, entries);
		};
		// Timed against a quarter of the session: linear work grows four times, the old quadratic matching sixteen.
		const timed = (pairs: number) => {
			const entries = build(pairs);
			const started = performance.now();
			const r = report(entries);
			return { r, took: performance.now() - started };
		};
		timed(2_000);
		const small = timed(5_000);
		const large = timed(20_000);
		expect(large.r.entryReads).toBe(20_000);
		expect(large.r.searches.relevant).toBe(20_000);
		expect(large.took / Math.max(small.took, 1)).toBeLessThan(8);
		expect(large.took).toBeLessThan(5_000);
	});
});
