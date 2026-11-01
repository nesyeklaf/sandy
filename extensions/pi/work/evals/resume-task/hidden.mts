// Hidden behavior checks for the resume benchmark (resume-task.mjs). The agent never sees them.
//   node --experimental-strip-types hidden.mts <repo>  -> JSON [{id, status, message}] on stdout
// Each pi "instance" imports a fresh copy of the repo, as a reload does, and shares only the session entries (and the
// cwd) with the instance before it. A hung step or check stands for the moment pi stopped.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const HANG = Symbol("hang");
const TASK_TOOLS = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
const PLAN = { steps: [{ subject: "Write code", activeForm: "Writing code" }, { subject: "Write tests", activeForm: "Writing tests" }], check: "npm test" };
const done = { status: "done", note: "ok" };
const TASK = "do the thing XYZ-42";

type Entry = { type: string; id: string; timestamp: string; customType?: string; data?: any; message?: any };
const lists = (entries: Entry[]) => entries.filter((e) => e.type === "custom" && e.customType === "work-tasks").map((e) => e.data.tasks as any[]);
const last = (entries: Entry[]) => lists(entries).at(-1) ?? [];
const show = (list: any[]) => list.map((t) => t.id + ":" + t.status).join(" ");
const idsSubjects = (list: any[]) => list.map((t) => t.id + "=" + t.subject).join(" | ");
const isPlanning = (s: any) => Array.isArray(s.schema?.required) && s.schema.required.includes("steps");

async function load() {
  const copy = mkdtempSync(join(tmpdir(), "resume-hidden-"));
  cpSync(repo, copy, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)$/.test(src) });
  return (await import(pathToFileURL(join(copy, "src", "autopilot.ts")).href)).default;
}

let cwd = "";
let counter = 0;
async function instance(entries: Entry[], answers: unknown[], checks: unknown[]) {
  const ext = await load();
  const commands: Record<string, any> = {};
  const messages: string[] = [];
  const steps: any[] = [];
  const execs: string[] = [];
  const pi = {
    registerCommand: (name: string, options: any) => void (commands[name] = options),
    appendEntry: (customType: string, data: unknown) =>
      void entries.push({ type: "custom", id: "e" + ++counter, timestamp: new Date().toISOString(), customType, data: structuredClone(data) }),
    sendMessage: (message: { content: string }) => void messages.push(String(message.content)),
    on: () => {},
    registerTool: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  const session = {
    step: async (options: any) => {
      steps.push({ say: String(options.say), deny: options.deny, schema: options.schema, listBefore: show(last(entries)) });
      const answer = answers.shift();
      if (answer === HANG || answer === undefined) return new Promise(() => {});
      return { text: "", value: answer, tools: [], model: "m", thinking: "low" };
    },
    exec: async (_command: string, args: string[]) => {
      execs.push(String(args.at(-1)));
      const check = checks.shift();
      if (check === HANG || check === undefined) return new Promise(() => {});
      return { stdout: "out", stderr: "", killed: false, ...(check as object) };
    },
    ask: async () => undefined,
    choose: async () => "",
  };
  ext(pi, () => session);
  const ctx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => [...entries], getEntries: () => [...entries] } };
  if (!commands.autopilot) throw new Error("no autopilot command registered");
  const run = (input: string) => commands.autopilot.handler(input, ctx);
  return { run, steps, execs, messages };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for the run to reach the point of the reload");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const within = <T,>(p: Promise<T>, ms = 3000, what = "the command") =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what + " did not finish within " + ms + " ms")), ms))]);
const fresh = () => {
  cwd = mkdtempSync(join(tmpdir(), "resume-cwd-"));
  return [{ type: "message", id: "e0", timestamp: new Date().toISOString(), message: { role: "user", content: "/autopilot plan-run " + TASK } }] as Entry[];
};
function ok(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const results: { id: string; title: string; status: string; message?: string }[] = [];
async function check(id: string, title: string, fn: () => Promise<void>, gate?: string) {
  if (gate && results.find((r) => r.id === gate)?.status !== "passed") {
    results.push({ id, title, status: "failed", message: "counts only when resume works at all (" + gate + ")" });
    return;
  }
  try {
    await within(fn(), 8000, "the check");
    results.push({ id, title, status: "passed" });
  } catch (error) {
    results.push({ id, title, status: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}

// Scenario A: pi stops in step 2 of 2; a new instance resumes.
let A: any = null;
async function scenarioA() {
  if (A) return A;
  const entries = fresh();
  const first = await instance(entries, [PLAN, done, HANG], []);
  void first.run("plan-run " + TASK).catch(() => {});
  await until(() => first.steps.length === 3);
  const before = last(entries);
  const second = await instance(entries, [done], [{ code: 0 }]);
  await within(second.run("resume"), 3000, "/autopilot resume");
  A = { entries, before, second };
  return A;
}

await check("H01", "resume after a reload in step 2 continues there and ends passed", async () => {
  const { entries, second } = await scenarioA();
  ok(!second.steps.some(isPlanning), "the plan was made again");
  ok(!second.steps.some((s: any) => s.say.includes("Write code")), "the completed step 'Write code' ran again");
  ok(second.steps.filter((s: any) => s.say.includes("Write tests")).length === 1, "the interrupted step 'Write tests' did not run again exactly once (steps: " + second.steps.map((s: any) => JSON.stringify(s.say.slice(0, 80))).join(", ") + ")");
  ok(JSON.stringify(second.execs) === '["npm test"]', "the check did not run once: " + JSON.stringify(second.execs));
  ok(last(entries).length > 0 && last(entries).every((t: any) => t.status === "completed"), "the list does not end all completed: " + show(last(entries)));
});
await check("H02", "the resumed run keeps the same task list (ids and subjects)", async () => {
  const { entries, before } = await scenarioA();
  ok(before.length === 4, "the run did not have 4 tasks before the reload: " + show(before));
  ok(idsSubjects(last(entries)) === idsSubjects(before), "list changed: before " + idsSubjects(before) + "; after " + idsSubjects(last(entries)));
}, "H01");
await check("H03", "the interrupted step shows in_progress when its turn starts again", async () => {
  const { second } = await scenarioA();
  ok(second.steps[0]?.listBefore === "1:completed 2:completed 3:in_progress 4:pending", "list before the resumed step: " + second.steps[0]?.listBefore);
});
await check("H04", "a reload during planning plans again with the original task", async () => {
  const entries = fresh();
  const first = await instance(entries, [HANG], []);
  void first.run("plan-run " + TASK).catch(() => {});
  await until(() => first.steps.length === 1);
  const second = await instance(entries, [PLAN, done, done], [{ code: 0 }]);
  await within(second.run("resume"), 3000, "/autopilot resume");
  ok(second.steps.length > 0 && isPlanning(second.steps[0]), "the resumed run did not start with a planning step");
  ok(second.steps[0].say.includes(TASK), "the planning prompt lacks the original task");
  ok(JSON.stringify(second.execs) === '["npm test"]', "the check did not run once: " + JSON.stringify(second.execs));
  const list = last(entries);
  ok(list.length > 0 && list.every((t: any) => t.status === "completed"), "the list does not end all completed: " + show(list));
  ok(list.filter((t: any) => t.subject === "Plan the work").length === 1, "the list has not exactly one planning task: " + idsSubjects(list));
  ok(new Set(list.map((t: any) => t.id)).size === list.length, "duplicate ids: " + idsSubjects(list));
});
await check("H05", "a reload during the check runs only the check again", async () => {
  const entries = fresh();
  const first = await instance(entries, [PLAN, done, done], [HANG]);
  void first.run("plan-run " + TASK).catch(() => {});
  await until(() => first.execs.length === 1);
  const second = await instance(entries, [], [{ code: 0 }]);
  await within(second.run("resume"), 3000, "/autopilot resume");
  ok(second.steps.length === 0, "steps ran again: " + second.steps.length);
  ok(JSON.stringify(second.execs) === '["npm test"]', "the check did not run once: " + JSON.stringify(second.execs));
  ok(last(entries).every((t: any) => t.status === "completed"), "the list does not end all completed: " + show(last(entries)));
});
await check("H06", "with nothing to resume, resume starts nothing and says so", async () => {
  const entries = fresh();
  const h = await instance(entries, [PLAN, done, done], [{ code: 0 }]);
  await within(h.run("resume"), 3000, "/autopilot resume");
  ok(h.steps.length === 0 && h.execs.length === 0, "it started work");
  ok(h.messages.length > 0, "no message");
}, "H01");
await check("H07", "a run that passed is not resumed", async () => {
  const entries = fresh();
  const first = await instance(entries, [PLAN, done, done], [{ code: 0 }]);
  await within(first.run("plan-run " + TASK), 3000, "/autopilot plan-run");
  const second = await instance(entries, [PLAN, done, done], [{ code: 0 }]);
  await within(second.run("resume"), 3000, "/autopilot resume");
  ok(second.steps.length === 0 && second.execs.length === 0, "it ran again");
  ok(second.messages.length > 0, "no message");
}, "H01");
await check("H08", "after a resumed run finished, another resume does nothing", async () => {
  const { entries } = await scenarioA();
  const third = await instance(entries, [PLAN, done, done], [{ code: 0 }]);
  await within(third.run("resume"), 3000, "/autopilot resume");
  ok(third.steps.length === 0 && third.execs.length === 0, "it ran again");
}, "H01");
await check("H09", "a blocked run resumes from its blocked step", async () => {
  const entries = fresh();
  const first = await instance(entries, [PLAN, { status: "blocked", note: "no access" }], []);
  await within(first.run("plan-run " + TASK), 3000, "/autopilot plan-run");
  const second = await instance(entries, [done, done], [{ code: 0 }]);
  await within(second.run("resume"), 3000, "/autopilot resume");
  ok(!second.steps.some(isPlanning), "the plan was made again");
  ok(second.steps.length === 2 && second.steps[0].say.includes("Write code") && second.steps[1].say.includes("Write tests"), "steps: " + second.steps.map((s: any) => JSON.stringify(s.say.slice(0, 80))).join(", "));
  ok(JSON.stringify(second.execs) === '["npm test"]', "the check did not run once");
  ok(last(entries).every((t: any) => t.status === "completed"), "the list does not end all completed: " + show(last(entries)));
});
await check("H10", "resume while a run is still going in this pi refuses", async () => {
  const entries = fresh();
  const h = await instance(entries, [PLAN, HANG, done, done], [{ code: 0 }]);
  void h.run("plan-run " + TASK).catch(() => {});
  await until(() => h.steps.length === 2);
  await within(h.run("resume"), 3000, "/autopilot resume");
  ok(h.steps.length === 2 && h.execs.length === 0, "a second run started: " + h.steps.length + " steps");
  ok(h.messages.length > 0, "no message");
}, "H01");
await check("H11", "resumed steps still block the task tools", async () => {
  const { second } = await scenarioA();
  ok(second.steps.length > 0, "no resumed step");
  for (const s of second.steps) ok(TASK_TOOLS.every((t) => s.deny?.includes(t)), "a resumed step does not deny " + TASK_TOOLS.join(","));
}, "H01");
await check("H12", "a run whose check stayed red is not resumed", async () => {
  const entries = fresh();
  const first = await instance(entries, [PLAN, done, done, done, done], [{ code: 1 }, { code: 1 }, { code: 1 }]);
  await within(first.run("plan-run " + TASK), 3000, "/autopilot plan-run");
  const second = await instance(entries, [done, done, done], [{ code: 0 }]);
  await within(second.run("resume"), 3000, "/autopilot resume");
  ok(second.steps.length === 0 && second.execs.length === 0, "it ran again");
}, "H01");

process.stdout.write(JSON.stringify(results) + "\n");
process.exit(0);
