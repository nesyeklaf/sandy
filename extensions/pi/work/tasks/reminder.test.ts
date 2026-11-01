import assert from "node:assert/strict";
import { test } from "node:test";
import tasks, { guidelines, names } from "./tasks.ts";
import { EVERY, MARK } from "./reminder.ts";

// The session as pi keeps it: the harness grows a branch of entries, as getBranch() returns them.
function harness(shape: "one" | "four" = "four", active?: string[]) {
  const handlers: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const branch: any[] = [];
  const ctx = { sessionManager: { getBranch: () => branch } };
  const pi = {
    on: (event: string, fn: Function) => { handlers[event] = fn; },
    registerTool: (t: any) => { tools[t.name] = t; },
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
    getActiveTools: () => active ?? ["read", "edit", ...Object.keys(tools)],
  };
  const before = process.env.WORK_TASKS;
  if (shape === "four") process.env.WORK_TASKS = "four";
  else delete process.env.WORK_TASKS;
  tasks(pi);
  if (before === undefined) delete process.env.WORK_TASKS;
  else process.env.WORK_TASKS = before;
  handlers.session_start({}, ctx);
  /** A new run: the user's next message. */
  const run = () => handlers.agent_start({}, ctx);
  /** One assistant message that calls a tool, and that tool's result; returns the note appended, if any. */
  const turn = (toolName = "read", extra: Record<string, unknown> = {}) => {
    branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: toolName, arguments: {} }] } });
    const out = handlers.tool_result({ type: "tool_result", toolName, toolCallId: "c", input: {}, content: [{ type: "text", text: "ok" }], isError: false, ...extra }, ctx);
    const content = out?.content ?? [{ type: "text", text: "ok" }];
    branch.push({ type: "message", message: { role: "toolResult", toolCallId: "c", content } });
    return out ? (content.at(-1).text as string) : undefined;
  };
  const call = (name: string, params: any) => tools[name].execute("x", params);
  return { run, turn, call, tools, branch };
}

for (const shape of ["one", "four"] as const) {
  const n = names(shape);
  const create = (h: ReturnType<typeof harness>, p: any) => (shape === "one" ? h.call("tasks", { action: "create", ...p }) : h.call("TaskCreate", p));
  const update = (h: ReturnType<typeof harness>, p: any) => (shape === "one" ? h.call("tasks", { action: "update", ...p }) : h.call("TaskUpdate", p));

  test(shape + ": the early note comes on the first tool result of a run without open tasks, naming the tool", () => {
    const h = harness(shape);
    h.run();
    const note = h.turn();
    assert.ok(note?.startsWith(MARK + " No open tasks."));
    assert.ok(note!.includes(n.create) && note!.includes(n.update));
    assert.match(note!, /before your first edit/);
    assert.match(note!, /ignore this/);
  });

  test(shape + ": then a small note every " + EVERY + " turns without a list change, saying what is in progress", async () => {
    const h = harness(shape);
    h.run();
    h.turn();
    await create(h, { subject: "Write the parser", activeForm: "Writing the parser" });
    await create(h, { subject: "Run tests" });
    for (let i = 1; i < EVERY; i++) assert.equal(h.turn(), undefined, "quiet turn " + i);
    assert.equal(h.turn(), MARK + " Nothing in_progress; next: #1 Writing the parser. Set it in_progress with " + n.update + " before you work on it.");
    await update(h, { taskId: "1", status: "in_progress" });
    for (let i = 1; i < EVERY; i++) assert.equal(h.turn(), undefined);
    assert.equal(h.turn(), MARK + " Now: #1 Writing the parser (in_progress). When it is done, set it completed and the next one in_progress with " + n.update + ".");
    for (let i = 1; i < EVERY; i++) assert.equal(h.turn(), undefined, "a note resets the count too");
    assert.ok(h.turn()?.startsWith(MARK + " Now:"));
  });

  test(shape + ": no list after the early note gets a regular nudge; a finished list is quiet", async () => {
    const h = harness(shape);
    h.run();
    h.turn();
    for (let i = 1; i < EVERY; i++) h.turn();
    assert.match(h.turn()!, /Still no open tasks after \d+ turns/);
    await create(h, { subject: "Do it" });
    await update(h, { taskId: "1", status: "completed" });
    for (let i = 0; i < 3 * EVERY; i++) assert.equal(h.turn(), undefined, "done in this run: wrap-up stays quiet");
    h.run();
    assert.ok(h.turn()?.startsWith(MARK + " No open tasks."), "the next request starts with the early note again");
  });

  test(shape + ": a run with open tasks skips the early note; nested results and a goal keep it quiet", async () => {
    const h = harness(shape);
    await create(h, { subject: "Open one" });
    h.run();
    assert.equal(h.turn(), undefined);
    const nested = harness(shape);
    nested.run();
    assert.equal(nested.turn("bash", { parentToolCallId: "outer" }), undefined);
    const hidden = harness(shape, ["read", "edit", "set_goal_tasks"]);
    hidden.run();
    for (let i = 0; i < 2 * EVERY; i++) assert.equal(hidden.turn(), undefined);
  });

  test(shape + ": the same rules in the system prompt, only the tool names differ", () => {
    const h = harness(shape);
    const first = Object.values(h.tools)[0];
    assert.deepEqual(first.promptGuidelines, guidelines(n));
    assert.match(first.promptGuidelines.join(" "), /BEFORE your first edit[\s\S]*BEFORE you start[\s\S]*IMMEDIATELY/);
    assert.equal(guidelines(names("one")).join("").replaceAll(names("one").create, "C").replaceAll(names("one").update, "U"),
      guidelines(names("four")).join("").replaceAll("TaskCreate", "C").replaceAll("TaskUpdate", "U"));
  });
}

test("a resumed session counts from its branch: a note already given there is not repeated", async () => {
  const h = harness();
  h.run();
  h.turn();
  await h.call("TaskCreate", { subject: "x" });
  for (let i = 0; i < EVERY; i++) h.turn();
  const again = harness();
  again.branch.push(...h.branch);
  for (let i = 1; i < EVERY; i++) assert.equal(again.turn(), undefined);
  assert.ok(again.turn()?.startsWith(MARK));
});

test("the default, without WORK_TASKS, is one tool: tasks with an action answers like the four", async () => {
  const h = harness("one");
  assert.deepEqual(Object.keys(h.tools), ["tasks"]);
  assert.equal((await h.call("tasks", { action: "list" })).content[0].text, "No tasks found");
  assert.equal((await h.call("tasks", { action: "create", subject: "Run tests", activeForm: "Running tests" })).content[0].text, "Task #1 created successfully: Run tests");
  assert.equal((await h.call("tasks", { action: "update", taskId: "1", status: "in_progress" })).content[0].text, "Updated task #1 status");
  assert.match((await h.call("tasks", { action: "get", taskId: "1" })).content[0].text, /Running tests/);
  assert.equal((await h.call("tasks", { action: "nope" })).isError, true);
});

test("WORK_TASKS=four: the four tools answer like Claude Code's and keep the list as one session entry per change", async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.tools).sort(), ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
  assert.equal((await h.call("TaskList", {})).content[0].text, "No tasks found");
  assert.equal((await h.call("TaskCreate", { subject: "Run tests", description: "npm test", activeForm: "Running tests" })).content[0].text, "Task #1 created successfully: Run tests");
  await h.call("TaskCreate", { subject: "Fix the bug", description: "x" });
  assert.equal((await h.call("TaskUpdate", { taskId: "1", status: "in_progress" })).content[0].text, "Updated task #1 status");
  await h.call("TaskUpdate", { taskId: "1", addBlocks: ["2"] });
  assert.equal((await h.call("TaskList", {})).content[0].text, "#1 [in_progress] Run tests\n#2 [pending] Fix the bug [blocked by #1]");
  const missing = await h.call("TaskUpdate", { taskId: "9", status: "completed" });
  assert.equal(missing.content[0].text, "Task #9 not found");
  assert.notEqual(missing.isError, true, "not found is benign, as in Claude Code");
  assert.match((await h.call("TaskGet", { taskId: "1" })).content[0].text, /Running tests[\s\S]*Blocks: #2/);
  await h.call("TaskUpdate", { taskId: "2", status: "deleted" });
  assert.equal((await h.call("TaskList", {})).content[0].text, "#1 [in_progress] Run tests");
  assert.equal(h.branch.filter((e) => e.customType === "work-tasks").length, 5, "every change, not the reads, lands on the branch");
});

