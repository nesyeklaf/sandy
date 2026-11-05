import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ATTEMPT_KIND, CAP_SHADOW_KIND } from "../src/core/kinds.ts";
import { formatSessionsReport, measureSession, reportSessions, totals } from "../src/core/measure.ts";
import { piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";
import { assistant, attempt, compaction, ping, retrieval, toolCall, toolResult, totals as usageTotals, user, warming } from "./support/accounting.ts";

const answer = (input: number, cacheRead: number, cacheWrite: number, cost = 0.1) =>
	JSON.stringify({ type: "message", message: { role: "assistant", usage: { input, cacheRead, cacheWrite, cost: { total: cost } } } });
const cut = (reason: string | null, tag = "context") =>
	JSON.stringify({ type: "compaction", summary: reason ? `<${tag} reason="${reason}">\n…` : "Summary by pi" });

describe("measuring a session log", () => {
	it("counts prompt tokens, cache reads and cuts by reason, and leaves the cost to the cost report", () => {
		const m = measureSession([answer(10, 90, 0), cut("watermark"), answer(5, 0, 95), cut(null), "not json", ""]);
		expect(m).toEqual({ requests: 2, promptTokens: 200, cacheRead: 90, cuts: { watermark: 1, other: 1 }, taskSpans: [] });
	});

	it("counts the cuts of sessions written before the rename to context", () => {
		expect(measureSession([cut("task", "sandy-context"), cut("watermark")]).cuts).toEqual({ task: 1, watermark: 1 });
	});

	it("counts a foreign compaction that quotes a cut tag as other, not as a task cut", () => {
		const quoting = JSON.stringify({ type: "compaction", summary: 'Foreign quotes <context reason="task">quoted</context>' });
		const m = measureSession([answer(100, 0, 0), quoting, answer(30, 0, 0)]);
		expect(m.cuts).toEqual({ other: 1 });
		expect(m.taskSpans).toEqual([]);
	});

	it("splits the prompt tokens into one span per finished task", () => {
		const m = measureSession([answer(100, 0, 0), answer(50, 0, 0), cut("task"), answer(30, 0, 0), cut("task"), answer(7, 0, 0)]);
		expect(m.taskSpans).toEqual([150, 30]);
	});

	it("sums sessions with a cache hit rate", () => {
		const t = totals([measureSession([answer(10, 90, 0)]), measureSession([answer(100, 0, 0), cut("task")])]);
		expect(t).toMatchObject({ sessions: 2, requests: 2, promptTokens: 200, cacheHit: 0.45, promptPerRequest: 100, cuts: { task: 1 }, taskSpans: [100] });
	});

	describe("the one report over fixture sessions", () => {
		const lines = (...entries: unknown[]) => entries.flat().map((entry) => JSON.stringify(entry));
		const search = (call: string, hits: string[]) => [toolCall(call, "history_search", { query: "q" }), toolResult(call, "history_search", { hits })];
		const read = (call: string, id: string) => [toolCall(call, "history_read", { id }), toolResult(call, "history_read")];

		it("puts known costs, unknown charges and the three measures in one report", () => {
			const session = lines(
				user(),
				assistant(2, { input: 100 }),
				attempt("a1", "failed", usageTotals(3)),
				attempt("a2", "failed"),
				ping(),
				assistant(1),
				warming({ piAction: "stop", action: "stop", requestsSeen: true }),
				compaction({ ours: true }),
				assistant(0, { input: 40, output: 0 }),
				search("s1", ["need", "other"]),
				read("h1", "need"),
				retrieval({ call: "c9/1", parent: "c9", tool: "history_read", ids: ["other"] }),
			);
			const report = reportSessions([{ lines: session, needed: ["need"] }]);
			expect(report.cost.knownSubtotal).toBe(6);
			expect(report.cost.unknown).toBe(1);
			expect(report.cost.total).toBeUndefined();
			expect(report.cost.complete).toBe(false);
			expect(report.cost.skipped).toBe(1);
			expect(report.retrieval.labelled?.basis).toBe("labelled");
			expect(report.retrieval.labelled?.searches).toMatchObject({ total: 1, withHits: 1, relevant: 1 });
			expect(report.retrieval.labelled?.episodes[0]?.tokensToFirstRelevantRead).toBe(40);
			expect(report.retrieval.labelled?.entryReadsNested).toBe(1);
			expect(report.retrieval.proxy).toBeUndefined();
		});

		it("keeps each session's cuts and reads apart", () => {
			const a = lines(compaction({ ours: true }), search("s1", ["x"]));
			const b = lines(search("s2", ["x"]), read("h1", "x"));
			const report = reportSessions([{ lines: a }, { lines: b }]);
			expect(report.retrieval.proxy?.episodes).toHaveLength(1);
			expect(report.retrieval.proxy?.episodes[0]?.relevantRead).toBe(false);
			expect(report.retrieval.proxy?.searches).toMatchObject({ total: 2, relevant: 1 });
		});

		it("keeps the existing per-session numbers unchanged", () => {
			expect(measureSession(lines(assistant(2), assistant(3))).requests).toBe(2);
		});

		describe("the kept-history cap's shadow counters", () => {
			const shadow = (id = "cap1") => ({
				type: "custom",
				id,
				customType: CAP_SHADOW_KIND,
				data: { mode: "shadow", applied: false, reason: "watermark", cap: 24_000, cutKeptId: "k", cappedFromId: "u", entries: 1, tokens: 900, ids: ["old-entry"], paths: ["src/a.ts"], promotions: 0 },
			});
			const asked = [...read("h1", "old-entry"), toolCall("r1", "read", { path: "src/a.ts" }), toolResult("r1", "read")];
			const dirs: string[] = [];
			afterEach(() => {
				for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
			});

			it("prints the cap and needed-after-mask lines that /context prints, over all sessions", () => {
				const report = reportSessions([{ lines: lines(shadow(), ...asked) }, { lines: lines(shadow("cap2"), user()) }]);
				expect(report.cap).toMatchObject({ records: 2, removedEntries: 2, neededEntries: 1, neededFiles: 1, cutsWithNeed: 1 });
				const text = formatSessionsReport(report).join("\n");
				expect(text).toContain("Kept cap: 2 cuts planned with the cap");
				expect(text).toContain("Kept cap, needed after masking (a lower bound): 1 removed entries opened again, 1 removed files read again, after 1 of 2 cuts");
				expect(formatSessionsReport(reportSessions([{ lines: lines(user()) }])).join("\n")).toContain("Kept cap: no record in this session");
			});

			it("prints them from `npm run measure` on a session log on disk", () => {
				const dir = mkdtempSync(join(tmpdir(), "context-measure-"));
				dirs.push(dir);
				writeFileSync(join(dir, "session.jsonl"), lines(shadow(), ...asked).join("\n") + "\n");
				const tool = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "measure.ts");
				const run = spawnSync(process.execPath, ["--experimental-strip-types", tool, "7", dir], { encoding: "utf8" });
				expect(run.status, run.stderr).toBe(0);
				expect(run.stdout).toContain("Kept cap: 1 cuts planned with the cap");
				expect(run.stdout).toContain("1 removed entries opened again, 1 removed files read again, after 1 of 1 cuts");
			});
		});

		it("reads a label only in the session that has it, and reports labelled and proxy sessions apart", () => {
			// Independent sessions can reuse an entry id; the fixture's label means its own entry, not the other one's.
			const fixture = lines(search("s1", ["x", "y"]), read("h1", "y"));
			const live = lines(search("s2", ["x"]), read("h2", "x"));
			const report = reportSessions([{ lines: fixture, needed: ["x"] }, { lines: live }]);
			expect(report.retrieval.labelled).toMatchObject({ basis: "labelled", searches: { total: 1, withHits: 1, relevant: 1 } });
			expect(report.retrieval.proxy).toMatchObject({ basis: "proxy", searches: { total: 1, withHits: 1, relevant: 1 } });
		});
	});
});

describe("a session and its fork", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A real pi session file with one paid answer and one paid historian request, and a fork pi made from it. */
	function forked() {
		const dir = mkdtempSync(join(tmpdir(), "context-measure-"));
		dirs.push(dir);
		const manager = piSdk.SessionManager.create(dir, join(dir, "sessions"));
		const usage = (cost: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "question" }], timestamp: 1 } as never);
		const answered = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }], api: "faux", provider: "faux", model: "faux-1", usage: usage(2), stopReason: "stop", timestamp: 2 } as never);
		for (const entry of attempt("paid", "failed", usageTotals(3))) manager.appendCustomEntry(ATTEMPT_KIND, (entry as unknown as { data: unknown }).data);
		const parent = manager.getSessionFile() as string;
		const fork = manager.createBranchedSession(answered) as string;
		// The fork goes on: one more paid answer, only in the fork.
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "more" }], timestamp: 3 } as never);
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "more" }], api: "faux", provider: "faux", model: "faux-1", usage: usage(5), stopReason: "stop", timestamp: 4 } as never);
		return { dir, parent, fork };
	}

	it("counts each request once when the fork copied it from the session it came from", () => {
		const { parent, fork } = forked();
		expect(fork).not.toBe(parent);
		const source = (path: string) => ({ path, lines: readFileSync(path, "utf8").split("\n") });
		const report = reportSessions([source(fork), source(parent)]);
		expect(report.cost.knownSubtotal).toBe(10);
		expect(report.cost.requests).toBe(3);
		expect(report.main.requests).toBe(2);
	});

	it("finds the session a fork came from by the entries it copied when no path is given", () => {
		const { parent, fork } = forked();
		const report = reportSessions([{ lines: readFileSync(parent, "utf8").split("\n") }, { lines: readFileSync(fork, "utf8").split("\n") }]);
		expect(report.cost.knownSubtotal).toBe(10);
		expect(report.cost.requests).toBe(3);
	});

	/** A session whose entries a fork copies, then a search and a read of `found` that only the fork makes. */
	function forkThatRetrieves(found: string) {
		const dir = mkdtempSync(join(tmpdir(), "context-measure-labels-"));
		dirs.push(dir);
		const manager = piSdk.SessionManager.create(dir, join(dir, "sessions"));
		const log = sessionLog(manager);
		log.user("seed");
		const anchor = log.answer("seed");
		const parent = manager.getSessionFile() as string;
		const fork = manager.createBranchedSession(anchor) as string;
		log.call("s1", "history_search", { query: "q" });
		log.result("s1", "history_search", "hits", { hits: [found] });
		log.call("r1", "history_read", { id: found });
		log.result("r1", "history_read", found, { id: found });
		log.answer("done");
		const lines = (path: string) => readFileSync(path, "utf8").split("\n");
		return { parent: { path: parent, lines: lines(parent) }, fork: { path: fork, lines: lines(fork) } };
	}

	it("keeps an unlabelled fork of a labelled session a proxy session", () => {
		const { parent, fork } = forkThatRetrieves("live-y");
		const alone = reportSessions([fork]).retrieval;
		const together = reportSessions([{ ...parent, needed: ["fixture-x"] }, fork]).retrieval;
		expect(alone.proxy?.searches).toMatchObject({ total: 1, relevant: 1 });
		expect(together.proxy?.searches).toEqual(alone.proxy?.searches);
		expect(together.labelled?.searches.total).toBe(0);
	});

	it("reads each sibling's labels only in that sibling, and counts the cost of what they copied once", () => {
		const { parent, fork } = forkThatRetrieves("live-y");
		const report = reportSessions([{ ...parent, needed: ["other"] }, { ...fork, needed: ["live-y"] }]);
		// The fork is the only session that searched; its own label makes the read relevant.
		expect(report.retrieval.labelled?.searches).toMatchObject({ total: 1, relevant: 1 });
		const swapped = reportSessions([{ ...parent, needed: ["live-y"] }, { ...fork, needed: ["other"] }]);
		expect(swapped.retrieval.labelled?.searches).toMatchObject({ total: 1, relevant: 0 });
		expect(report.cost.requests).toBe(swapped.cost.requests);
	});

	it("npm run measure prints the cost report's total, not a main-model-only cost", () => {
		const { dir } = forked();
		const sessions = join(dir, "sessions");
		// A session of another day that is not a fork of anything.
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "other.jsonl"), JSON.stringify(assistant(1)));
		const root = join(dirname(fileURLToPath(import.meta.url)), "..");
		const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "tools/measure.ts"), "30", sessions], { encoding: "utf8" });
		expect(run.status, run.stderr).toBe(0);
		const json = JSON.parse(run.stdout.slice(0, run.stdout.indexOf("\n}\n") + 2)) as { cost: unknown; main: Record<string, unknown> };
		expect(json.cost).toMatchObject({ total: 11, knownSubtotal: 11, complete: true, requests: 4, unknown: 0 });
		expect(json.main).toMatchObject({ requests: 3 });
		expect(json.main).not.toHaveProperty("cost");
		expect(run.stdout).toContain("Cost, catalogue prices (not billed cash): $11.00 over 4 requests, complete");
	});
});
