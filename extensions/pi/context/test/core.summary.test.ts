import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { condensePrompt } from "../src/core/historian.ts";
import {
	applyCondensed,
	citedIds,
	CONDENSE_TARGET,
	condenseSelection,
	fitToBudget,
	mergeSummary,
	parseSummaryDelta,
	readSummaryState,
	renderSummary,
	type SummaryDelta,
	type SummaryState,
	summaryTokens,
} from "../src/core/summary.ts";
import { estimateTokens } from "../src/core/tokens.ts";

describe("anchored summary", () => {
	const historianOutput = [
		"## Goal",
		"- Ship the cache-aware cut (#u1)",
		"## Decisions",
		"- Use BM25 over the raw log because ReFind",
		"  shows it beats embeddings (#a2)",
		"## Errors",
		"- None.",
		"## Something else",
		"- ignored",
		"## Open threads and next steps",
		"1. Write the integration test (#r3)",
	].join("\n");

	it("parses known sections, continuation lines and drops empty markers", () => {
		assert.deepEqual(parseSummaryDelta(historianOutput), {
			goal: ["Ship the cache-aware cut (#u1)"],
			decisions: ["Use BM25 over the raw log because ReFind shows it beats embeddings (#a2)"],
			errors: [],
			next: ["Write the integration test (#r3)"],
		});
	});

	it("clears a replaced section written as none and keeps one the answer left out", () => {
		const first = mergeSummary(undefined, { next: ["Write the test (#r3)"], state: ["Done: x (#r3)"] }, "r3");
		const second = mergeSummary(first, parseSummaryDelta("## Open threads and next steps\n- none\n## Current state\n"), "r9");
		assert.deepEqual(second.sections.next, []);
		assert.deepEqual(second.sections.state, ["Done: x (#r3)"]);
	});

	it("replaces state sections, appends records and never duplicates", () => {
		const first = mergeSummary(undefined, parseSummaryDelta(historianOutput), "r3");
		const second = mergeSummary(
			first,
			{
				next: ["Run it (#r9)"],
				decisions: [
					"Use BM25 over the raw log because ReFind shows it beats embeddings (#a2)",
					"Keep pins verbatim (#a8)",
				],
			},
			"r9",
		);
		assert.equal(second.coveredThroughId, "r9");
		assert.deepEqual(second.sections.goal, ["Ship the cache-aware cut (#u1)"]);
		assert.deepEqual(second.sections.next, ["Run it (#r9)"]);
		assert.equal(second.sections.decisions.length, 2);
		assert.deepEqual(readSummaryState(JSON.parse(JSON.stringify(second))), second);
	});

	it("keeps how the goal changed", () => {
		const first = mergeSummary(undefined, { goal: ["Build a cut (#u1)"] }, "u1");
		const second = mergeSummary(first, { goal: ["Build a cut that never waits, because users notice (#u7)"] }, "u7");
		assert.deepEqual(second.sections.goal, [
			"Build a cut (#u1)",
			"Build a cut that never waits, because users notice (#u7)",
		]);
	});

	it("reads older stored summaries and rejects malformed ones", () => {
		const older = { version: 1, coveredThroughId: "x", sections: { goal: ["g"], facts: ["f"] } };
		assert.deepEqual(readSummaryState(older)?.sections.chapters, []);
		assert.deepEqual(readSummaryState(older)?.sections.facts, ["f"]);
		assert.equal(readSummaryState({ version: 1, coveredThroughId: "x", sections: { goal: "g" } }), undefined);
		assert.equal(readSummaryState({ version: 2, coveredThroughId: "x", sections: {} }), undefined);
	});

	it("drops the oldest records of the largest section as a last resort", () => {
		const facts = Array.from({ length: 40 }, (_, i) => `fact number ${i} with some padding text (#f${i})`);
		const summary = fitToBudget(
			mergeSummary(undefined, { goal: ["keep me"], facts, errors: ["one error (#e1)"] }, "f39"),
			200,
		);
		assert.ok(renderSummary(summary.sections).length / 4 <= 200);
		assert.deepEqual(summary.sections.goal, ["keep me"]);
		assert.equal(summary.sections.facts.at(-1), facts.at(-1));
		assert.ok(!summary.sections.facts.includes(facts[0] ?? ""));
	});
});

describe("condensing", () => {
	const facts = Array.from({ length: 40 }, (_, i) => `fact number ${i} with some padding text (#f${i})`);
	const full = mergeSummary(undefined, { state: ["now"], facts, errors: ["one error (#e1)", "two (#e2)"] }, "f39");
	const fullOrder = new Map([...facts.map((_, i) => "f" + i), "e1", "e2"].map((id, at) => [id, at]));

	it("selects nothing while the summary fits", () => {
		assert.equal(condenseSelection(full, 10_000), undefined);
	});

	it("selects the oldest records of the largest sections, enough to reach the target", () => {
		const selection = condenseSelection(full, 300);
		assert.ok(selection);
		assert.deepEqual(selection.facts, facts.slice(0, selection.facts?.length));
		assert.equal(selection.state, undefined);
		const freed = Object.values(selection)
			.flat()
			.reduce((sum, item) => sum + estimateTokens(item) + 1, 0);
		assert.ok(summaryTokens(full) - freed <= 300 * CONDENSE_TARGET);
		assert.match(condensePrompt(selection), /<records>\n## Facts and findings\n- fact number 0 /);
	});

	it("takes no section that holds a single record, since condensing one into one saves nothing", () => {
		const single = mergeSummary(undefined, { facts: [`${"long fact ".repeat(200)}(#f1)`] }, "f1");
		assert.equal(condenseSelection(single, 10), undefined);
		const errors = ["one error (#e1)", "two (#e2)"];
		const mixed = mergeSummary(undefined, { facts: [`${"long fact ".repeat(200)}(#f1)`], errors }, "e2");
		assert.deepEqual(condenseSelection(mixed, 10), { errors });
	});

	it("puts the condensed items in place of the group and ignores a group it did not shorten", () => {
		const selection = { facts: facts.slice(0, 10), errors: ["one error (#e1)", "two (#e2)"] };
		const condensed = parseSummaryDelta(
			"## Facts and findings\n- facts 0 to 9 (#f0 … #f9)\n## Errors and fixes\n- one error and two, at length and in detail (#e1, #e2)",
		);
		const result = applyCondensed(full, selection, condensed, fullOrder);
		assert.deepEqual(result.sections.facts, ["facts 0 to 9 (#f0 … #f9)", ...facts.slice(10)]);
		assert.deepEqual(result.sections.errors, full.sections.errors);
		assert.deepEqual(applyCondensed(full, selection, {}, fullOrder).sections, full.sections);
	});
});

/*
 * Retention: how much of the session's early history the summary still accounts for after
 * many historian passes. A record counts as retained while its entry id appears in the summary,
 * by itself or inside a condensed range. The condenser here is mechanical (it keeps only the
 * id range), so this measures what survives budgeting, not how well a model writes.
 */
describe("retention over many passes", () => {
	const ROUNDS = 60;
	const id = (round: number, item: number) => `r${String(round).padStart(3, "0")}f${item}`;
	const roundDelta = (round: number): SummaryDelta => ({
		state: [`working on round ${round}`],
		facts: Array.from(
			{ length: 4 },
			(_, item) => `round ${round} finding ${item}: value-${round}-${item} in module ${round} (#${id(round, item)})`,
		),
		decisions: [`round ${round} decision with its reason (#${id(round, 9)})`],
	});
	const idsOf = (item: string) => [...item.matchAll(/#(r\d{3}f\d)/g)].map((match) => match[1] ?? "");
	const mechanicalCondenser = (selection: Partial<Record<string, readonly string[]>>): SummaryDelta => {
		const out: Record<string, string[]> = {};
		for (const [key, items] of Object.entries(selection)) {
			const ids = (items ?? []).flatMap(idsOf).sort();
			out[key] = [`${items?.length} records (#${ids[0]} … #${ids.at(-1)})`];
		}
		return out as SummaryDelta;
	};
	const retained = (summary: SummaryState, round: number): boolean => {
		const target = id(round, 0);
		return Object.values(summary.sections)
			.flat()
			.some((item) => {
				const ids = idsOf(item);
				if (ids.includes(target)) return true;
				const range = /#(r\d{3}f\d) … #(r\d{3}f\d)/.exec(item);
				return range !== null && (range[1] ?? "") <= target && target <= (range[2] ?? "");
			});
	};

	function run(condense: boolean) {
		const budget = 1_200;
		// The history's order, as the historian hands it to the condenser: a range covers every entry between its ends.
		const order = new Map(
			Array.from({ length: ROUNDS }, (_, round) => Array.from({ length: 10 }, (_, item) => id(round + 1, item))).flat().map((one, at) => [one, at]),
		);
		let summary: SummaryState | undefined;
		let calls = 0;
		for (let round = 1; round <= ROUNDS; round++) {
			let next = mergeSummary(summary, roundDelta(round), id(round, 9));
			const selection = condense ? condenseSelection(next, budget) : undefined;
			if (selection) {
				calls++;
				next = applyCondensed(next, selection, mechanicalCondenser(selection), order);
			}
			summary = fitToBudget(next, budget);
			assert.ok(summaryTokens(summary) <= budget);
		}
		const rounds = Array.from({ length: ROUNDS }, (_, i) => i + 1);
		return {
			summary: summary as SummaryState,
			calls,
			kept: rounds.filter((round) => retained(summary as SummaryState, round)).length,
		};
	}

	it("dropping loses the early rounds, condensing accounts for all of them", () => {
		const dropped = run(false);
		const condensed = run(true);
		assert.ok(!retained(dropped.summary, 1), "dropping should lose round 1");
		assert.equal(condensed.kept, ROUNDS);
		assert.ok(condensed.calls < ROUNDS / 3, `condensing ran ${condensed.calls} times in ${ROUNDS} passes`);
		console.log(
			`retention after ${ROUNDS} passes: drop ${dropped.kept}/${ROUNDS}, condense ${condensed.kept}/${ROUNDS} with ${condensed.calls} condenser calls`,
		);
	});
});

describe("sourced summaries", () => {
	const sourced: SummaryState = {
		...mergeSummary(undefined, { goal: ["never touch billing (#u1)"], facts: ["a (#t1)", "b (#t2)", "c (#t3)"] }, "t3"),
		sources: [{ fromId: "u1", throughId: "t3", digest: "0123456789abcdef" }],
		partial: { entryId: "t4", offset: 120, digest: "fedcba9876543210" },
		supersedes: "cp1",
	};

	it("reads back the stretches, the partial entry and the checkpoint it replaces", () => {
		assert.deepEqual(readSummaryState(JSON.parse(JSON.stringify(sourced))), sourced);
		assert.equal(readSummaryState({ ...sourced, sources: [{ fromId: "u1" }] }), undefined);
		assert.equal(readSummaryState({ ...sourced, partial: { entryId: "t4", offset: 0, digest: "x" } }), undefined);
		assert.equal(readSummaryState({ ...sourced, supersedes: 7 }), undefined);
	});

	it("names the entries an item depends on, and every entry inside a range once the order is known", () => {
		assert.deepEqual(citedIds("x (#a, #b)"), ["a", "b"]);
		assert.deepEqual(citedIds("no citation"), []);
		const order = new Map(["a", "m1", "m2", "b", "z"].map((id, at) => [id, at]));
		assert.deepEqual(citedIds("x (#a … #b)", order).sort(), ["a", "b", "m1", "m2"]);
	});

	it("keeps the originals when the condensed items drop an entry the originals cited", () => {
		const selection = { facts: sourced.sections.facts };
		const shorter = ["a+b (#t1, #t2)"];
		assert.ok(estimateTokens(shorter[0] as string) < selection.facts.reduce((sum, item) => sum + estimateTokens(item), 0), "only the dropped id rejects it");
		const order = new Map(["u1", "t1", "t2", "t3"].map((id, at) => [id, at]));
		const lossy = applyCondensed(sourced, selection, { facts: shorter }, order);
		assert.deepEqual(lossy.sections.facts, sourced.sections.facts, "#t3 would no longer be found by an edit of it");
		const whole = applyCondensed(sourced, selection, { facts: ["all (#t1 … #t3)"] }, order);
		assert.deepEqual(whole.sections.facts, ["all (#t1 … #t3)"], "a range covers what is between its ends");
	});

	it("reads a new range in the history's order, never in the order the originals cited their entries", () => {
		const facts = ["A long record names fact A at length (#a)", "A long record names fact C at length (#c)", "A long record names fact B at length (#b)"];
		const summary = { ...mergeSummary(undefined, { facts }, "c") };
		const order = new Map(["a", "b", "c"].map((id, at) => [id, at]));
		assert.deepEqual(applyCondensed(summary, { facts }, { facts: ["All A/B/C (#a … #b)"] }, order).sections.facts, facts, "#c lies after the range");
		assert.deepEqual(applyCondensed(summary, { facts }, { facts: ["All A/B/C (#a … #c)"] }, order).sections.facts, ["All A/B/C (#a … #c)"]);
		// Without the history's order a range's inside is unknown, so a range proves nothing: the originals stay.
		// @ts-expect-error the history's order is required
		assert.deepEqual(applyCondensed(summary, { facts }, { facts: ["All A/B/C (#a … #b)"] }).sections.facts, facts);
	});
});
