import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DEFAULT_CONFIG, isConfigErrors, parseConfig, parseModelRef, resolveConfig } from "../src/core/config.ts";
import { CONTEXT_GUIDANCE, guidanceFor, notebookReminder, withSection } from "../src/core/guidance.ts";
import {
	boundaryCut,
	cacheTtlMs,
	cutThresholds,
	effectiveWatermark,
	keepWarmDue,
	notebookReminderDue,
	PI_RESERVE,
	promptCut,
	watermarkHolds,
} from "../src/core/policy.ts";
import { SearchIndex, snippet, tokenize } from "../src/core/search.ts";

describe("config", () => {
	it("rejects carried budgets that would trigger a cut right after a cut", () => {
		assert.throws(() => resolveConfig({ watermarkTokens: 30_000 }), /must stay below watermarkTokens/);
	});

	it("counts what a cut carries in provider tokens, notebook included", () => {
		// 34k of budgets plus the skills section and an 8 KiB notebook (2,648 estimated, ~4.2k provider tokens): 38.2k.
		assert.throws(() => resolveConfig({ watermarkTokens: 38_000 }), /must stay below watermarkTokens/);
		assert.doesNotThrow(() => resolveConfig({ watermarkTokens: 40_000 }));
		assert.throws(() => resolveConfig({ watermarkTokens: 40_000, notebookMaxBytes: 16_384 }), /must stay below/);
	});

	it("rejects non-positive numbers", () => {
		assert.throws(() => resolveConfig({ maskedTokens: 0 }), /maskedTokens must be a positive number/);
		assert.throws(() => resolveConfig({ notebookReminderAt: 1 }), /notebookReminderAt must be between 0 and 1/);
	});

	it("merges nested historian settings over the defaults", () => {
		const config = resolveConfig({ historian: { model: "anthropic/claude-haiku" } }, { historian: { enabled: false } });
		assert.equal(config.historian.model, "anthropic/claude-haiku");
		assert.equal(config.historian.enabled, false);
		assert.equal(config.historian.chunkMaxTokens, DEFAULT_CONFIG.historian.chunkMaxTokens);
	});
});

describe("parseConfig", () => {
	const errorsOf = (input: unknown, overrides?: unknown): readonly string[] => {
		const result = parseConfig(input, overrides);
		assert.ok(isConfigErrors(result), "expected the config to be refused");
		return result.configErrors;
	};

	it("reads a partial file over the defaults", () => {
		const result = parseConfig({ watermarkTokens: 100_000, historian: { model: "openai-codex/gpt-6-luna" } });
		assert.ok(!isConfigErrors(result));
		assert.equal(result.watermarkTokens, 100_000);
		assert.equal(result.historian.model, "openai-codex/gpt-6-luna");
		assert.equal(result.historian.chunkMaxTokens, DEFAULT_CONFIG.historian.chunkMaxTokens);
		assert.equal(result.cacheTtlSeconds.anthropic?.short, 300);
	});

	it("applies the embedder's overrides after the file", () => {
		const result = parseConfig({ watermarkTokens: 100_000 }, { watermarkTokens: 90_000 });
		assert.ok(!isConfigErrors(result));
		assert.equal(result.watermarkTokens, 90_000);
	});

	it("refuses an unknown field, also nested, instead of dropping it", () => {
		const errors = errorsOf({ watermarkToken: 100_000, historian: { modle: "a/b" }, cacheTtlSeconds: { x: { medium: 1 } } });
		assert.equal(errors.length, 3, errors.join("\n"));
		const text = errors.join("\n");
		assert.match(text, /unknown field watermarkToken /);
		assert.match(text, /unknown field historian\.modle /);
		assert.match(text, /unknown field cacheTtlSeconds\.x\.medium /);
	});

	it("refuses a wrong type for every kind of setting", () => {
		const errors = errorsOf({
			watermarkTokens: "120000",
			notebookReminderAt: null,
			historian: { enabled: "yes", startTokens: "60000" },
			cacheTtlSeconds: { anthropic: { short: "300" }, openai: 5 },
		});
		const text = errors.join("\n");
		for (const field of [
			"watermarkTokens must be a number",
			"notebookReminderAt must be a number",
			"historian.enabled must be true or false",
			"historian.startTokens must be a number",
			"cacheTtlSeconds.anthropic.short must be a number",
			"cacheTtlSeconds.openai must be an object",
		]) {
			assert.ok(text.includes(field), `missing "${field}" in:\n${text}`);
		}
	});

	it("refuses input that is not an object", () => {
		for (const input of [null, [], "text", 7]) assert.match(errorsOf(input)[0] ?? "", /must be a JSON object/);
	});

	it("refuses a malformed model reference instead of falling back to the session model", () => {
		for (const model of ["claude-haiku", "/claude-haiku", "anthropic/", "anthropic/claude haiku", "", 7]) {
			const errors = errorsOf({ historian: { model } });
			assert.match(errors[0] ?? "", /historian\.model must be a provider\/model reference/, String(model));
		}
		assert.match(errorsOf({ historian: { fallbackModel: "nope" } })[0] ?? "", /historian\.fallbackModel must be/);
	});

	it("refuses contradictory budgets and chunk sizes", () => {
		assert.match(errorsOf({ watermarkTokens: 30_000 })[0] ?? "", /must stay below watermarkTokens/);
		assert.match(
			errorsOf({ historian: { chunkMinTokens: 50_000, chunkMaxTokens: 40_000 } })[0] ?? "",
			/chunkMinTokens must not exceed/,
		);
	});

	it("reports every problem at once", () => {
		const errors = errorsOf({ watermarkTokens: 30_000, extra: 1, maskedTokens: "x", historian: { model: "bad" } });
		assert.equal(errors.length, 4, errors.join("\n"));
	});

	it("labels what the embedder passed", () => {
		assert.match(errorsOf({}, { watermarkTokens: "x" })[0] ?? "", /^options\.config: watermarkTokens must be a number/);
	});

	it("parses a provider/model reference", () => {
		assert.deepEqual(parseModelRef("openai-codex/gpt-6-luna"), { provider: "openai-codex", id: "gpt-6-luna" });
		assert.deepEqual(parseModelRef("openrouter/anthropic/claude"), { provider: "openrouter", id: "anthropic/claude" });
		assert.equal(parseModelRef("gpt"), undefined);
	});
});

describe("search", () => {
	it("splits identifiers into their parts", () => {
		assert.deepEqual(tokenize("parseSummaryDelta snake_case_name"), [
			"parsesummarydelta",
			"parse",
			"summary",
			"delta",
			"snake_case_name",
			"snake",
			"case",
			"name",
		]);
	});

	it("keeps compound names whole and without their extension", () => {
		const terms = tokenize('read({"path":"docs/report-4.txt"}) uses gpt-6-luna.');
		assert.ok(terms.includes("report-4.txt") && terms.includes("report-4") && terms.includes("gpt-6-luna"));
		const index = new SearchIndex();
		index.add("r4", 'read({"path":"report-4.txt"})\nRELEASE CODE: jade');
		index.add("r9", 'read({"path":"report-9.txt"})\nRELEASE CODE: plum');
		assert.equal(index.search("report-4 release code", { limit: 2 })[0]?.id, "r4");
	});

	it("ranks the document with the rare term first and honours the filter", () => {
		const index = new SearchIndex();
		index.add("a", "the build failed with ECONNRESET while fetching");
		index.add("b", "the build passed");
		index.add("c", "the build passed again");
		assert.equal(index.search("ECONNRESET build", { limit: 3 })[0]?.id, "a");
		assert.deepEqual(index.search("ECONNRESET", { limit: 3, accept: (id) => id !== "a" }), []);
	});

	it("breaks ties toward the newer entry and ignores re-adds", () => {
		const index = new SearchIndex();
		index.add("old", "deploy staging");
		index.add("new", "deploy staging");
		index.add("old", "something else entirely");
		assert.equal(index.size, 2);
		assert.deepEqual(
			index.search("deploy", { limit: 2 }).map((hit) => hit.id),
			["new", "old"],
		);
	});

	it("cuts a snippet around the first matching term", () => {
		const text = `${"a ".repeat(400)}needle here${" b".repeat(400)}`;
		const cut = snippet(text, "needle", 60);
		assert.match(cut, /needle here/);
		assert.ok(cut.startsWith("…") && cut.endsWith("…"));
	});
});

describe("policy", () => {
	it("keeps the watermark below pi's own compaction threshold", () => {
		assert.equal(effectiveWatermark(DEFAULT_CONFIG, 1_000_000), 120_000);
		assert.equal(effectiveWatermark(DEFAULT_CONFIG, 128_000), 128_000 - 32_768);
		assert.equal(effectiveWatermark(DEFAULT_CONFIG, undefined), 120_000);
	});

	it("defers an interactive cut from the soft threshold to the next prompt, up to the hard one", () => {
		const big = cutThresholds(DEFAULT_CONFIG, 1_000_000);
		assert.deepEqual(big, { soft: 120_000, hard: 150_000 });
		assert.deepEqual(cutThresholds(DEFAULT_CONFIG, 160_000), { soft: 120_000, hard: 160_000 - 32_768 });
		assert.deepEqual(cutThresholds(DEFAULT_CONFIG, 128_000), { soft: 95_232, hard: 95_232 }, "no room to defer");
		assert.equal(boundaryCut(119_999, big, false), false);
		assert.equal(boundaryCut(120_000, big, false), true, "no user prompt to wait for");
		assert.equal(boundaryCut(149_999, big, true), false, "the next prompt cuts");
		assert.equal(boundaryCut(150_000, big, true), true, "hard brake mid-run");
		assert.equal(boundaryCut(undefined, big, false), false);
	});

	it("allows cuts only below a watermark that holds what a cut leaves", () => {
		// The default config leaves at most 16k kept and 22.2k carried (with the skills section and the notebook), 38,237
		// provider tokens in all.
		assert.equal(watermarkHolds(DEFAULT_CONFIG, effectiveWatermark(DEFAULT_CONFIG, 128_000)), true);
		assert.equal(watermarkHolds(DEFAULT_CONFIG, 38_238), true);
		assert.equal(watermarkHolds(DEFAULT_CONFIG, 38_237), false);
		assert.equal(watermarkHolds(DEFAULT_CONFIG, effectiveWatermark(DEFAULT_CONFIG, 2 * PI_RESERVE)), false);
	});

	it("cuts before a prompt only when the cache is lost anyway", () => {
		const base = {
			contextTokens: 80_000,
			now: 1_000_000,
			lastCacheTouch: 1_000_000 - 60_000,
			ttlMs: 300_000,
			modelKey: "anthropic/opus",
			lastModelKey: "anthropic/opus",
			minTokens: 60_000,
			soft: 120_000,
		};
		assert.equal(promptCut(base), undefined);
		assert.equal(promptCut({ ...base, contextTokens: 120_000 }), "watermark", "the deferred cut");
		assert.equal(promptCut({ ...base, lastCacheTouch: 1_000_000 - 301_000 }), "cold");
		assert.equal(promptCut({ ...base, modelKey: "openai/gpt" }), "model");
		assert.equal(promptCut({ ...base, contextTokens: 50_000, lastCacheTouch: 0 }), undefined);
		assert.equal(promptCut({ ...base, contextTokens: undefined, lastCacheTouch: 0 }), undefined);
	});

	it("takes a cache lifetime from the measured table before what the model declares", () => {
		const codex = { provider: "openai-codex", id: "gpt-6-astra", promptCache: { short: 86_400 } };
		assert.equal(cacheTtlMs(DEFAULT_CONFIG, codex, "short"), Number.POSITIVE_INFINITY, "never expires, not the declared day");
		assert.equal(cacheTtlMs(DEFAULT_CONFIG, codex, "long"), Number.POSITIVE_INFINITY);
		const claude = { provider: "anthropic", id: "claude-haiku-5-5" };
		assert.equal(cacheTtlMs(DEFAULT_CONFIG, claude, "short"), 300_000);
		assert.equal(cacheTtlMs(DEFAULT_CONFIG, claude, "long"), 3_600_000);
		const other = { provider: "openai", id: "gpt", promptCache: { short: 600 } };
		assert.equal(cacheTtlMs(DEFAULT_CONFIG, other, "short"), 600_000, "declared");
		assert.equal(cacheTtlMs(DEFAULT_CONFIG, other, "long"), 3_600_000, "long default");
		assert.equal(cacheTtlMs(DEFAULT_CONFIG, undefined, "short"), 300_000, "fallback");
		const tuned = resolveConfig({ cacheTtlSeconds: { "openai-codex/gpt-6-astra": { long: 3_000 } } });
		assert.equal(cacheTtlMs(tuned, codex, "long"), 3_000_000, "model row over provider row");
		assert.equal(cacheTtlMs(tuned, codex, "short"), Number.POSITIVE_INFINITY, "a missing tier falls through");
		assert.equal(cacheTtlMs(tuned, claude, "long"), 3_600_000, "defaults survive a merge");
		assert.throws(() => resolveConfig({ cacheTtlSeconds: { x: { short: 0 } } }), /cacheTtlSeconds\.x\.short/);
		assert.throws(() => resolveConfig({ cacheTtlSeconds: { x: { short: Number.NaN } } }), /cacheTtlSeconds\.x\.short/);
	});

	it("neither pings nor cuts a session whose cache never expires", () => {
		const ttlMs = cacheTtlMs(DEFAULT_CONFIG, { provider: "openai-codex", id: "gpt-6-astra" }, "short");
		const day = 86_400_000;
		const waiting = { cacheStart: 0, ttlMs, until: 2 * day, contextTokens: 80_000, softTokens: 200_000, minTokens: 60_000, carriedTokens: 26_000, cacheReadCost: 0.1, cacheWriteCost: 1.25 };
		assert.equal(keepWarmDue(waiting, day), false);
		const prompt = { contextTokens: 150_000, now: 7 * day, lastCacheTouch: 0, ttlMs, modelKey: "a", lastModelKey: "a", minTokens: 60_000, soft: 200_000 };
		assert.equal(promptCut(prompt), undefined, "no cold cut after a week");
		assert.equal(promptCut({ ...prompt, modelKey: "b" }), "model", "a model change still cuts");
	});

	it("pings a waiting session only while that is cheaper than going cold", () => {
		const ttl = 1_800_000;
		const base = {
			cacheStart: 0,
			ttlMs: ttl,
			until: 2 * ttl,
			contextTokens: 80_000,
			softTokens: 200_000,
			minTokens: 60_000,
			carriedTokens: 26_000,
			cacheReadCost: 0.1,
			cacheWriteCost: 1.25,
		};
		// Two pings and the prompt read 24k token-units; going cold writes 26k carried tokens at 1.25.
		assert.equal(keepWarmDue(base, ttl - 30_000), true);
		assert.equal(keepWarmDue(base, ttl - 61_000), false, "more than a minute before expiry");
		assert.equal(keepWarmDue(base, ttl - 60_000), true, "one minute before expiry");
		assert.equal(keepWarmDue(base, ttl), false, "already cold");
		assert.equal(keepWarmDue({ ...base, until: 0.9 * ttl }, ttl - 30_000), false, "the prompt comes while warm");
		assert.equal(keepWarmDue({ ...base, until: undefined }, ttl - 30_000), false, "no signal");
		assert.equal(keepWarmDue({ ...base, until: 10 * ttl }, ttl - 30_000), false, "eleven pings cost more than a cut");
		assert.equal(keepWarmDue({ ...base, contextTokens: 20_000, until: 3 * ttl }, ttl - 30_000), true, "a small prompt is not cut");
		assert.equal(keepWarmDue({ ...base, contextTokens: undefined }, ttl - 30_000), false);
		assert.equal(keepWarmDue({ ...base, cacheStart: undefined }, ttl - 30_000), false, "no request to count from");
	});

	it("counts the cache from the request start, so a slow answer does not hide an expired cache", () => {
		// The review's fixture: a 90 s answer on a 5 minute cache. Counted from the answer's end the cache would expire at
		// 6:30 and 5:35 would ping; counted from the request start it expired at 5:00.
		const ttl = 300_000;
		const state = { cacheStart: 0, ttlMs: ttl, until: 3 * ttl, contextTokens: 80_000, softTokens: 200_000, minTokens: 60_000, carriedTokens: 26_000, cacheReadCost: 0.1, cacheWriteCost: 1.25 };
		const answerEnd = 90_000;
		assert.equal(keepWarmDue(state, answerEnd + 245_000), false, "4:05 after the answer is 5:35 after the start");
		assert.equal(keepWarmDue(state, answerEnd + 160_000), true, "4:10 after the start");
	});

	it("stops pinging when the next prompt would be cut anyway", () => {
		const ttl = 300_000;
		const state = { cacheStart: 0, ttlMs: ttl, until: 2 * ttl, contextTokens: 100_000, softTokens: 110_000, minTokens: 60_000, carriedTokens: 26_000, cacheReadCost: 0.1, cacheWriteCost: 1.25 };
		assert.equal(keepWarmDue(state, 250_000), true, "below the watermark");
		assert.equal(keepWarmDue({ ...state, contextTokens: 110_000 }, 250_000), false, "at the watermark the prompt cuts and the warm cache is thrown away");
	});

	it("reminds once per cut, shortly before it, about a notebook not written since the last cut", () => {
		const base = { contextTokens: 100_000, watermark: 120_000, at: 0.8, notebookCurrent: false, reminded: false };
		assert.equal(notebookReminderDue(base), true);
		assert.equal(notebookReminderDue({ ...base, contextTokens: 95_999 }), false, "too early");
		assert.equal(notebookReminderDue({ ...base, contextTokens: 130_000 }), true, "past the soft mark while the cut waits for the next prompt");
		assert.equal(notebookReminderDue({ ...base, notebookCurrent: true }), false, "written since the last cut");
		assert.equal(notebookReminderDue({ ...base, reminded: true }), false, "already reminded");
		assert.equal(notebookReminderDue({ ...base, contextTokens: undefined }), false);
	});
});

describe("guidance", () => {
	it("names the tools and tells the agent to keep its notebook current", () => {
		assert.match(CONTEXT_GUIDANCE, /- notebook: /);
		assert.match(CONTEXT_GUIDANCE, /history_search and history_read/);
		assert.match(CONTEXT_GUIDANCE, /not only when reminded/);
	});

	it("tells the agent how to reach tools a harness hides", () => {
		const all = ["codemode", "notebook", "history_search", "history_read"];
		assert.equal(guidanceFor(["read"], []), undefined);
		assert.doesNotMatch(guidanceFor(all, []) ?? "", /not declared to you/);
		assert.match(
			guidanceFor(all, ["notebook", "history_search", "history_read"]) ?? "",
			/inside a codemode script as `tools\.notebook/,
		);
	});

	it("appends the section to a forced prompt exactly once", () => {
		const once = withSection("forced", "context", "text");
		assert.equal(once, "forced\n\n<context>\ntext\n</context>");
		assert.equal(withSection(once, "context", "text"), once);
	});

	it("words the reminder for an empty and for a stale notebook", () => {
		assert.match(notebookReminder(18_400, true), /in about 18k tokens\. Your notebook is empty\./);
		assert.match(
			notebookReminder(-5, false),
			/in about 0k tokens\. You have not updated your notebook since the last cut\./,
		);
	});
});
