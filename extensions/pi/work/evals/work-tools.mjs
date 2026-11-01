#!/usr/bin/env node
// Behavior check for the Work tools (AGENTS.md "Work tools"): does a fresh pi session with the installed setup use
// them as the rules say? It runs real model turns, so it is not part of npm test; run it after changing AGENTS.md,
// a tool description or the model:  node pi/work/evals/work-tools.mjs [--model provider/id] [--case name] [--keep]
// Always with an explicit model (default below): pi -p without one picked openai-codex/gpt-6-astra here.
//
// Cases, each in a fresh temp git repo with its own session dir:
//   multi-step: a task with three separate changes. Expect a tasks list set before the first edit, at least three
//               tasks, every one completed at the end, each one in_progress before it was completed and no call
//               completing several at once. Small enough that a model may do it in two calls, which is the
//               temptation the rule is about.
//   feature:    a change across store, CLI, two test files and the README that takes minutes. Same expectation,
//               with at least four tasks.
//   bugs:       four independent bugs behind a red suite, then a small feature with a test and docs: several
//               rounds of reading, fixing and running the tests, the longest case. Same expectation.
//   real:       a real change on a copy of pi/work/tasks (owner field, blocker warning, tests, README), the
//               largest case. Same expectation.
//   random:     with --seed <n>: a fresh task from random-task.mjs with ten numbered requirements; besides the list
//               checks, hidden tests judge the result afterwards (SCORE k/10). With --seed only this case runs.
//   resume:     only with --case resume: a medium feature from idea to a fake release (resume-task.mjs), the agent alone;
//               hidden behavior and release checks judge it afterwards (SCORE k/19).
//   one-step:   a question about one file. Expect no tasks list (the rule is "more than two steps").
// The verdict reads the session file: pi/work's task tools append each list as a "work-tasks" custom entry (rpiv-todo
// as "rpiv-todo-state"). Each
// run also replays what the composer banner showed at its 4 s poll (replay below); --session <file> scores a
// recorded session, an eval run or a real one, the same way.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "anthropic/claude-sonnet-5-5";
const keep = args.includes("--keep");
const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
const TIMEOUT_MS = 15 * 60 * 1000;
// --rpiv <index.ts>: the comparison setup, rpiv-todo's single `todo` tool (guidelines only, no reminder) in place of
// pi/work's task tools, which are excluded, so their reminder stays quiet too.
const rpiv = args.includes("--rpiv") ? args[args.indexOf("--rpiv") + 1] : undefined;
// --autopilot: the code keeps the list. The case runs as "/autopilot plan-run <prompt>" (autopilot/autopilots/plan-run.ts):
// one planning step, then one turn per step, in_progress and completed set by the autopilot; the task tools are off.
const autopilot = args.includes("--autopilot");
// --seed <n> (or --case random): a fresh task from random-task.mjs with ten requirements, judged afterwards by hidden
// tests the agent never sees (k/10, plus P2P: the start repo's own tests still pass). --json <file> appends one result
// line per run. Without --seed the seed is random.
const seedArg = args.includes("--seed") ? Number(args[args.indexOf("--seed") + 1]) : undefined;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const random = seedArg !== undefined || only === "random" ? await import("./random-task.mjs") : null;
const seed = seedArg ?? Math.floor(Math.random() * 1e6);
const randomTask = random?.generate(seed);
const resume = only === "resume" ? await import("./resume-task.mjs") : null;
const setup = rpiv || autopilot ? [...(rpiv ? ["-e", rpiv] : []), "--exclude-tools", "TaskCreate,TaskUpdate,TaskList,TaskGet"] : [];

// Old (todo/doing/done/blocked) and current (pending/in_progress/completed/deleted) statuses, so a run against an
// older install compares with a newer one.
const STATE = { todo: "pending", pending: "pending", blocked: "pending", doing: "in_progress", in_progress: "in_progress", done: "completed", completed: "completed", deleted: "deleted" };
const norm = (task) => STATE[task.status] ?? task.status;

/**
 * How the list moved while the work ran. The rules ask for in_progress before a task starts, each completion on its
 * own call, one task in progress at a time, and updates between the edits rather than one at the end.
 */
function liveness(lists, events) {
  const seen = new Map();
  let skipped = 0;
  let batched = 0;
  let crowded = 0;
  let before = 0;
  for (const list of lists) {
    const tasks = list.tasks.filter((t) => norm(t) !== "deleted");
    const done = tasks.filter((t) => norm(t) === "completed").length;
    if (done - before > 1) batched++;
    before = done;
    if (tasks.filter((t) => norm(t) === "in_progress").length > 1) crowded++;
    for (const t of tasks) {
      const now = norm(t);
      if (now === "completed" && !["in_progress", "completed"].includes(seen.get(t.id))) skipped++;
      seen.set(t.id, now);
    }
  }
  let run = 0;
  let quiet = 0;
  for (const e of events) quiet = Math.max(quiet, e.kind === "edit" ? ++run : (run = 0));
  return { updates: lists.length, skipped, batched, crowded, quiet };
}

/** A tasks list set before the first edit, with at least min tasks, all completed at the end, kept up as work moved. */
const planned = (min) => (lists, events) => {
  const problems = [];
  if (lists.length === 0) return ["no tasks list was set"];
  const last = lists.at(-1).tasks;
  if (last.length < min) problems.push(`only ${last.length} tasks in the final list`);
  const open = last.filter((t) => !["completed", "deleted"].includes(norm(t)));
  if (open.length) problems.push(`not done at the end: ${open.map((t) => `${t.id} ${t.status}`).join(", ")}`);
  const firstList = events.findIndex((e) => e.kind === "tasks");
  const firstEdit = events.findIndex((e) => e.kind === "edit");
  if (firstEdit !== -1 && firstList > firstEdit) problems.push("the first tasks list came after the first edit");
  const live = liveness(lists, events);
  if (live.skipped) problems.push(`${live.skipped} tasks went to completed without being in_progress first`);
  if (live.batched) problems.push(`${live.batched} updates completed several tasks at once`);
  if (live.crowded) problems.push(`${live.crowded} lists had more than one task in_progress`);
  return problems;
};

// The autopilot picks its own step count (plan-run.ts asks for 2 to 4), so a minimum only applies to model-kept lists.
const steps = (n) => (autopilot ? 1 : n);

const CASES = [
  {
    name: "multi-step",
    prompt:
      "In this repo: 1) add a function sub(a, b) to math.js and export it, 2) add a test for sub to math.test.js in the style of the existing one, 3) mention sub in README.md. Run node --test afterwards.",
    expect: planned(steps(3)),
  },
  {
    name: "feature",
    fixture: featureFixture,
    prompt:
      "Add priorities to the todo list: items get a priority (low, normal or high; default normal). `node cli.js add <title> --priority <p>` sets it and rejects an unknown value with an error and exit code 1. `node cli.js list` shows high before normal before low and keeps insertion order within one level. Cover parsing, the rejection and the sorting with tests in store.test.js and a new cli.test.js, and document it in README.md. Run node --test at the end.",
    expect: planned(steps(4)),
  },
  {
    name: "bugs",
    fixture: bugsFixture,
    prompt:
      "node --test is red in this repo. Find and fix each bug; they are independent, and the tests are right, so leave them as they are. Then add `--format json` to `node cli.js report <file.csv>` (an array of {sku, total} with total as the formatted string), with a test in cli.test.js, and document it in README.md. Run node --test at the end.",
    expect: planned(steps(4)),
  },
  {
    name: "real",
    fixture: realFixture,
    prompt:
      "This is the task-list module behind an agent's TaskCreate/TaskUpdate/TaskList/TaskGet tools (state.ts holds the list, tasks.ts the tools, reminder.ts the reminder). Two changes, as in Claude Code: (1) tasks get an optional owner: TaskCreate and TaskUpdate accept it, TaskList shows it as `(owner)` after the subject, TaskGet shows it, and it survives replaying the session entries, including the v1 lists that state.ts migrates. (2) TaskUpdate to completed while a task in its blockedBy is still open succeeds but adds a warning line naming the open blockers. Cover both with tests next to the existing ones, write a short README.md for the module that documents the four tools and their fields, and run npm test at the end.",
    expect: planned(steps(4)),
  },
  ...(randomTask
    ? [
        {
          name: "random",
          task: randomTask,
          judge: (repo) => random.judge(repo, randomTask),
          prompt: randomTask.prompt,
          fixture(dir) {
            for (const [path, content] of Object.entries(randomTask.files)) {
              mkdirSync(dirname(join(dir, path)), { recursive: true });
              writeFileSync(join(dir, path), content);
            }
            commit(dir);
          },
          expect: planned(steps(3)),
        },
      ]
    : []),
  ...(resume ? [{ name: "resume", prompt: resume.prompt, fixture: resume.fixture, judge: resume.judge, timeoutMs: 40 * 60 * 1000, expect: planned(steps(4)) }] : []),
  {
    name: "one-step",
    prompt: "What does math.js export? Answer in one sentence, change nothing.",
    expect: (lists) => (lists.length ? [`a tasks list was set for a one-step question (${lists.at(-1).tasks.length} tasks)`] : []),
  },
];

function commit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "fixture"], { cwd: dir });
}

function bugsFixture(dir) {
  const files = {
    "money.js": 'export function formatCents(cents) {\n  const sign = cents < 0 ? "-" : "";\n  const abs = Math.abs(cents);\n  return `${sign}${Math.floor(abs / 100)}.${abs % 100}`;\n}\n',
    "parse.js": 'export function parseCsv(text) {\n  const [head, ...rows] = text.trim().split("\\n");\n  const keys = head.split(",");\n  return rows.map((row) => Object.fromEntries(row.split(",").map((value, i) => [keys[i], value])));\n}\n',
    "report.js": 'import { formatCents } from "./money.js";\n\nexport function totals(items) {\n  const by = new Map();\n  for (const item of items) by.set(item.name, (by.get(item.name) ?? 0) + Number(item.qty) * Number(item.cents));\n  return [...by].map(([sku, cents]) => ({ sku, cents }));\n}\n\nexport function report(items) {\n  return totals(items).map((t) => `${t.sku}: ${formatCents(t.cents)}`).join("\\n");\n}\n',
    "cli.js": 'import { readFileSync } from "node:fs";\nimport { parseCsv } from "./parse.js";\nimport { report } from "./report.js";\n\nconst [command, file] = process.argv.slice(2);\nif (command !== "report" || !file) {\n  console.error("usage: cli.js report <file.csv>");\n  process.exit(0);\n}\nconsole.log(report(parseCsv(readFileSync(file, "utf8"))));\n',
    "money.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { formatCents } from "./money.js";\n\ntest("cents keep two digits", () => assert.equal(formatCents(105), "1.05"));\ntest("negative amounts", () => assert.equal(formatCents(-250), "-2.50"));\n',
    "parse.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { parseCsv } from "./parse.js";\n\ntest("plain rows", () => assert.deepEqual(parseCsv("sku,name\\na1,nut"), [{ sku: "a1", name: "nut" }]));\ntest("a quoted field keeps its comma", () => assert.deepEqual(parseCsv(\'sku,name\\na1,"nut, small"\'), [{ sku: "a1", name: "nut, small" }]));\n',
    "report.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { totals } from "./report.js";\n\ntest("totals group by sku", () => {\n  const items = [{ sku: "a1", name: "nut", qty: "2", cents: "10" }, { sku: "a1", name: "nut (old label)", qty: "1", cents: "10" }];\n  assert.deepEqual(totals(items), [{ sku: "a1", cents: 30 }]);\n});\n',
    "cli.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { spawnSync } from "node:child_process";\n\ntest("usage errors exit 1", () => assert.equal(spawnSync("node", ["cli.js"]).status, 1));\n',
    "README.md": "# stock\n\n`node cli.js report <file.csv>`: total value per sku of a CSV with sku,name,qty,cents.\n",
    "package.json": '{ "name": "stock", "type": "module", "private": true }\n',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  commit(dir);
}

/** A real task on a copy of pi/work/tasks, the module behind the task tools, at the commit this eval runs from. */
// The real case works on the module as it was at REAL_BASE, so a change to pi/work/tasks does not change the task
// (and the hidden checks written for it keep fitting).
const REAL_BASE = "83bb4e03";
function realFixture(dir) {
  // From the repository root: in a subdirectory, ls-tree lists only what lies below it.
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  const at = (path) => execFileSync("git", ["show", `${REAL_BASE}:pi/work/tasks/${path}`], { cwd, encoding: "utf8" });
  const names = execFileSync("git", ["ls-tree", "--name-only", `${REAL_BASE}:pi/work/tasks`], { cwd, encoding: "utf8" }).split("\n");
  if (!names.includes("tasks.ts")) throw new Error(`real fixture: no tasks.ts at ${REAL_BASE}`);
  for (const name of names.filter((f) => f.endsWith(".ts"))) writeFileSync(join(dir, name), at(name));
  writeFileSync(join(dir, "package.json"), '{ "name": "tasks", "type": "module", "private": true, "scripts": { "test": "node --test --experimental-strip-types" } }\n');
  commit(dir);
}

function featureFixture(dir) {
  writeFileSync(join(dir, "store.js"), 'import { existsSync, readFileSync, writeFileSync } from "node:fs";\n\nexport function load(file) {\n  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];\n}\n\nexport function save(file, items) {\n  writeFileSync(file, JSON.stringify(items, null, 2));\n}\n\nexport function add(items, title) {\n  return [...items, { title, done: false }];\n}\n\nexport function list(items) {\n  return items.map((item) => `${item.done ? "[x]" : "[ ]"} ${item.title}`);\n}\n');
  writeFileSync(join(dir, "cli.js"), 'import { add, list, load, save } from "./store.js";\n\nconst file = process.env.TODO_FILE ?? "todo.json";\nconst [command, ...rest] = process.argv.slice(2);\nif (command === "add") save(file, add(load(file), rest.join(" ")));\nelse if (command === "list") console.log(list(load(file)).join("\\n"));\nelse {\n  console.error("usage: cli.js add <title> | list");\n  process.exit(1);\n}\n');
  writeFileSync(join(dir, "store.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, list } from "./store.js";\n\ntest("add and list", () => assert.deepEqual(list(add([], "milk")), ["[ ] milk"]));\n');
  writeFileSync(join(dir, "README.md"), "# todo\n\n- `node cli.js add <title>`: add an item\n- `node cli.js list`: show the items\n");
  writeFileSync(join(dir, "package.json"), '{ "name": "todo", "type": "module", "private": true }\n');
  commit(dir);
}

function fixture(dir) {
  writeFileSync(join(dir, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(join(dir, "math.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  writeFileSync(join(dir, "README.md"), "# math\n\nadd(a, b): the sum.\n");
  writeFileSync(join(dir, "package.json"), '{ "name": "math", "type": "module", "private": true }\n');
  commit(dir);
}

const EDIT_TOOLS = new Set(["edit", "write"]);
const LIST_TOOLS = new Set(["tasks", "TaskCreate", "TaskUpdate", "todo"]);
// A shell command that writes a file: sed -i, perl -i, tee, a redirect into a file, git apply, a python/node write.
const SHELL_EDIT = /\b(sed|perl) -i|\btee\b|(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)[\w.\/~$"'-]|\bgit apply\b|\bapply_patch\b|writeFileSync|\.write_text\(|open\([^)]*['"]w/;

/**
 * What one tool call did, in order: "edit" for a file change, "tasks" for a list change. A codemode script can do
 * both, so its calls count in the order they appear in the script, not as one event, including through an alias
 * (const w = tools.write) and through tools.bash with a command that writes.
 */
function kinds(call) {
  if (EDIT_TOOLS.has(call.name)) return ["edit"];
  if (LIST_TOOLS.has(call.name)) return ["tasks"];
  if (call.name === "bash") return SHELL_EDIT.test(String(call.arguments?.command ?? "")) ? ["edit"] : [];
  if (!/codemode$/.test(call.name)) return [];
  const code = String(call.arguments?.code ?? "");
  const kind = (tool) => (EDIT_TOOLS.has(tool) ? "edit" : LIST_TOOLS.has(tool) ? "tasks" : null);
  const aliases = new Map([...code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*tools\.(\w+)\b(?!\s*\()/g)].map((m) => [m[1], m[2]]));
  const names = ["tools\\.(\\w+)\\s*\\(", ...[...aliases.keys()].map((alias) => `\\b(${alias})\\s*\\(`)].join("|");
  const out = [];
  for (const m of code.matchAll(new RegExp(names, "g"))) {
    const name = m.slice(1).find(Boolean);
    const tool = aliases.get(name) ?? name;
    if (tool === "bash") {
      const rest = code.slice(m.index, m.index + 2000);
      if (SHELL_EDIT.test(/command\s*:\s*(`[^`]*`|"[^"]*"|'[^']*')/.exec(rest)?.[1] ?? "")) out.push("edit");
    } else if (kind(tool)) out.push(kind(tool));
  }
  return out;
}

/** The session file in a session dir. */
function sessionFile(sessionDir) {
  const files = readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
  if (files.length !== 1) throw new Error(`expected one session file in ${sessionDir}, found ${files.length}`);
  return join(sessionDir, String(files[0]));
}

/** The session's tasks lists, the order of lists and edits, and the timed entries the banner replay needs. */
function read(file) {
  const lists = [];
  const events = [];
  const timed = [];
  const usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry.timestamp ?? "");
    if (entry.type === "custom" && ["work-tasks", "rpiv-todo-state"].includes(entry.customType)) {
      lists.push(entry.data);
      timed.push({ at, list: entry.data.tasks ?? [] });
    }
    const message = entry.type === "message" ? entry.message : null;
    if (message?.role === "user") timed.push({ at, user: true });
    if (message?.role === "toolResult") timed.push({ at, result: message.toolCallId });
    if (message?.role === "assistant") {
      const u = message.usage ?? {};
      usage.calls++;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) usage[key] += u[key] ?? 0;
      usage.cost += u.cost?.total ?? 0;
      const calls = (message.content ?? []).filter((part) => part.type === "toolCall");
      for (const part of calls) for (const kind of kinds(part)) events.push({ kind });
      timed.push({ at, calls: calls.map((part) => ({ id: part.id, edit: kinds(part).includes("edit") })), final: calls.length === 0 });
    }
  }
  return { lists, events, timed, usage };
}

const TICK_MS = 4000; // sandy/work/goals/app.tsx polls the snapshot every 4 s

/**
 * What the composer banner showed while the agent worked, replayed at the banner's 4 s poll from the session's
 * timestamps (sandy/work/goals/app.tsx GoalBanner without a goal): a task in_progress shows "Now: <activeForm>",
 * else the open tool call shows "Now: <what it does>", else a pending task shows "Next:", else nothing.
 * Working means from a user message to the assistant's answer without tool calls.
 */
export function replay(timed) {
  const ticks = { task: 0, tool: 0, next: 0, none: 0, editing: 0, editingWithTask: 0 };
  let list = [];
  const open = new Map();
  let since = null;
  const sample = (until) => {
    for (; since !== null && since < until; since += TICK_MS) {
      const live = list.filter((t) => (t.status ?? "") !== "deleted");
      const inProgress = live.some((t) => ["in_progress", "doing"].includes(t.status));
      const pending = live.some((t) => ["pending", "todo", "blocked"].includes(t.status));
      const editing = [...open.values()].some((call) => call.edit);
      ticks[inProgress ? "task" : open.size ? "tool" : pending ? "next" : "none"]++;
      if (editing) {
        ticks.editing++;
        if (inProgress) ticks.editingWithTask++;
      }
    }
  };
  for (const e of [...timed].sort((x, y) => x.at - y.at)) {
    if (Number.isNaN(e.at)) continue;
    sample(e.at);
    if (e.user) since ??= e.at;
    if (e.list) list = e.list;
    if (e.result) open.delete(e.result);
    if (e.calls) for (const call of e.calls) open.set(call.id, call);
    if (e.final) {
      since = null;
      open.clear();
    }
  }
  const total = ticks.task + ticks.tool + ticks.next + ticks.none;
  const pct = (n, of = total) => (of ? Math.round((100 * n) / of) : 0);
  return { ticks: total, nowTask: pct(ticks.task), nowTool: pct(ticks.tool), next: pct(ticks.next), nothing: pct(ticks.none), editsWithTask: pct(ticks.editingWithTask, ticks.editing) };
}

const banner = (r) => `banner over ${r.ticks} ticks: Now task ${r.nowTask}%, Now tool ${r.nowTool}%, Next ${r.next}%, nothing ${r.nothing}%; edits with a task in_progress ${r.editsWithTask}%`;

// --session <file>: score one recorded session (an eval run or a real one) instead of running cases.
if (args.includes("--session")) {
  for (const file of args.filter((_, i) => args[i - 1] === "--session")) {
    const { lists, events, timed } = read(file);
    const live = liveness(lists, events);
    const firstList = events.findIndex((e) => e.kind === "tasks");
    const firstEdit = events.findIndex((e) => e.kind === "edit");
    console.log(`${file}\n  ${events.filter((e) => e.kind === "edit").length} edits, ${live.updates} list updates (first ${firstList === -1 ? "never" : firstEdit !== -1 && firstList > firstEdit ? "after the first edit" : "before the first edit"}), skipped in_progress ${live.skipped}, batched ${live.batched}\n  ${banner(replay(timed))}`);
  }
  process.exit(0);
}

let failed = 0;
for (const c of CASES.filter((c) => (only ? c.name === only : !random || c.name === "random"))) {
  const dir = mkdtempSync(join(tmpdir(), `work-eval-${c.name}-`));
  const repo = join(dir, "repo");
  const sessions = join(dir, "sessions");
  mkdirSync(repo);
  mkdirSync(sessions);
  (c.fixture ?? fixture)(repo);
  const started = Date.now();
  const run = spawnSync("pi", ["-p", "--session-dir", sessions, "--model", model, ...setup, autopilot ? `/autopilot plan-run ${c.prompt}` : c.prompt], {
    cwd: repo,
    encoding: "utf8",
    timeout: c.timeoutMs ?? TIMEOUT_MS,
    // Not this caller's SANDY thread or pi session: a fresh session that only sees the installed setup.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PI|SANDY)_/.test(key))),
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  let problems;
  let score = null;
  let stats = null;
  if (run.status !== 0) problems = [`pi exited ${run.status ?? run.signal}: ${(run.stderr || run.stdout).trim().slice(-400)}`];
  else {
    const { lists, events, timed, usage } = read(sessionFile(sessions));
    problems = c.expect(lists, events);
    stats = { ...usage, banner: replay(timed) };
    if (c.judge) {
      const results = await c.judge(repo);
      const reqs = results.filter((r) => r.id !== "P2P");
      score = { passed: reqs.filter((r) => r.status === "passed").length, of: reqs.length, p2p: results.find((r) => r.id === "P2P")?.status, failed: results.filter((r) => r.status !== "passed") };
      console.log(`  SCORE ${score.passed}/${score.of}, start-repo tests ${score.p2p}; ${usage.calls} calls, cacheRead ${usage.cacheRead}, output ${usage.output}, $${usage.cost.toFixed(4)}${score.failed.map((r) => `\n    ${r.id} ${r.status}: ${String(r.message ?? "").slice(0, 160)}`).join("")}`);
      stats.results = results;
      if (score.passed < score.of) problems.push(`${score.of - score.passed} requirements failed the hidden checks`);
      if (score.p2p !== "passed") problems.push("the start repo's own tests fail");
    }
    const last = lists.at(-1)?.tasks ?? [];
    const live = liveness(lists, events);
    console.log(`  ${c.name}: ${live.updates} list updates, skipped in_progress ${live.skipped}, batched ${live.batched}, crowded ${live.crowded}, most edits without an update ${live.quiet}; final: ${last.map((t) => `${t.id}=${t.status}`).join(" ") || "none"}\n  ${banner(replay(timed))}`);
  }
  console.log(`${problems.length ? "FAIL" : "PASS"} ${c.name} [${model}] (${seconds}s)${problems.map((p) => `\n  - ${p}`).join("")}`);
  if (problems.length) failed++;
  if (jsonOut) appendFileSync(jsonOut, JSON.stringify({ case: c.name, seed: c.task ? seed : undefined, family: c.task?.family, model, autopilot, seconds, problems, score, stats, dir }) + "\n");
  if (keep || problems.length) console.log(`  kept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
