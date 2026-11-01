import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	CUT_DETAILS_KEY,
	CUT_REQUEST_CHANNEL,
	CUT_TAG_NAME,
	KEEP_WARM_KIND,
	NOTEBOOK_KIND,
	REMINDER_KIND,
	SIGNALS_CHANNEL,
	SUMMARY_KIND,
	TASK_DONE_KIND,
} from "../src/core/kinds.ts";
import { cutReason, decodeContextRecord, kindOf } from "../src/core/records.ts";
import {
	OLD_CUT,
	OLD_CUT_UNSUMMARIZED,
	OLD_KEEP_WARM,
	OLD_NOTEBOOK,
	OLD_NOTEBOOK_TOOL_RESULT,
	OLD_REMINDER,
	OLD_SUMMARY,
	OLD_TASK_DONE,
} from "./fixtures/old-records.ts";

describe("old records from sessions named sandy-context decode through the one decoder", () => {
	it("reads the notebook entry", () => {
		assert.deepEqual(decodeContextRecord(OLD_NOTEBOOK), { kind: "notebook", text: "GOAL: ship slice 2" });
	});
	it("reads the notebook kept in an old notebook tool result", () => {
		assert.deepEqual(decodeContextRecord(OLD_NOTEBOOK_TOOL_RESULT), { kind: "notebook", text: "GOAL: the old notebook" });
	});
	it("reads the historian's summary, a section missing from it as empty", () => {
		const record = decodeContextRecord(OLD_SUMMARY);
		assert.equal(record.kind, "summary");
		if (record.kind !== "summary") return;
		assert.equal(record.state.coveredThroughId, "6189b0f7");
		assert.deepEqual(record.state.sections.state, ["Done: loaded batch_2.md"]);
		assert.deepEqual(record.state.sections.facts, []);
	});
	it("reads the notebook reminder", () => {
		assert.deepEqual(decodeContextRecord(OLD_REMINDER), { kind: "reminder" });
	});
	it("reads a finished task's cut request, so a resumed session still cuts for it", () => {
		assert.deepEqual(decodeContextRecord(OLD_TASK_DONE), { kind: "task-done" });
	});
	it("reads a keep-warm ping", () => {
		assert.deepEqual(decodeContextRecord(OLD_KEEP_WARM), { kind: "keep-warm" });
		assert.equal(kindOf("sandy-context.keep-warm"), "keep-warm");
	});
	it("reads a keep-warm side request apart from an old ping turn", () => {
		const start = { type: "custom", id: "w", customType: KEEP_WARM_KIND, data: { type: "start", id: "w1", at: 5, model: "p/m" } };
		assert.deepEqual(decodeContextRecord(start), { kind: "warm-request", warm: { type: "start", id: "w1", at: 5, model: "p/m" } });
		const usage = { input: 1, output: 1, cacheRead: 2, cacheWrite: 0, cost: 0.1 };
		const end = { ...start, data: { type: "end", id: "w1", at: 5, outcome: "warmed", usage } };
		assert.deepEqual(decodeContextRecord(end), { kind: "warm-request", warm: { type: "end", id: "w1", at: 5, outcome: "warmed", usage } });
		assert.equal(decodeContextRecord({ ...start, data: { type: "end", id: "w1" } }).kind, "invalid");
	});
	it("reads a cut and its details", () => {
		assert.deepEqual(decodeContextRecord(OLD_CUT), { kind: "cut", details: OLD_CUT.details.sandyContext });
		assert.deepEqual(decodeContextRecord(OLD_CUT_UNSUMMARIZED), {
			kind: "cut",
			details: OLD_CUT_UNSUMMARIZED.details.sandyContext,
		});
	});
	it("reads the reason from an old cut's opening tag", () => {
		assert.equal(cutReason(OLD_CUT.summary), "watermark");
		assert.equal(cutReason(OLD_CUT_UNSUMMARIZED.summary), "task");
	});
});

describe("current records", () => {
	it("are all named context, none sandy", () => {
		const names = [NOTEBOOK_KIND, SUMMARY_KIND, REMINDER_KIND, TASK_DONE_KIND, KEEP_WARM_KIND, CUT_REQUEST_CHANNEL, SIGNALS_CHANNEL];
		for (const name of names) assert.match(name, /^context\./);
		assert.equal(CUT_DETAILS_KEY, "context");
		assert.equal(CUT_TAG_NAME, "context");
	});
	it("decode the same as the old ones", () => {
		const rename = <T extends { customType: string }>(entry: T) => ({ ...entry, customType: entry.customType.replace("sandy-context.", "context.") });
		assert.deepEqual(decodeContextRecord(rename(OLD_NOTEBOOK)), { kind: "notebook", text: "GOAL: ship slice 2" });
		assert.equal(decodeContextRecord(rename(OLD_SUMMARY)).kind, "summary");
		assert.deepEqual(decodeContextRecord(rename(OLD_REMINDER)), { kind: "reminder" });
		assert.deepEqual(decodeContextRecord(rename(OLD_TASK_DONE)), { kind: "task-done" });
		assert.deepEqual(decodeContextRecord(rename(OLD_KEEP_WARM)), { kind: "keep-warm" });
		const cut = { ...OLD_CUT, details: { [CUT_DETAILS_KEY]: OLD_CUT.details.sandyContext } };
		assert.deepEqual(decodeContextRecord(cut), { kind: "cut", details: OLD_CUT.details.sandyContext });
		assert.equal(cutReason('<context reason="model-change">\nbody\n</context>'), "model-change");
	});
});

describe("anything else", () => {
	it("decodes a compaction with a malformed ownership marker as foreign", () => {
		const malformed: unknown[] = [
			true,
			{},
			{ ...OLD_CUT.details.sandyContext, version: 2 },
			{ ...OLD_CUT.details.sandyContext, reason: 5 },
			{ ...OLD_CUT.details.sandyContext, keptFromId: undefined },
			{ ...OLD_CUT.details.sandyContext, archivedEntries: "24" },
			{ ...OLD_CUT.details.sandyContext, unsummarized: { fromId: "a" } },
		];
		for (const marker of malformed) {
			assert.deepEqual(decodeContextRecord({ ...OLD_CUT, details: { sandyContext: marker } }), { kind: "foreign" });
			assert.deepEqual(decodeContextRecord({ ...OLD_CUT, details: { [CUT_DETAILS_KEY]: marker } }), { kind: "foreign" });
		}
	});
	it("decodes pi's own compaction, other extensions' entries and plain messages as foreign", () => {
		assert.deepEqual(decodeContextRecord({ ...OLD_CUT, details: undefined }), { kind: "foreign" });
		assert.deepEqual(decodeContextRecord({ type: "custom", customType: "advisor-watch", data: {} }), { kind: "foreign" });
		assert.deepEqual(decodeContextRecord({ type: "custom", customType: "contextual.notebook", data: { text: "x" } }), { kind: "foreign" });
		assert.deepEqual(decodeContextRecord({ type: "message", message: { role: "user", content: "hi" } }), { kind: "foreign" });
		assert.deepEqual(decodeContextRecord(null), { kind: "foreign" });
		assert.deepEqual(decodeContextRecord("context.notebook"), { kind: "foreign" });
	});
	it("names a record of ours with an unreadable payload invalid instead of trusting it", () => {
		assert.equal(decodeContextRecord({ ...OLD_NOTEBOOK, data: { text: 5 } }).kind, "invalid");
		assert.equal(decodeContextRecord({ ...OLD_SUMMARY, data: { version: 1 } }).kind, "invalid");
		assert.equal(decodeContextRecord({ ...OLD_NOTEBOOK, customType: "context.unknown-kind" }).kind, "invalid");
	});
	it("finds no cut reason in text without a cut tag", () => {
		assert.equal(cutReason("<sandy-contextual reason=\"x\">"), undefined);
		assert.equal(cutReason("no tag here"), undefined);
	});
	it("finds no cut reason in a foreign summary that quotes a cut tag", () => {
		assert.equal(cutReason('Foreign quotes <context reason="task">quoted</context>'), undefined);
		assert.equal(cutReason('Earlier:\n<sandy-context reason="watermark">'), undefined);
	});
});

describe("the summary's projection marker", () => {
	const summary = (data: Record<string, unknown>) => ({ type: "custom", customType: SUMMARY_KIND, data: { ...OLD_SUMMARY.data, ...data } });
	it("reads the entry the historian read the projection at", () => {
		const record = decodeContextRecord(summary({ projectedThroughId: "e42" }));
		assert.equal(record.kind, "summary");
		assert.equal(record.kind === "summary" ? record.projectedThroughId : "", "e42");
	});
	it("reads an old summary, or a marker that is no id, as unmarked", () => {
		for (const record of [decodeContextRecord(OLD_SUMMARY), decodeContextRecord(summary({ projectedThroughId: 7 }))]) {
			assert.equal(record.kind, "summary");
			assert.equal(record.kind === "summary" ? record.projectedThroughId : "", undefined);
		}
	});
});

describe("the requests a summary tells of", () => {
	const summary = (data: Record<string, unknown>) => ({ type: "custom", customType: SUMMARY_KIND, data: { ...OLD_SUMMARY.data, ...data } });
	const figures = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 };
	const requestsOf = (record: ReturnType<typeof decodeContextRecord>) => ("requests" in record ? record.requests : undefined);
	it("reads the historian's usage and the condenser's when one ran, from pi-ai usage or stored figures", () => {
		const piAi = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 5 } };
		assert.deepEqual(requestsOf(decodeContextRecord(summary({ usage: piAi, condenseUsage: figures }))), [
			{ step: "summarize", usage: figures },
			{ step: "condense", usage: figures },
		]);
	});
	it("reads a usage that is missing or unreadable as undefined, and no condenser request as none", () => {
		assert.deepEqual(requestsOf(decodeContextRecord(OLD_SUMMARY)), [{ step: "summarize", usage: undefined }]);
		assert.deepEqual(requestsOf(decodeContextRecord(summary({ usage: { input: "many" } }))), [{ step: "summarize", usage: undefined }]);
	});
	it("keeps the requests of a summary whose state cannot be read", () => {
		const record = decodeContextRecord(summary({ sections: "none", usage: figures }));
		assert.equal(record.kind, "invalid");
		assert.deepEqual(requestsOf(record), [{ step: "summarize", usage: figures }]);
	});
});
