import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CUT_DETAILS_KEY, KEEP_WARM_KIND, NOTEBOOK_KIND, REMINDER_KIND, SUMMARY_KIND, TASK_DONE_KIND } from "../src/core/kinds.ts";
import { archivedReads } from "../src/core/signals.ts";
import { emptySections, type SummaryState } from "../src/core/summary.ts";
import { type BranchSource, SessionTape } from "../src/pi/session.ts";
import { piSdk } from "./support/pi.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";

/*
 * The session tape follows a growing branch. Additions are read from the new tail only; an edit, a cut or a branch
 * change reads the branch again, through the same canonical projection as a fresh `SessionTape.read`, which every
 * step here is compared with.
 */

type Manager = ReturnType<typeof piSdk.SessionManager.inMemory>;

const VERSION = piSdk.VERSION;
const project = piSdk.buildSessionProjection;
let clock = Date.UTC(2026, 9, 9, 12, 0, 0);
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const cutDetails = (keptFromId: string) => ({ version: 1, reason: "watermark", keptFromId, archivedEntries: 0, blockTokens: 0 });

/** A session written through pi's SessionManager. */
function sessionLog(manager: Manager = piSdk.SessionManager.inMemory()) {
	const assistant = (content: unknown[], stopReason: string) =>
		manager.appendMessage({
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage,
			stopReason,
			timestamp: ++clock,
		} as never);
	return {
		manager,
		user: (text: string) => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: ++clock }),
		call: (callId: string, name: string, args: Record<string, unknown>) =>
			assistant([{ type: "toolCall", id: callId, name, arguments: args }], "toolUse"),
		calls: (calls: readonly { id: string; args: Record<string, unknown> }[]) =>
			assistant(
				calls.map((call) => ({ type: "toolCall", id: call.id, name: "read", arguments: call.args })),
				"toolUse",
			),
		result: (callId: string, text: string) =>
			manager.appendMessage({
				role: "toolResult",
				toolCallId: callId,
				toolName: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: ++clock,
			} as never),
		answer: (text: string) => assistant([{ type: "text", text }], "stop"),
		replace: (targetId: string, text: string) => manager.appendContextEdit(targetId, { content: [{ type: "text", text }] }),
		omit: (targetId: string) => manager.appendContextEdit(targetId, null),
		ownCut: (keptId: string) =>
			manager.appendCompaction('<context reason="watermark">cut</context>', keptId, 0, { [CUT_DETAILS_KEY]: cutDetails(keptId) }, true),
		foreign: (keptId: string) => manager.appendCompaction("FOREIGN-SUMMARY", keptId, 0, undefined, false),
		summary: (coveredThroughId: string) => {
			const state: SummaryState = { version: 1, coveredThroughId, sections: { ...emptySections(), goal: ["goal"] } };
			return manager.appendCustomEntry(SUMMARY_KIND, state);
		},
		ping: () => manager.appendCustomMessageEntry(KEEP_WARM_KIND, "ping", false),
		/** One turn reading `path`: a prompt, the call, its result, an answer. */
		turn: (label: string, path = "src/" + label + ".ts") => {
			const log = sessionLog(manager);
			const user = log.user("Please look at " + label + ".");
			const call = log.call("c-" + label, "read", { path });
			const result = log.result("c-" + label, "FACT " + label + "\n" + "x".repeat(400));
			const answer = log.answer("Looked at " + label + ".");
			return { user, call, result, answer };
		},
	};
}
type Log = ReturnType<typeof sessionLog>;

/** A source over pi's manager that counts what the tape asks of it. */
function counted(manager: Manager): BranchSource & { readonly asked: { branch: number; entry: number } } {
	const asked = { branch: 0, entry: 0 };
	return {
		asked,
		getLeafId: () => manager.getLeafId(),
		getEntry: (id) => {
			asked.entry++;
			return manager.getEntry(id);
		},
		getBranch: (fromId) => {
			asked.branch++;
			return manager.getBranch(fromId);
		},
	};
}

/** The followed tape against a full canonical replay of the branch: every view, the state and the archived reads. */
function assertEqualsReplay(followed: SessionTape, manager: Manager, step: string): void {
	const replay = SessionTape.read(manager.getBranch(), project, DEFAULT_CONFIG);
	assert.deepEqual(followed.state, replay.state, step + ": state");
	assert.deepEqual(followed.modelView(), replay.modelView(), step + ": model view");
	assert.deepEqual(followed.history(), replay.history(), step + ": history");
	assert.deepEqual(followed.archive().items, replay.archive().items, step + ": archive");
	const history = replay.history();
	assert.deepEqual(
		[...followed.archivedReads()].sort(),
		[...archivedReads(history.entries, history.visibleFromIndex)].sort(),
		step + ": archived reads",
	);
}

function follow(log: Log): { tape: SessionTape; source: ReturnType<typeof counted> } {
	const source = counted(log.manager);
	return { tape: SessionTape.follow(source, project, DEFAULT_CONFIG), source };
}

/** A small deterministic generator, so a failing step can be replayed from its seed. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Applies one generated operation; returns its name. */
function step(log: Log, next: () => number, counter: number): string {
	const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];
	const branch = log.manager.getBranch();
	const messages = branch.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message");
	const users = messages.filter((entry) => entry.message.role === "user");
	const roll = next();
	const label = "g" + counter;
	if (roll < 0.28) return log.turn(label, "src/f" + Math.floor(next() * 5) + ".ts"), "turn";
	if (roll < 0.36) return log.user("prompt " + label), "user";
	if (roll < 0.42) return log.answer("answer " + label), "answer";
	if (roll < 0.5) {
		const ids = [label + "a", label + "b", label + "c"];
		log.calls(ids.map((id, index) => ({ id, args: { path: "src/f" + ((counter + index) % 5) + ".ts" } })));
		for (const id of ids) log.result(id, "result " + id);
		return "parallel results";
	}
	if (roll < 0.55) return log.manager.appendCustomEntry("accounting.record", { tokens: counter }), "accounting record";
	if (roll < 0.58) return log.manager.appendCustomEntry(NOTEBOOK_KIND, { text: "note " + label }), "notebook";
	if (roll < 0.6) return log.manager.appendCustomEntry(TASK_DONE_KIND, {}), "task done";
	if (roll < 0.63) return log.manager.appendCustomMessageEntry(REMINDER_KIND, "remind", false), "reminder";
	if (roll < 0.66) return log.manager.appendModelChange("faux", "faux-" + counter), "model change";
	if (roll < 0.68) return log.manager.appendUsage("cache_warm", "faux", "faux-1", usage), "cache refresh";
	if (roll < 0.7) {
		const target = pick(messages);
		return target ? (log.manager.appendLabelChange(target.id, "label " + label), "label") : "none";
	}
	if (roll < 0.75) {
		log.ping();
		if (next() < 0.6) log.answer("ok");
		return "ping";
	}
	if (roll < 0.8) {
		const target = pick(messages);
		if (!target) return "none";
		return next() < 0.5 ? (log.replace(target.id, "replaced " + label), "replace") : (log.omit(target.id), "omit");
	}
	if (roll < 0.85) {
		const kept = pick(users);
		return kept ? (log.ownCut(kept.id), "own cut") : "none";
	}
	if (roll < 0.88) {
		const kept = pick(users);
		return kept ? (log.foreign(kept.id), "foreign cut") : "none";
	}
	if (roll < 0.91) {
		const covered = pick(messages);
		return covered ? (log.summary(covered.id), "summary") : "none";
	}
	const target = pick(branch);
	return target ? (log.manager.branch(target.id), "jump") : "none";
}

describe("the incremental session tape on pi " + VERSION + ": equals a full replay", () => {
	for (const seed of [1, 2, 3, 4, 5, 6]) {
		it("after every generated append, edit, cut and jump, seed " + seed, () => {
			const next = random(seed);
			const log = sessionLog();
			log.turn("start");
			const { tape } = follow(log);
			// Even seeds read after every operation; odd seeds let several entries pile up between reads.
			for (let index = 0; index < 120; index++) {
				const name = step(log, next, index);
				if (seed % 2 === 1 && next() < 0.5) continue;
				tape.refresh(log.manager.getLeafId());
				assertEqualsReplay(tape, log.manager, "seed " + seed + " step " + index + " (" + name + ")");
			}
		});
	}

	it("after a reminder, a task-done record, a summary and a notebook, which move the leaf without a rebuild", () => {
		const log = sessionLog();
		const first = log.turn("a");
		log.turn("b");
		log.ownCut(first.user);
		log.turn("c");
		const { tape } = follow(log);
		const rebuilds = tape.stats.rebuilds;
		const writes = [
			() => log.manager.appendCustomMessageEntry(REMINDER_KIND, "remind", false),
			() => log.manager.appendCustomEntry(TASK_DONE_KIND, {}),
			() => log.summary(first.result),
			() => log.manager.appendCustomEntry(NOTEBOOK_KIND, { text: "n" }),
			() => log.manager.appendCustomEntry("accounting.record", { tokens: 1 }),
			() => log.manager.appendUsage("cache_warm", "faux", "faux-1", usage),
		];
		for (const [index, write] of writes.entries()) {
			write();
			tape.refresh();
			assertEqualsReplay(tape, log.manager, "write " + index);
		}
		assert.equal(tape.stats.rebuilds, rebuilds, "none of them reads the branch again");
		assert.equal(tape.stats.appended, writes.length);
	});
});

describe("the incremental session tape on pi " + VERSION + ": work", () => {
	it("ingests 100 appended results without reading the branch again", () => {
		const log = sessionLog();
		const turns = ["a", "b", "c", "d"].map((label) => log.turn(label));
		log.ownCut(turns[2]?.user ?? "");
		log.turn("e");
		const { tape, source } = follow(log);
		assert.ok(tape.archivedReads().has("src/a.ts"), "the cut archived the read of a.ts");
		const before = { ...tape.stats };
		const branchReads = source.asked.branch;
		const entryReads = source.asked.entry;
		assert.equal(before.rebuilds, 1);
		for (let index = 0; index < 100; index++) {
			log.call("n" + index, "read", { path: "src/n" + (index % 7) + ".ts" });
			log.result("n" + index, "new " + index);
			tape.refresh();
			assert.ok(tape.archivedReads().has("src/a.ts"));
			assert.ok(!tape.archivedReads().has("src/n0.ts"));
		}
		assert.equal(tape.stats.rebuilds, before.rebuilds, "no rebuild");
		assert.equal(tape.stats.appended - before.appended, 200, "each new entry is ingested once");
		assert.equal(source.asked.branch, branchReads, "the manager's branch is not read again");
		assert.ok(source.asked.entry - entryReads <= 200 + 100, "entries asked for: the new tail and one known entry per read");
		assert.equal(tape.stats.viewBuilds, before.viewBuilds, "no view is rebuilt to answer the archived reads");
		assertEqualsReplay(tape, log.manager, "after 100 results");
	});

	it("ingests ten results of one turn as ten entries, not ten branches", () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c"]) log.turn(label);
		const { tape, source } = follow(log);
		const before = { ...tape.stats };
		const branchReads = source.asked.branch;
		const ids = Array.from({ length: 10 }, (_, index) => "p" + index);
		log.calls(ids.map((id) => ({ id, args: { path: "src/" + id + ".ts" } })));
		for (const id of ids) {
			log.result(id, "result " + id);
			tape.refresh();
		}
		assert.equal(tape.stats.rebuilds, before.rebuilds);
		assert.equal(tape.stats.appended - before.appended, 11, "the call and its ten results");
		assert.equal(source.asked.branch, branchReads);
		assertEqualsReplay(tape, log.manager, "after ten results");
	});

	it("keeps the revision when the leaf did not move and advances it when it did", () => {
		const log = sessionLog();
		log.turn("a");
		const { tape } = follow(log);
		const revision = tape.refresh();
		assert.equal(tape.refresh(), revision);
		log.answer("more");
		assert.ok(tape.refresh() > revision);
	});

	it("builds a view once per revision", () => {
		const log = sessionLog();
		log.turn("a");
		const { tape } = follow(log);
		tape.modelView();
		tape.history();
		tape.archive();
		assert.equal(tape.stats.viewBuilds, 1);
		log.answer("more");
		tape.refresh();
		tape.history();
		assert.equal(tape.stats.viewBuilds, 2);
	});

	it("follows an empty session and its first entries", () => {
		const log = sessionLog();
		const { tape } = follow(log);
		assert.equal(tape.state.leafId, undefined);
		assert.equal(tape.archivedReads().size, 0);
		log.turn("a");
		tape.refresh();
		assertEqualsReplay(tape, log.manager, "first turn");
	});
});

describe("the incremental session tape on pi " + VERSION + ": what rebuilds", () => {
	const scenario = () => {
		const log = sessionLog();
		const turns = ["a", "b", "c", "d"].map((label) => log.turn(label));
		return { log, turns, ...follow(log) };
	};
	const expectRebuild = (name: string, change: (s: ReturnType<typeof scenario>) => void) =>
		it("rebuilds once on " + name, () => {
			const s = scenario();
			const before = s.tape.stats.rebuilds;
			change(s);
			s.tape.refresh();
			assert.equal(s.tape.stats.rebuilds, before + 1);
			assertEqualsReplay(s.tape, s.log.manager, name);
			s.log.answer("and on");
			s.tape.refresh();
			assert.equal(s.tape.stats.rebuilds, before + 1, "an append after it is incremental again");
			assertEqualsReplay(s.tape, s.log.manager, name + ", then an append");
		});

	expectRebuild("a replacing edit", ({ log, turns }) => log.replace(turns[0]?.result ?? "", "withdrawn"));
	expectRebuild("an omitting edit", ({ log, turns }) => log.omit(turns[1]?.result ?? ""));
	expectRebuild("our own cut", ({ log, turns }) => log.ownCut(turns[2]?.user ?? ""));
	expectRebuild("a foreign compaction", ({ log, turns }) => log.foreign(turns[2]?.user ?? ""));
	expectRebuild("a jump back to an ancestor", ({ log, turns }) => log.manager.branch(turns[1]?.answer ?? ""));
	expectRebuild("a jump to an ancestor followed by new entries", ({ log, turns }) => {
		log.manager.branch(turns[1]?.answer ?? "");
		log.turn("other");
	});
	expectRebuild("an edit and entries behind it in one read", ({ log, turns }) => {
		log.replace(turns[0]?.result ?? "", "withdrawn");
		log.turn("later");
	});

	it("rebuilds when an appended prompt takes an answered keep-warm ping out of the projection", () => {
		const log = sessionLog();
		log.turn("a");
		const { tape } = follow(log);
		log.ping();
		log.answer("ok");
		tape.refresh();
		assertEqualsReplay(tape, log.manager, "ping answered");
		const before = tape.stats.rebuilds;
		log.answer("still answering");
		tape.refresh();
		assert.equal(tape.stats.rebuilds, before, "more answers keep the ping pending");
		log.user("next prompt");
		tape.refresh();
		assert.equal(tape.stats.rebuilds, before + 1);
		assertEqualsReplay(tape, log.manager, "prompt after ping");
	});
});

describe("the incremental session tape on pi " + VERSION + ": a keep-warm ping and an entry the projection leaves out", () => {
	// An entry that never reaches the model does not end the wait of a ping: the next real prompt still takes the
	// ping's work out of the history, so the archived reads must be read again.
	const leftOut: readonly [string, (log: Log) => void][] = [
		[
			"an omitted prompt",
			(log) => log.omit(log.user("withdrawn prompt")),
		],
		[
			"an omitted custom message",
			(log) => log.omit(log.manager.appendCustomMessageEntry(REMINDER_KIND, "withdrawn", false)),
		],
		[
			"a system message",
			(log) => void log.manager.appendMessage({ role: "system", content: "sys", timestamp: ++clock } as never),
		],
	];
	for (const [name, write] of leftOut) {
		it("follows the archived reads past " + name + " after a ping", () => {
			const log = sessionLog();
			log.turn("a");
			log.ping();
			log.call("ping-read", "read", { path: "src/ping.ts" });
			log.result("ping-read", "FACT ping");
			log.ownCut(log.answer("ok"));
			const { tape } = follow(log);
			assert.deepEqual([...tape.archivedReads()].sort(), ["src/a.ts", "src/ping.ts"], "while the ping waits, its work counts");
			assertEqualsReplay(tape, log.manager, "before " + name);
			write(log);
			tape.refresh();
			tape.archivedReads();
			assertEqualsReplay(tape, log.manager, "after " + name);
			log.user("the next prompt");
			tape.refresh();
			assertEqualsReplay(tape, log.manager, "prompt after " + name);
			assert.deepEqual([...tape.archivedReads()].sort(), ["src/a.ts"], "the prompt took the ping's work out");
		});
	}
});

describe("the incremental session tape on pi " + VERSION + ": cost", () => {
	it("reports elapsed time and memory of reading appends against a full replay", () => {
		const log = sessionLog();
		for (let index = 0; index < 500; index++) log.turn("t" + index);
		const { tape } = follow(log);
		const heapBefore = process.memoryUsage().heapUsed;
		const appendStart = performance.now();
		for (let index = 0; index < 100; index++) {
			log.call("m" + index, "read", { path: "src/m.ts" });
			log.result("m" + index, "result");
			tape.refresh();
			tape.archivedReads();
		}
		const appendMs = performance.now() - appendStart;
		const replayStart = performance.now();
		for (let index = 0; index < 10; index++) SessionTape.read(log.manager.getBranch(), project, DEFAULT_CONFIG).history();
		const replayMs = performance.now() - replayStart;
		console.log(
			"2,000 entries, 100 appended results: incremental " + appendMs.toFixed(1) + " ms, 10 full replays " + replayMs.toFixed(1) +
				" ms, heap delta " + ((process.memoryUsage().heapUsed - heapBefore) / 1e6).toFixed(1) + " MB (informational)",
		);
	});
});
