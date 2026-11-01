import { describe, expect, it } from "vitest";
import { parseState } from "../src/core/proposals.ts";
import { StateWatch, notesMessage } from "../src/core/watch.ts";
import { DEFAULTS } from "../src/core/config.ts";
import { Advisor } from "../src/core/runtime.ts";

const state = (tasks: string[], notes: { text: string; at: number }[] = [], intent = "intent_9") =>
	parseState(JSON.stringify({ thread: "thr_1", intent: { id: intent, title: "T", state: "proposed", doneWhen: "" }, idea: null, tasks: tasks.map((key) => ({ key, title: key, status: "todo" })), notes }))!;

describe("StateWatch", () => {
	it("reports nothing on the first read: the session started knowing its tasks and notes", () => {
		const w = new StateWatch();
		expect(w.update(state(["IDEA-1"], [{ text: "old", at: 1 }]))).toEqual({ closed: [], notes: [] });
	});
	it("reports a task that left the open list as closed, once", () => {
		const w = new StateWatch();
		w.update(state(["IDEA-1", "IDEA-2"]));
		expect(w.update(state(["IDEA-2", "IDEA-3"])).closed).toEqual(["IDEA-1"]);
		expect(w.update(state(["IDEA-2", "IDEA-3"])).closed).toEqual([]);
	});
	it("after a restart, reports a task closed while no process ran, but not the notes the new session was briefed with", () => {
		const before = new StateWatch();
		before.update(state(["IDEA-1", "IDEA-2"], [{ text: "old", at: 1 }]));
		const after = new StateWatch();
		after.restore(before.snapshot()!);
		expect(after.update(state(["IDEA-2"], [{ text: "old", at: 1 }, { text: "briefed", at: 2 }]))).toEqual({ closed: ["IDEA-1"], notes: [] });
		expect(after.update(state(["IDEA-2"], [{ text: "new", at: 3 }])).notes.map((n) => n.text)).toEqual(["new"]);
	});
	it("does not call a switch to another intent a finished task", () => {
		const w = new StateWatch();
		w.update(state(["IDEA-1"]));
		expect(w.update(state(["IDEA-7"], [], "intent_10")).closed).toEqual([]);
	});
	it("reports owner notes newer than any it has seen, once", () => {
		const w = new StateWatch();
		w.update(state([], [{ text: "old", at: 1 }]));
		expect(w.update(state([], [{ text: "old", at: 1 }, { text: "also pan", at: 5 }])).notes).toEqual([{ text: "also pan", at: 5 }]);
		expect(w.update(state([], [{ text: "old", at: 1 }, { text: "also pan", at: 5 }])).notes).toEqual([]);
	});
	it("writes new owner notes as one message that tells the session to fold them in, not to drop its work", () => {
		const t = notesMessage([{ text: "also pan", at: 5 }, { text: "no zoom on desktop", at: 6 }]);
		expect(t).toContain("also pan");
		expect(t).toContain("no zoom on desktop");
		expect(t).toMatch(/aktuelle[nr]? Task/);
	});
	it("Advisor.poll reads the ideas state each time and reports a closed task", async () => {
		const outs = [state(["IDEA-1"]), state([])].map((s) => JSON.stringify(s));
		const a = new Advisor({ config: DEFAULTS, complete: async () => { throw new Error("no model call"); }, exec: async () => ({ code: 0, stdout: outs.shift() ?? "", stderr: "" }), sandy: "sandy", sessionId: "s", threadId: "thr_1", entries: () => [] });
		expect(await a.poll()).toEqual({ closed: [], notes: [] });
		expect((await a.poll())?.closed).toEqual(["IDEA-1"]);
	});
	it("reads a state without notes from an older ideas plugin", () => {
		const s = parseState(JSON.stringify({ thread: "thr_1", intent: null, idea: null, tasks: [] }))!;
		expect(s.notes).toEqual([]);
	});
});
