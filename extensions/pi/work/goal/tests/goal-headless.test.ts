import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { interactive, isHeadless, parseGoalTargetArgs } from "../extensions/goal-headless.ts";
import { createGoal, goalFocusDetails, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

function createHarness(cwd: string, sessionEntries: unknown[]) {
	const notifications: string[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
	const handlers = new Map<string, Function>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	let activeTools = ["read", "bash", "edit", "write"];
	const dialogs: string[] = [];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) => { commands.set(name, definition); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); },
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: true,
	};
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "headless-test-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => { dialogs.push("select"); return undefined; },
			confirm: async () => { dialogs.push("confirm"); return false; },
			input: async () => { dialogs.push("input"); return undefined; },
			custom: async () => { dialogs.push("custom"); return undefined; },
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any);
	return { ctx, commands, handlers, notifications, dialogs, appended };
}

function createFixture(count: number) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-headless-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ autoSelectSingleGoal: false, disabled: true }));
	const goals: GoalRecord[] = [];
	for (let i = 0; i < count; i++) {
		const goal = createGoal({ objective: `Headless goal ${i}`, autoContinue: false, sisyphus: false });
		goals.push(writeActiveGoalFile({ cwd } as ExtensionContext, goal));
	}
	const archived = () => readdirSync(path.join(cwd, ".pi", "goals", "archived")).filter((name) => name.endsWith(".md"));
	return { cwd, goals, archived, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function withHeadless<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
	const previous = process.env.PI_GOAL_HEADLESS;
	if (value === undefined) delete process.env.PI_GOAL_HEADLESS;
	else process.env.PI_GOAL_HEADLESS = value;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.PI_GOAL_HEADLESS;
		else process.env.PI_GOAL_HEADLESS = previous;
	}
}

test("parseGoalTargetArgs reads an optional id and --yes in any order", () => {
	assert.deepEqual(parseGoalTargetArgs(""), { yes: false });
	assert.deepEqual(parseGoalTargetArgs(undefined), { yes: false });
	assert.deepEqual(parseGoalTargetArgs("abc-1"), { id: "abc-1", yes: false });
	assert.deepEqual(parseGoalTargetArgs("--yes abc-1"), { id: "abc-1", yes: true });
	assert.deepEqual(parseGoalTargetArgs(" abc-1  -y "), { id: "abc-1", yes: true });
});

test("interactive needs a UI and no PI_GOAL_HEADLESS=1", () => {
	assert.equal(isHeadless({}), false);
	assert.equal(isHeadless({ PI_GOAL_HEADLESS: "1" }), true);
	assert.equal(isHeadless({ PI_GOAL_HEADLESS: "0" }), false);
	assert.equal(interactive({ hasUI: true }, {}), true);
	assert.equal(interactive({ hasUI: false }, {}), false);
	assert.equal(interactive({ hasUI: true }, { PI_GOAL_HEADLESS: "1" }), false);
});

test("headless /goal-clear <id> --yes archives that goal without a dialog", async () => {
	const fixture = createFixture(2);
	const target = fixture.goals[1]!;
	const harness = createHarness(fixture.cwd, []);
	try {
		await withHeadless("1", async () => {
			await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
			await harness.commands.get("goal-clear")!.handler(`${target.id} --yes`, harness.ctx);
		});
		assert.deepEqual(harness.dialogs, []);
		assert.equal(existsSync(path.join(fixture.cwd, target.activePath!)), false);
		assert.equal(fixture.archived().length, 1);
		assert.match(fixture.archived()[0]!, new RegExp(target.id));
		assert.equal(existsSync(path.join(fixture.cwd, fixture.goals[0]!.activePath!)), true, "the other goal stays open");
	} finally {
		fixture.cleanup();
	}
});

test("headless /goal-clear without --yes changes nothing and names the --yes form", async () => {
	const fixture = createFixture(1);
	const goal = fixture.goals[0]!;
	const harness = createHarness(fixture.cwd, [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }]);
	try {
		await withHeadless("1", async () => {
			await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
			await harness.commands.get("goal-clear")!.handler("", harness.ctx);
		});
		assert.deepEqual(harness.dialogs, []);
		assert.equal(fixture.archived().length, 0);
		assert.match(harness.notifications.at(-1) ?? "", new RegExp(`${goal.id} --yes`));
	} finally {
		fixture.cleanup();
	}
});

test("interactive /goal-clear still asks, and a declined dialog changes nothing", async () => {
	const fixture = createFixture(1);
	const goal = fixture.goals[0]!;
	const harness = createHarness(fixture.cwd, [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }]);
	try {
		await withHeadless(undefined, async () => {
			await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
			await harness.commands.get("goal-clear")!.handler("", harness.ctx);
		});
		assert.deepEqual(harness.dialogs, ["confirm"]);
		assert.equal(fixture.archived().length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("/goal-focus <id> focuses that goal without a selector; an unknown id warns", async () => {
	const fixture = createFixture(2);
	const target = fixture.goals[1]!;
	const harness = createHarness(fixture.cwd, []);
	try {
		await withHeadless("1", async () => {
			await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
			await harness.commands.get("goal-focus")!.handler("no-such-goal", harness.ctx);
			assert.match(harness.notifications.at(-1) ?? "", /No open goal with id no-such-goal/);
			await harness.commands.get("goal-focus")!.handler(target.id, harness.ctx);
		});
		assert.deepEqual(harness.dialogs, []);
		const focus = [...harness.appended].reverse().find((entry) => entry.customType === "pi-goal-focus");
		assert.equal((focus?.data as { focusedGoalId?: string } | undefined)?.focusedGoalId, target.id);
		assert.match(harness.notifications.at(-1) ?? "", /Focused goal/);
	} finally {
		fixture.cleanup();
	}
});
