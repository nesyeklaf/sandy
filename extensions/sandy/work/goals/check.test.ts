import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { snapshot } from "./agent.ts";
import { budget, currentTask, focused, progress, sessionLabel, sessionProgress, sessionTree, title } from "./format.ts";
import { goalRoot, parseGoal, readLedger, sessionActivity, sessionTasks, toEvents } from "./goals.ts";
import { commandText } from "./views.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sandy-goals-"));

/** A goal file in pi-goal-x 0.34's layout: JSON meta, then the markdown body. */
function goalFile(meta: Record<string, unknown>, objective = "Ship the goals plugin") {
  return `${JSON.stringify({ version: 3, ...meta }, null, 2)}\n\n# Goal Prompt\n\n${objective}\n\n## Progress\n\n- Status: active\n`;
}

const base = {
  id: "g1",
  objective: "Ship the goals plugin",
  status: "active",
  autoContinue: true,
  usage: { tokensUsed: 12_000, activeSeconds: 600 },
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:10:00.000Z",
  tokenBudget: 48_000,
  currentTaskId: "t2.1",
  taskList: {
    blockCompletion: true,
    tasks: [
      { id: "t1", title: "Reader", status: "complete", evidence: "tests {pass}" },
      { id: "t2", title: "UI", status: "pending", subtasks: [{ id: "t2.1", title: "Banner", status: "pending", verificationContract: "screenshot" }] },
      { id: "t3", title: "Docs", status: "skipped", skipReason: "later" },
    ],
  },
};

test("parseGoal reads meta, objective and the task tree", () => {
  const goal = parseGoal(goalFile(base, "Ship the goals plugin\nwith a } brace"));
  assert.ok(goal);
  assert.equal(goal.objective, "Ship the goals plugin\nwith a } brace");
  assert.equal(goal.tokensUsed, 12_000);
  assert.equal(goal.blockCompletion, true);
  assert.deepEqual(goal.tasks.map((t) => [t.id, t.status]), [["t1", "complete"], ["t2", "pending"], ["t3", "skipped"]]);
  assert.equal(goal.tasks[0].evidence, "tests {pass}");
  assert.equal(goal.tasks[1].subtasks[0].verificationContract, "screenshot");
  assert.deepEqual(progress(goal), { done: 2, total: 3 });
  assert.equal(currentTask(goal)?.id, "t2.1");
  assert.deepEqual(budget(goal), { used: 12_000, limit: 48_000, pct: 25 });
  assert.equal(parseGoal("not a goal"), null);
  assert.equal(parseGoal('{"version":3}'), null);
});

test("parseGoal agrees with pi/work/goal's own serializer", async (t) => {
  const source = new URL("../../pi/work/goal/extensions/storage/goal-files.ts", import.meta.url);
  if (!existsSync(source)) return t.skip("pi/work/goal not in this checkout");
  const { serializeGoalFile } = await import(source.href);
  const goal = parseGoal(serializeGoalFile({ ...base, pauseReason: "needs a key", pauseSuggestedAction: "add the key", status: "blocked" }));
  assert.ok(goal);
  assert.equal(goal.status, "blocked");
  assert.equal(goal.objective, "Ship the goals plugin");
  assert.equal(goal.pauseSuggestedAction, "add the key");
  assert.equal(goal.tasks[1].subtasks[0].id, "t2.1");
});

test("goalRoot: PI_GOAL_ROOT, then project, then global settings, else <cwd>/.pi/goals", () => {
  const cwd = tmp();
  const agent = tmp();
  assert.equal(goalRoot(cwd, {}, agent), path.join(cwd, ".pi/goals"));
  writeFileSync(path.join(agent, "pi-goal-x-settings.json"), JSON.stringify({ goalsRoot: "/srv/global" }));
  assert.equal(goalRoot(cwd, {}, agent), "/srv/global");
  mkdirSync(path.join(cwd, ".pi"));
  writeFileSync(path.join(cwd, ".pi/pi-goal-x-settings.json"), JSON.stringify({ goalsRoot: "~/goals" }));
  assert.equal(goalRoot(cwd, {}, agent), path.join(homedir(), "goals"));
  assert.equal(goalRoot(cwd, { PI_GOAL_ROOT: "/srv/env" }, agent), "/srv/env");
  // pi-goal-x refuses a relative root; the reader then shows the default instead of guessing.
  assert.equal(goalRoot(cwd, { PI_GOAL_ROOT: "relative" }, agent), path.join(cwd, ".pi/goals"));
});

function workspace() {
  const agent = tmp();
  const cwd = tmp();
  const root = path.join(cwd, ".pi/goals");
  mkdirSync(path.join(root, "archived"), { recursive: true });
  writeFileSync(path.join(root, "active_goal_1_g1.md"), goalFile(base));
  writeFileSync(path.join(root, "active_goal_2_g2.md"), goalFile({ ...base, id: "g2", status: "paused", pauseReason: "waiting", taskList: undefined }, "Second goal"));
  writeFileSync(path.join(root, "active_goal_3_g3.md"), goalFile({ ...base, id: "g3", status: "complete" }, "Done goal"));
  writeFileSync(path.join(root, "notes.md"), "not a goal");
  const old = path.join(root, "archived/goal_old.md");
  const recent = path.join(root, "archived/goal_recent.md");
  writeFileSync(old, goalFile({ ...base, id: "a1", status: "complete" }, "Old"));
  writeFileSync(recent, goalFile({ ...base, id: "a2", status: "complete" }, "Recent"));
  utimesSync(old, new Date(1_000_000), new Date(1_000_000));
  const ledger = [
    { type: "goal_created", goalId: "g1", objective: "Ship", sisyphus: false, autoContinue: true, at: "2026-10-28T10:00:00Z" },
    { type: "audit_started", goalId: "g1", at: "2026-10-28T10:05:00Z" },
    { type: "audit_result", goalId: "g1", verdict: "disapproved", report: "t2 has no evidence", at: "2026-10-28T10:06:00Z" },
    { type: "task_complete", goalId: "g1", taskId: "t1", evidence: "tests pass", at: "2026-10-28T10:07:00Z" },
  ];
  writeFileSync(path.join(root, "goal_events.jsonl"), ledger.map((e) => JSON.stringify(e)).join("\n") + "\n{broken\n");
  return { agent, cwd, root };
}

const read = (threadId = "thr_x") => ({ threadId, cwd: "", archivedLimit: 10, eventLimit: 10 });

test("snapshot without the pi link falls back to the checkout and the first open goal", () => {
  const { agent, cwd, root } = workspace();
  const snap = snapshot(agent, { ...read(), cwd });
  assert.equal(snap.linked, false);
  assert.equal(snap.root, root);
  assert.deepEqual(snap.goals.map((g) => g.id), ["g1", "g2"]);
  assert.equal(snap.focusedId, "g1");
  assert.deepEqual(focused(snap).others, 1);
  assert.equal(snap.goals[0].audit?.verdict, "disapproved");
  assert.equal(snap.goals[0].audit?.report, "t2 has no evidence");
  assert.deepEqual(snap.archived.map((a) => a.id), ["a2", "a1"]);
  assert.deepEqual(snap.events.map((e) => e.type), ["task_complete", "audit_result", "audit_started", "goal_created"]);
  assert.equal(snap.events[0].text, "Completed task t1: tests pass");
  assert.equal(snap.events[1].tone, "bad");
  assert.equal(snap.error, null);
});

test("snapshot follows the pointer and the session's focus entries", () => {
  const { agent, cwd } = workspace();
  const session = path.join(tmp(), "session.jsonl");
  const focus = (id: string | null) => JSON.stringify({ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: id, reason: "selected" } });
  writeFileSync(session, [JSON.stringify({ type: "session" }), focus("g1"), focus("g2")].join("\n") + "\n");
  mkdirSync(path.join(agent, "sandy-goals"));
  writeFileSync(path.join(agent, "sandy-goals/thr_x.json"), JSON.stringify({ cwd, sessionFile: session, agentDir: agent, env: {} }));
  const snap = snapshot(agent, { ...read(), cwd: "/elsewhere" });
  assert.equal(snap.linked, true);
  assert.equal(snap.focusedId, "g2");
  assert.equal(title(focused(snap).goal!), "Second goal");
  writeFileSync(session, focus(null) + "\n");
  assert.equal(snapshot(agent, read()).focusedId, null);
});

test("snapshot of a thread without goals is empty, not an error", () => {
  const snap = snapshot(tmp(), { ...read(), cwd: tmp() });
  assert.deepEqual([snap.root, snap.goals, snap.archived, snap.events, snap.sessionTasks, snap.error], [null, [], [], [], [], null]);
  assert.match(snapshot(tmp(), read()).error ?? "", /no working directory/);
});

test("sessionTasks: the last work-tasks entry wins; bad rows, deleted tasks and partial lines are skipped; version 1 maps", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sandy-goals-tasks-"));
  const file = path.join(dir, "s.jsonl");
  const entry = (tasks: unknown[]) => JSON.stringify({ type: "custom", customType: "work-tasks", data: { version: 1, tasks, updatedAt: 1 }, id: "x", parentId: null, timestamp: "2026-10-28T12:00:00.000Z" });
  assert.deepEqual(sessionTasks(file), []);
  writeFileSync(file, [
    entry([{ id: "1", title: "old", status: "todo" }]),
    JSON.stringify({ type: "message", message: { role: "user", content: "mentions work-tasks" } }),
    entry([
      { id: "1", subject: "Plan", status: "completed" },
      { id: "1.1", subject: "Read code", status: "in_progress", parent: "1", description: "goals.ts", activeForm: "reading code" },
      { id: "2", subject: "Ship", status: "pending", blockedBy: ["1.1"] },
      { id: "3", subject: "bad status", status: "later" },
      { id: "4", subject: "orphan", status: "pending", parent: "gone" },
      { id: "5", subject: "dropped", status: "deleted" },
    ]),
    '{"type":"custom","customType":"work-tasks","data":{"tasks":[{"id"',
  ].join("\n"));
  const tasks = sessionTasks(file);
  assert.deepEqual(tasks.map((t) => [t.id, t.status, t.parent, t.description, t.blockedBy]), [
    ["1", "completed", null, null, []], ["1.1", "in_progress", "1", "goals.ts", []], ["2", "pending", null, null, ["1.1"]], ["4", "pending", "gone", null, []],
  ]);
  const s = sessionProgress(tasks);
  assert.deepEqual([s.done, s.total, s.current?.id, s.current && sessionLabel(s.current)], [1, 4, "1.1", "reading code"]);
  assert.deepEqual(sessionTree(tasks).map((n) => [n.task.id, n.depth]), [["1", 0], ["1.1", 1], ["2", 0], ["4", 0]]);
  appendFileSync(file, "\n" + entry([{ id: "t1", title: "old words", status: "blocked", note: "no access" }, { id: "t2", title: "b", status: "doing" }]));
  assert.deepEqual(sessionTasks(file).map((t) => [t.id, t.subject, t.status, t.description]), [["t1", "old words", "pending", "blocked: no access"], ["t2", "b", "in_progress", null]]);
});

test("sessionActivity: the open tool call of the last assistant message, labeled; finished calls, later user messages and missing files give null", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "sandy-goals-activity-")), "s.jsonl");
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
  const assistant = (...content: unknown[]) => JSON.stringify({ type: "message", timestamp: "2026-10-28T12:00:00.000Z", message: { role: "assistant", content } });
  const result = (id: string) => JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text: 'says "role":"user" and {"toolCallId":"c9"}' }] } });
  const user = JSON.stringify({ type: "message", message: { role: "user", content: "go on" } });
  const label = (name: string, args: Record<string, unknown>) => {
    writeFileSync(file, [user, assistant({ type: "text", text: "ok" }, call("c1", name, args))].join("\n"));
    return sessionActivity(file);
  };
  assert.equal(sessionActivity(file), null);
  assert.deepEqual(label("edit", { path: "/a/b/app.tsx", edits: [] }), { tool: "edit", label: "Editing app.tsx", since: "2026-10-28T12:00:00.000Z" });
  assert.equal(label("write", { path: "/a/notes.md", content: "x" })?.label, "Editing notes.md");
  assert.equal(label("read", { path: "/a/goals.ts" })?.label, "Reading goals.ts");
  assert.equal(label("bash", { command: "npm run test:goals -- --watch=false --reporter=verbose extra" })?.label, "Running npm run test:goals -- --watch=false --r…");
  assert.equal(label("bash", { command: "git status\ngit diff" })?.label, "Running git status");
  const script = label("mcp__builtin_codemode__codemode", { code: "await tools.read({});await tools.bash({});await tools.read({});await tools.grep({});await tools.edit({})" });
  assert.deepEqual([script?.tool, script?.label], ["codemode", "Running script (read, bash, grep)"]);
  assert.equal(label("mcp__sandy__stage_status", {})?.label, "Running stage_status");
  assert.equal(label("grep", { pattern: "x" })?.label, "Running grep");
  // two parallel calls: the newest one without a result; a toolResult line that quotes JSON does not confuse the scan
  writeFileSync(file, [user, assistant(call("c1", "read", { path: "a.ts" }), call("c2", "edit", { path: "b.ts" })), result("c2")].join("\n"));
  assert.equal(sessionActivity(file)?.label, "Reading a.ts");
  writeFileSync(file, [user, assistant(call("c1", "read", { path: "a.ts" })), result("c1")].join("\n"));
  assert.equal(sessionActivity(file), null);
  writeFileSync(file, [user, assistant(call("c1", "read", { path: "a.ts" })), result("c1"), assistant(call("c2", "bash", { command: "ls" }))].join("\n"));
  assert.equal(sessionActivity(file)?.label, "Running ls");
  // an aborted turn: the call stays open, then the user writes again
  appendFileSync(file, "\n" + user);
  assert.equal(sessionActivity(file), null);
  // the final answer has no call; a partial last line is ignored
  writeFileSync(file, [user, assistant(call("c1", "read", { path: "a.ts" })), result("c1"), assistant({ type: "text", text: "done" })].join("\n"));
  assert.equal(sessionActivity(file), null);
  writeFileSync(file, [user, assistant(call("c1", "read", { path: "a.ts" })), '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCa'].join("\n"));
  assert.equal(sessionActivity(file)?.label, "Reading a.ts");
});

test("snapshot carries the open tool call of the linked session", () => {
  const { agent, cwd } = workspace();
  const sessionFile = path.join(cwd, "session.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "message", timestamp: "2026-10-28T12:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } }));
  assert.equal(snapshot(agent, { ...read(), cwd }).sessionActivity, null);
  mkdirSync(path.join(agent, "sandy-goals"));
  writeFileSync(path.join(agent, "sandy-goals/thr_x.json"), JSON.stringify({ cwd, sessionFile, agentDir: agent, env: {} }));
  assert.equal(snapshot(agent, read()).sessionActivity?.label, "Running ls");
});

test("toEvents keeps the newest entries, newest first", () => {
  const { root } = workspace();
  assert.deepEqual(toEvents(readLedger(root), 2).map((e) => e.type), ["task_complete", "audit_result"]);
});

test("button commands: clear needs an id and always passes --yes", () => {
  assert.equal(commandText("goal-pause"), "/goal-pause");
  assert.equal(commandText("goal-focus", "abc-1"), "/goal-focus abc-1");
  assert.equal(commandText("goal-clear", "abc-1"), "/goal-clear abc-1 --yes");
  assert.throws(() => commandText("goal-clear"), /needs a goal id/);
});
