import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import { emptySections, type SummaryState } from "../src/core/summary.ts";
import { TOOLS } from "../src/core/tools.ts";
import { SessionTape } from "../src/pi/session.ts";
import { boundaryHarness } from "./support/boundary.ts";
import { citingAnswer } from "./support/historian.ts";
import { deferred, interactiveUi, openRuntime, tempDir } from "./support/lifecycle.ts";
import { piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * Stored summaries and notebooks as the engine reads them back: whoever wrote one, a record that names entries off the
 * branch or is over the active limits is skipped, and the one before it stays.
 */

// Both names the engine has stored its records under.
const PREFIXES = ["context.", "sandy-context."] as const;

const summaryData = (state: Partial<SummaryState> & { coveredThroughId: string }, extra: Record<string, unknown> = {}) => ({
	version: 1,
	sections: { ...emptySections(), ...state.sections },
	...state,
	...extra,
});

describe("a stored notebook or summary over the limits after they were lowered", () => {
	// Valid under the defaults (8,192 bytes, 8,000 tokens), over the lowered ones.
	const lowered = resolveConfig({
		watermarkTokens: 20_000,
		keepRecentTokens: 1_000,
		maskedTokens: 500,
		pinnedUserTokens: 300,
		summaryTokens: 400,
		notebookMaxBytes: 4_096,
		historian: { enabled: false },
	});
	const hugeNote = "HUGE-NOTE " + "n".repeat(6_000);
	const hugeSummary = (covered: string) =>
		summaryData({ coveredThroughId: covered, sections: { ...emptySections(), facts: ["HUGE-SUMMARY " + "s".repeat(6_000)] } });

	for (const prefix of PREFIXES) {
		it(`is skipped at resume, the earlier one kept, by the tape and the next cut (${prefix})`, () => {
			const log = sessionLog();
			const turns = Array.from({ length: 12 }, (_, i) => log.turn("t" + i));
			log.manager.appendCustomEntry(prefix + "notebook", { text: "VALID-OLDER-NOTE" });
			log.manager.appendCustomEntry(
				prefix + "summary",
				summaryData({ coveredThroughId: turns[2]?.answer ?? "", sections: { ...emptySections(), facts: [`VALID-OLDER-FACT (#${turns[2]?.answer})`] } }),
			);
			log.manager.appendCustomEntry(prefix + "notebook", { text: hugeNote });
			log.manager.appendCustomEntry(prefix + "summary", hugeSummary(turns[4]?.answer ?? ""));

			assert.equal(log.tape().state.notebook, hugeNote, "under the defaults both are read");
			const tape = log.tape(lowered);
			assert.equal(tape.state.notebook, "VALID-OLDER-NOTE");
			assert.deepEqual(tape.history().summary?.sections.facts, [`VALID-OLDER-FACT (#${turns[2]?.answer})`]);

			const cut = boundaryHarness(log, lowered).turnEnd([], 25_000).find((draft) => draft.type === "compaction");
			assert.ok(cut?.type === "compaction");
			assert.ok(!cut.summary.includes("HUGE-NOTE") && !cut.summary.includes("HUGE-SUMMARY"), cut.summary.slice(0, 400));
			assert.ok(cut.summary.includes("VALID-OLDER-NOTE") && cut.summary.includes("VALID-OLDER-FACT"));
		});
	}

	it("skips a notebook stored as the result of the old notebook tool the same way", () => {
		const log = sessionLog();
		for (let i = 0; i < 3; i++) log.turn("t" + i);
		for (const text of ["VALID-OLDER-NOTE", hugeNote]) {
			const call = "nb-" + text.length;
			log.call(call, TOOLS.notebook.name, { text });
			log.result(call, TOOLS.notebook.name, "Notebook saved.", { text });
		}
		assert.equal(log.tape().state.notebook, hugeNote, "under the defaults both are read");
		assert.equal(log.tape(lowered).state.notebook, "VALID-OLDER-NOTE");
	});
});

describe("a stored summary that names an entry off the branch", () => {
	for (const prefix of PREFIXES) {
		it(`is skipped, keeping the earlier one, for every anchor it names (${prefix})`, () => {
			const log = sessionLog();
			const turns = Array.from({ length: 4 }, (_, i) => log.turn("t" + i));
			const valid = summaryData({ coveredThroughId: turns[1]?.answer ?? "", sections: { ...emptySections(), goal: [`EARLIER-GOAL (#${turns[1]?.answer})`] } });
			log.manager.appendCustomEntry(prefix + "summary", valid);
			const on = turns[2]?.answer ?? "";
			const foreign: [string, Record<string, unknown>][] = [
				["coverage", summaryData({ coveredThroughId: "sibling-only" })],
				["projection mark", summaryData({ coveredThroughId: on }, { projectedThroughId: "sibling-only" })],
				["partial entry", summaryData({ coveredThroughId: on, partial: { entryId: "sibling-only", offset: 3, digest: "d" } })],
				["superseded checkpoint", summaryData({ coveredThroughId: on, supersedes: "sibling-only" })],
				["source stretch", summaryData({ coveredThroughId: on, sources: [{ fromId: turns[0]?.user ?? "", throughId: "sibling-only", digest: "d" }] })],
				["reversed stretch", summaryData({ coveredThroughId: on, sources: [{ fromId: on, throughId: turns[0]?.user ?? "", digest: "d" }] })],
				["unsummarized stretch", summaryData({ coveredThroughId: on, unsummarized: [{ fromId: "sibling-only", throughId: on }] })],
			];
			for (const [what, data] of foreign) {
				const branch = log.manager.getLeafId();
				log.manager.appendCustomEntry(prefix + "summary", { ...data, sections: { ...emptySections(), goal: ["SIBLING-GOAL"] } });
				const tape = log.tape();
				assert.deepEqual(tape.history().summary?.sections.goal, [`EARLIER-GOAL (#${turns[1]?.answer})`], what);
				assert.equal(tape.history().summaryEligibility?.eligible, true, what);
				if (branch) log.manager.branch(branch);
			}
		});
	}

	it("is kept when its stretch lies behind a compaction on the branch", () => {
		const log = sessionLog();
		const turns = Array.from({ length: 6 }, (_, i) => log.turn("t" + i));
		log.ownCut(turns[4]?.user ?? "");
		const covered = turns[2]?.answer ?? "";
		log.manager.appendCustomEntry(
			"context.summary",
			summaryData({ coveredThroughId: covered, sections: { ...emptySections(), goal: ["HIDDEN-GOAL"] }, sources: [{ fromId: turns[0]?.user ?? "", throughId: covered, digest: "d" }] }),
		);
		assert.deepEqual(log.tape().history().summary?.sections.goal, ["HIDDEN-GOAL"]);
	});

	for (const prefix of PREFIXES) {
		it(`never reaches the historian or the next cut (${prefix})`, async () => {
			const dir = tempDir();
			const manager = piSdk.SessionManager.create(dir, join(dir, "sessions"));
			const log = sessionLog(manager as never);
			for (let i = 0; i < 12; i++) log.turn("t" + i);
			manager.appendCustomEntry(
				prefix + "summary",
				summaryData({
					coveredThroughId: "sibling-not-on-this-branch",
					sections: { ...emptySections(), goal: ["SIBLING-GOAL (#sibling-only)"] },
					sources: [{ fromId: "sibling-only", throughId: "sibling-not-on-this-branch", digest: "not-matching" }],
				}),
			);
			const stored = deferred();
			const prompts: string[] = [];
			const config = {
				watermarkTokens: 20_000,
				keepRecentTokens: 1_000,
				maskedTokens: 500,
				pinnedUserTokens: 300,
				summaryTokens: 400,
				historian: { startTokens: 1, chunkMinTokens: 100, chunkMaxTokens: 40_000, maxOutputTokens: 500 },
			};
			const { runtime, faux } = await openRuntime({
				dir,
				manager,
				trace: [],
				options: {
					configFile: false,
					ledgerFile: false,
					keepWarm: false,
					config,
					summarize: async (request) => {
						prompts.push(request.prompt);
						return { text: citingAnswer(request.prompt) };
					},
				},
				onAppend: (kind) => {
					if (kind.endsWith("summary")) stored.resolve();
				},
			});
			try {
				await runtime.session.bindExtensions({ uiContext: interactiveUi });
				await stored.promise;
				assert.ok(prompts.length > 0);
				assert.ok(prompts.every((prompt) => !prompt.includes("SIBLING-GOAL")), "the historian saw the foreign summary");
				const after = SessionTape.read(manager.getBranch(), piSdk.buildSessionProjection, resolveConfig(config)).history();
				assert.ok(after.summary);
				assert.ok(!JSON.stringify(after.summary.sections).includes("SIBLING-GOAL"), "the new summary kept the foreign goal");
				const cut = boundaryHarness(log, resolveConfig(config)).turnEnd([], 25_000).find((draft) => draft.type === "compaction");
				assert.ok(cut?.type === "compaction");
				assert.ok(!cut.summary.includes("SIBLING-GOAL"), "the cut carries the foreign goal");
			} finally {
				await runtime.dispose();
				faux.unregister();
			}
		});
	}
});
