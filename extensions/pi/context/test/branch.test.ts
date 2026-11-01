import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { NOTEBOOK_KIND, TASK_DONE_KIND } from "../src/core/kinds.ts";
import { readBranch } from "../src/pi/branch.ts";

let counter = 0;
const base = () => ({ id: `e${++counter}`, parentId: null, timestamp: new Date(1_000 + counter).toISOString() });

const notebookEntry = (text: string) =>
	({ ...base(), type: "custom", customType: NOTEBOOK_KIND, data: { text } }) as unknown as SessionEntry;

const toolResultNotebook = (text: string) =>
	({
		...base(),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call",
			toolName: "notebook",
			content: [{ type: "text", text: "Notebook saved." }],
			details: { text },
			isError: false,
		},
	}) as unknown as SessionEntry;

const compaction = () =>
	({
		...base(),
		type: "compaction",
		summary: "cut",
		firstKeptEntryId: "none",
		tokensBefore: 0,
	}) as unknown as SessionEntry;

const message = (role: string, content: unknown[]) =>
	({ ...base(), type: "message", message: { role, content } }) as unknown as SessionEntry;

const ownCut = (firstKeptEntryId: string) =>
	({
		...base(),
		type: "compaction",
		summary: "cut",
		firstKeptEntryId,
		tokensBefore: 0,
		details: { sandyContext: { version: 1, reason: "watermark" } },
	}) as unknown as SessionEntry;

const foreignCut = (firstKeptEntryId: string) =>
	({ ...base(), type: "compaction", summary: "pi", firstKeptEntryId, tokensBefore: 0 }) as unknown as SessionEntry;

describe("entry sizes on a branch", () => {
	it("count the assistant's thinking, which the model sees again", () => {
		const thinking = "x".repeat(4_000);
		const [entry] = readBranch([message("assistant", [{ type: "thinking", thinking }, { type: "text", text: "ok" }])]).entries;
		assert.ok(entry && entry.tokens >= 1_000, `thinking not counted: ${entry?.tokens}`);
		assert.equal(entry?.text, "ok", "thinking stays out of the searchable text");
	});

	it("count as visible only what the prompt holds: the latest cut's block and the entries it kept", () => {
		const archived = message("user", [{ type: "text", text: "a".repeat(4_000) }]);
		const kept = message("user", [{ type: "text", text: "b".repeat(400) }]);
		const cut = { ...ownCut(kept.id), summary: "c".repeat(800) } as SessionEntry;
		const after = message("assistant", [{ type: "text", text: "d".repeat(40) }]);
		assert.equal(readBranch([archived, kept, cut, after]).visibleTokens, 100 + 200 + 10);
		assert.equal(readBranch([archived, kept, after]).visibleTokens, 1_000 + 100 + 10);
	});
});

describe("where the historian may start", () => {
	it("covers history this extension archived, so a cut without a summary is summarized later", () => {
		const first = message("user", [{ type: "text", text: "task" }]);
		const kept = message("user", [{ type: "text", text: "next" }]);
		const state = readBranch([first, kept, ownCut(kept.id)]);
		assert.equal(state.visibleFromIndex, 1);
		assert.equal(state.historianFloorIndex, 0);
	});

	it("skips history a compaction of someone else archived", () => {
		const first = message("user", [{ type: "text", text: "task" }]);
		const kept = message("user", [{ type: "text", text: "next" }]);
		const later = message("user", [{ type: "text", text: "later" }]);
		const state = readBranch([first, kept, foreignCut(kept.id), later, ownCut(later.id)]);
		assert.equal(state.historianFloorIndex, 1);
	});
});

describe("a finished task on a branch", () => {
	const taskDone = () => ({ ...base(), type: "custom", customType: TASK_DONE_KIND, data: { closed: ["IDEA-1"] } }) as unknown as SessionEntry;
	const user = (text: string) => message("user", [{ type: "text", text }]);

	it("still asks for a cut in a process started after it was reported", () => {
		assert.equal(readBranch([user("work"), taskDone()]).taskCutPending, true);
	});

	it("is used up by the next prompt", () => {
		assert.equal(readBranch([user("work"), taskDone(), user("next")]).taskCutPending, false);
	});

	it("is used up by a cut", () => {
		const kept = user("work");
		assert.equal(readBranch([kept, taskDone(), ownCut(kept.id)]).taskCutPending, false);
	});
});

describe("notebook state on a branch", () => {
	it("comes from the notebook entry, whoever called the tool", () => {
		const state = readBranch([notebookEntry("plan A")]);
		assert.equal(state.notebook, "plan A");
		assert.equal(state.notebookCurrent, true);
	});

	it("still reads sessions that stored it in the notebook tool result", () => {
		assert.equal(readBranch([toolResultNotebook("old plan")]).notebook, "old plan");
	});

	it("takes the latest write of either kind", () => {
		assert.equal(readBranch([toolResultNotebook("old"), notebookEntry("new")]).notebook, "new");
		assert.equal(readBranch([notebookEntry("new"), toolResultNotebook("newer")]).notebook, "newer");
		assert.equal(readBranch([notebookEntry("plan"), notebookEntry("")]).notebook, "");
	});

	it("is stale after a cut until it is written again", () => {
		const stale = readBranch([notebookEntry("plan"), compaction()]);
		assert.equal(stale.notebook, "plan");
		assert.equal(stale.notebookCurrent, false);
		assert.equal(readBranch([notebookEntry("plan"), compaction(), notebookEntry("plan 2")]).notebookCurrent, true);
	});

	it("ignores notebook entries without text", () => {
		const broken = { ...base(), type: "custom", customType: NOTEBOOK_KIND, data: {} } as unknown as SessionEntry;
		assert.equal(readBranch([notebookEntry("plan"), broken]).notebook, "plan");
	});
});
