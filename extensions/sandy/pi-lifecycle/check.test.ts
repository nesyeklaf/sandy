import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installExtension, requestReload, withHooks } from "./agent.ts";
import extensionSource from "./extension-source.ts";
import { ago, bytes } from "./format.ts";
import { measure, parseStat } from "./procscan.ts";

const statLine = (pid: number, comm: string, ppid: number, utime: number, start: number, rssPages: number) => {
  const fields = Array(50).fill("0");
  fields[0] = "S"; fields[1] = String(ppid); fields[11] = String(utime); fields[12] = "0"; fields[19] = String(start); fields[21] = String(rssPages);
  return `${pid} (${comm}) ${fields.join(" ")}`;
};

function fakeProc() {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  const add = (pid: number, comm: string, ppid: number, rss: number, cmdline = "", env = "") => {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), "stat"), statLine(pid, comm, ppid, 0, 6000, rss));
    writeFileSync(join(root, String(pid), "cmdline"), cmdline);
    writeFileSync(join(root, String(pid), "environ"), env);
  };
  writeFileSync(join(root, "uptime"), "100.00 0.00");
  add(10, "node", 1, 100, "node\0/x/sandy-provider-bridge-worker.mjs\0");
  add(11, "pi", 10, 1000, "pi\0--mode\0rpc\0", "A=1\0BB_THREAD_ID=thr_abc\0");
  add(12, "bash", 11, 50);
  add(13, "pi", 1, 999, "pi\0", "SANDY_THREAD_ID=thr_loose\0"); // not started by the bridge
  add(14, "pi", 10, 7, "pi\0", "A=1\0"); // no thread id
  return root;
}

test("parseStat copes with parentheses and spaces in the command name", () => {
  const stat = parseStat(statLine(5, "we ) ird", 3, 40, 123, 77));
  assert.deepEqual(stat, { pid: 5, comm: "we ) ird", ppid: 3, ticks: 40, startTicks: 123, rssPages: 77 });
  assert.equal(parseStat("garbage"), null);
});

test("measure finds only bridge-started pi, sums its tree and derives the start time", async () => {
  const [one, ...rest] = await measure(fakeProc(), 10, 1_000_000);
  assert.equal(rest.length, 0);
  assert.equal(one.threadId, "thr_abc");
  assert.equal(one.pid, 11);
  assert.equal(one.children, 1);
  assert.equal(one.rssBytes, 1050 * 4096);
  assert.equal(one.startedAt, 1_000_000 - 100_000 + 60_000);
});

test("withHooks joins state files, drops state of dead pids, flags pending reloads", () => {
  const agent = mkdtempSync(join(tmpdir(), "agent-"));
  const dir = join(agent, "lifecycle");
  mkdirSync(dir);
  const state = (startedAt: number) => JSON.stringify({ startedAt, lastLoadAt: 5, reason: "reload", lastReloadAt: 5, reloadCount: 2 });
  writeFileSync(join(dir, "11.json"), state(1000));
  writeFileSync(join(dir, "99.json"), state(1000));
  writeFileSync(join(dir, "12.json"), state(1000)); // pid reused: different start time
  const base = { threadId: "t", startedAt: 1000, rssBytes: 1, cpuPercent: 0, children: 0 };
  assert.equal(requestReload(agent, [{ pid: 11, startedAt: 1000 }, { pid: 42, startedAt: 1000 }]), 1);
  const result = withHooks(agent, [{ ...base, pid: 11 }, { ...base, pid: 12, startedAt: 900000 }, { ...base, pid: 13 }]);
  assert.deepEqual(result[0].hook, { startedAt: 1000, lastLoadAt: 5, reason: "reload", lastReloadAt: 5, reloadCount: 2, reloadPending: true });
  assert.equal(result[1].hook, null);
  assert.equal(result[2].hook, null);
  assert.equal(existsSync(join(dir, "99.json")), false);
  assert.equal(existsSync(join(dir, "12.json")), true);
});

test("requestReload skips a pid that a new pi took after the scan", () => {
  const agent = mkdtempSync(join(tmpdir(), "agent-"));
  const dir = join(agent, "lifecycle");
  mkdirSync(dir);
  // the scan saw the pi that started at 1000; it died and a new pi on the same pid wrote its state
  writeFileSync(join(dir, "12.json"), JSON.stringify({ startedAt: 900000, lastLoadAt: 900000, reason: "startup", lastReloadAt: null, reloadCount: 0 }));
  assert.equal(requestReload(agent, [{ pid: 12, startedAt: 1000 }]), 0);
  assert.equal(requestReload(agent, [{ pid: 12, startedAt: 900000 - 1600 }]), 0); // started 1.6 s apart
  assert.equal(existsSync(join(dir, "12.reload-request")), false);
  assert.equal(requestReload(agent, [{ pid: 12, startedAt: 900000 }]), 1);
  assert.equal(existsSync(join(dir, "12.reload-request")), true);
});

test("installed extension equals pi-extension.ts", () => {
  const agent = mkdtempSync(join(tmpdir(), "agent-"));
  const file = installExtension(agent);
  assert.equal(readFileSync(file, "utf8"), readFileSync(new URL("./pi-extension.ts", import.meta.url), "utf8"));
  assert.equal(extensionSource, readFileSync(new URL("./pi-extension.ts", import.meta.url), "utf8"), "run: npm run gen");
});

test("extension records loads and reloads and answers a reload request once idle", async () => {
  const agent = mkdtempSync(join(tmpdir(), "agent-"));
  process.env.PI_CODING_AGENT_DIR = agent;
  const file = join(agent, "ext.ts");
  writeFileSync(file, extensionSource);
  const { default: extension } = await import(file);
  const handlers = new Map<string, (...args: any[]) => void>();
  const commands = new Map<string, any>();
  const sent: unknown[][] = [];
  extension({ on: (n: string, h: any) => handlers.set(n, h), registerCommand: (n: string, o: any) => commands.set(n, o), sendUserMessage: (...a: unknown[]) => sent.push(a) });
  let idle = false;
  const ctx = { isIdle: () => idle };
  const stateFile = join(agent, "lifecycle", `${process.pid}.json`);
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).reloadCount, 0);
  handlers.get("session_start")!({ reason: "reload" }, ctx);
  const after = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(after.reloadCount, 1);
  assert.equal(after.reason, "reload");
  assert.notEqual(after.lastReloadAt, null);
  writeFileSync(join(agent, "lifecycle", `${process.pid}.reload-request`), "");
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal(sent.length, 0, "must wait while pi is busy");
  idle = true;
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.deepEqual(sent, [["/lifecycle-reload", { expandPromptTemplates: true }]]);
  assert.equal(existsSync(join(agent, "lifecycle", `${process.pid}.reload-request`)), false);
  let reloaded = false;
  await commands.get("lifecycle-reload").handler("", { reload: async () => { reloaded = true; } });
  assert.equal(reloaded, true);
  handlers.get("session_shutdown")!({ reason: "reload" });
  assert.equal(existsSync(stateFile), true, "state survives a reload");
  handlers.get("session_shutdown")!({ reason: "quit" });
  assert.equal(existsSync(stateFile), false);
});

test("a new pi on a reused pid drops the reload request left by the dead one", async () => {
  const agent = mkdtempSync(join(tmpdir(), "agent-"));
  process.env.PI_CODING_AGENT_DIR = agent;
  const file = join(agent, "ext.ts");
  writeFileSync(file, extensionSource);
  const { default: extension } = await import(file);
  const handlers = new Map<string, (...args: any[]) => void>();
  const sent: unknown[][] = [];
  extension({ on: (n: string, h: any) => handlers.set(n, h), registerCommand: () => {}, sendUserMessage: (...a: unknown[]) => sent.push(a) });
  const request = join(agent, "lifecycle", `${process.pid}.reload-request`);
  mkdirSync(join(agent, "lifecycle"));
  writeFileSync(request, "");
  utimesSync(request, new Date(0), new Date(0)); // written before this process started
  handlers.get("session_start")!({ reason: "startup" }, { isIdle: () => true });
  assert.equal(existsSync(request), false);
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.deepEqual(sent, []);
  handlers.get("session_shutdown")!({ reason: "quit" });
});

test("formatting", () => {
  assert.equal(ago(null), "never");
  assert.equal(ago(0, 30_000), "just now");
  assert.equal(ago(0, 5 * 60_000), "5 min ago");
  assert.equal(ago(0, 3 * 3600_000), "3 h ago");
  assert.equal(bytes(200 * 1048576), "200 MB");
  assert.equal(bytes(2048 * 1048576), "2.0 GB");
});
