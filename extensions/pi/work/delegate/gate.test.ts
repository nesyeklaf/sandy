import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPolicySource, filePolicySource, hasDelegateMarker, installDelegateGate, installPiSubagentsBlock, piSubagentsGate, toolCallGate } from "./gate.ts";
import { policyHash } from "../../../sandy/work/delegate/shared/policy.ts";

const dir = mkdtempSync(join(tmpdir(), "sandy-delegate-ext-"));
const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

test("hasDelegateMarker: only the sandy_delegate_brief tool marks a delegate", () => {
  assert.equal(hasDelegateMarker(undefined), false);
  assert.equal(hasDelegateMarker(""), false);
  assert.equal(hasDelegateMarker(file("plain.json", JSON.stringify([{ name: "sandy_other", description: "", inputSchema: {} }]))), false);
  assert.equal(hasDelegateMarker(file("marked.json", JSON.stringify([{ name: "sandy_other" }, { name: "sandy_delegate_brief" }]))), true);
});

test("hasDelegateMarker: an unreadable or malformed tool list fails closed", () => {
  assert.equal(hasDelegateMarker(join(dir, "missing.json")), true);
  assert.equal(hasDelegateMarker(file("broken.json", "{not json")), true);
  assert.equal(hasDelegateMarker(file("object.json", "{}")), true);
  for (const [name, entries] of [["null-entry", [null]], ["empty-object", [{}]], ["number-name", [{ name: 42 }]], ["empty-name", [{ name: "" }]], ["mixed", [{ name: "sandy_other" }, "sandy_delegate_brief"]]] as const) {
    assert.equal(hasDelegateMarker(file(name + ".json", JSON.stringify(entries))), true, name);
  }
});

test("toolCallGate: blocks per decide and blocks when deciding throws", () => {
  const policy = { delegationId: "d", snapshotHash: "s", allowTools: ["read"], transportTools: [] };
  assert.equal(toolCallGate(() => null)({ toolName: "edit" }), undefined);
  assert.equal(toolCallGate(() => policy)({ toolName: "read" }), undefined);
  assert.equal(toolCallGate(() => policy)({ toolName: "edit" })?.block, true);
  assert.equal(toolCallGate(() => "pending")({ toolName: "read" })?.block, true);
  const failed = toolCallGate(() => { throw new Error("boom"); })({ toolName: "read" });
  assert.equal(failed?.block, true);
  assert.match(failed!.reason, /gate failed.*boom/);
});

test("filePolicySource: loads and validates the policy file", async () => {
  const policy = { delegationId: "d", snapshotHash: "s", allowTools: ["read"], transportTools: ["codemode"] };
  assert.deepEqual(await filePolicySource(file("policy.json", JSON.stringify(policy))).load(), policy);
  await assert.rejects(filePolicySource(file("bad-policy.json", JSON.stringify({ ...policy, transportTools: ["bash"] }))).load(), /non-transport/);
});


const cliPolicy = { delegationId: "dlg_1", snapshotHash: "snap", allowTools: ["read", "sandy_delegate_brief"], transportTools: ["codemode"] };

// A fake `sandy` that answers `delegate policy` from a script of answers and records every call.
const fakeSandy = (answers: unknown[]) => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[2] === "ack") return JSON.stringify({ ok: true });
    return JSON.stringify(answers.length > 1 ? answers.shift() : answers[0]);
  };
  return { run, calls };
};

test("cliPolicySource: retries pending, then loads the policy and acks it with the issued hash and nonce", async () => {
  const sandy = fakeSandy([{ status: "pending" }, { status: "pending" }, { status: "ok", policy: cliPolicy, policyHash: policyHash(cliPolicy), nonce: "nonce_a" }]);
  const source = cliPolicySource("thr_child", { run: sandy.run, retryMs: 1 });
  const policy = await source.load();
  assert.deepEqual(policy, cliPolicy);
  assert.equal(sandy.calls.length, 3);
  assert.deepEqual(sandy.calls[0], ["work", "delegate", "policy", "--thread", "thr_child"]);
  await source.acknowledge!({ ...policy }, "pi-session-1", 1);
  assert.deepEqual(sandy.calls[3], ["work", "delegate", "ack", "--thread", "thr_child", "--delegation", "dlg_1", "--hash", policyHash(cliPolicy), "--nonce", "nonce_a", "--session", "pi-session-1", "--turn", "1"]);
  await source.acknowledge!(policy, "pi-session-1", 1);
  assert.equal(sandy.calls.length, 4, "a nonce is acked once");
});

test("cliPolicySource: denied yields the deny-all policy without an ack; pending past the timeout and a hash mismatch throw", async () => {
  const deny = { delegationId: "none", snapshotHash: "deny-all", allowTools: [], transportTools: [] };
  const denied = fakeSandy([{ status: "denied", reason: "thread is not a delegation", policy: deny, nonce: null }]);
  const source = cliPolicySource("thr_x", { run: denied.run });
  assert.deepEqual(await source.load(), deny);
  await source.acknowledge!(deny, "pi", 1);
  assert.equal(denied.calls.length, 1);
  // A denial that carries a permissive policy still yields deny-all.
  const greedy = fakeSandy([{ status: "denied", reason: "x", policy: { delegationId: "dlg_1", snapshotHash: "s", allowTools: ["bash"], transportTools: ["codemode"] }, nonce: null }]);
  const greedyPolicy = await cliPolicySource("thr_x", { run: greedy.run }).load();
  assert.deepEqual(greedyPolicy, deny);
  assert.ok(toolCallGate(() => greedyPolicy)({ toolName: "bash" } as any)?.block);

  await assert.rejects(cliPolicySource("thr_x", { run: fakeSandy([{ status: "pending" }]).run, retryMs: 1, pendingTimeoutMs: 5 }).load(), /still pending/);
  await assert.rejects(cliPolicySource("thr_x", { run: fakeSandy([{ status: "ok", policy: cliPolicy, policyHash: "0".repeat(64), nonce: "n" }]).run }).load(), /malformed/);
});

// A fake `sandy` whose first `failPolicy` policy calls and `failAck` ack calls throw, as while the plugin reloads.
const reloadingSandy = (failPolicy: number, failAck: number) => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[2] === "ack") {
      if (failAck-- > 0) throw new Error("plugin delegate is not running");
      return JSON.stringify({ ok: true });
    }
    if (failPolicy-- > 0) throw new Error("plugin delegate is not running");
    return JSON.stringify({ status: "ok", policy: cliPolicy, policyHash: policyHash(cliPolicy), nonce: "nonce_r" });
  };
  return { run, calls };
};

// The pi session as SANDY starts it: session_start, then before_agent_start, then tool calls.
const startGate = async (source: ReturnType<typeof cliPolicySource>) => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  installDelegateGate({ on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; }, setActiveTools: () => {} }, { delegate: true, policySource: source });
  handlers.session_start({}, { sessionManager: { getSessionId: () => "pi-r" } });
  await handlers.before_agent_start({});
  return handlers;
};

test("cliPolicySource: a policy call that throws (plugin reloading) is retried like pending; the policy is then applied and acked", async () => {
  const sandy = reloadingSandy(2, 0);
  const handlers = await startGate(cliPolicySource("thr_child", { run: sandy.run, retryMs: 1 }));
  assert.deepEqual(sandy.calls.map((args) => args[2]), ["policy", "policy", "policy", "ack"]);
  assert.equal(sandy.calls[3][sandy.calls[3].indexOf("--nonce") + 1], "nonce_r");
  assert.equal(handlers.tool_call({ toolName: "read" }), undefined, "policy applied");
  assert.equal(handlers.tool_call({ toolName: "edit" })?.block, true);
});

test("cliPolicySource: policy calls that throw past the timeout leave the gate pending (deny-all)", async () => {
  const sandy = reloadingSandy(Infinity, 0);
  await assert.rejects(cliPolicySource("thr_x", { run: sandy.run, retryMs: 1, pendingTimeoutMs: 5 }).load(), /not running/);
  const handlers = await startGate(cliPolicySource("thr_x", { run: sandy.run, retryMs: 1, pendingTimeoutMs: 5 }));
  for (const toolName of ["read", "sandy_delegate_brief", "codemode"]) assert.match(handlers.tool_call({ toolName })?.reason, /not applied yet/, toolName);
  assert.equal(sandy.calls.some((args) => args[2] === "ack"), false, "nothing to ack");
});

test("cliPolicySource: an ack call that throws once is retried, so the brief unlocks", async () => {
  const sandy = reloadingSandy(0, 1);
  const handlers = await startGate(cliPolicySource("thr_child", { run: sandy.run, retryMs: 1 }));
  assert.deepEqual(sandy.calls.map((args) => args[2]), ["policy", "ack", "ack"]);
  assert.deepEqual(sandy.calls[1], sandy.calls[2], "the same nonce is acked again");
  assert.equal(handlers.tool_call({ toolName: "sandy_delegate_brief" }), undefined);
});

test("installDelegateGate: applies the loaded policy, then acks it with the pi session id", async () => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = { on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; }, setActiveTools: () => {} };
  const acks: [string, string, number][] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  installDelegateGate(pi, {
    delegate: true,
    policySource: { load: async () => { await gate; return cliPolicy; }, acknowledge: async (policy, session, turn) => { acks.push([policy.delegationId, session, turn]); } },
  });
  handlers.session_start({}, { sessionManager: { getSessionId: () => "pi-session-7" } });
  assert.equal(handlers.tool_call({ toolName: "read" })?.block, true, "pending until the policy is applied");
  release();
  await handlers.before_agent_start({});
  assert.equal(handlers.tool_call({ toolName: "read" }), undefined);
  assert.equal(handlers.tool_call({ toolName: "edit" })?.block, true);
  assert.deepEqual(acks, [["dlg_1", "pi-session-7", 1]]);
});

// A fake `sandy` that issues nonce_1, nonce_2, ... per policy call and records every call.
const noncingSandy = () => {
  const calls: string[][] = [];
  let issued = 0;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[2] === "ack") return JSON.stringify({ ok: true });
    issued += 1;
    return JSON.stringify({ status: "ok", policy: cliPolicy, policyHash: policyHash(cliPolicy), nonce: `nonce_${issued}` });
  };
  const acks = () => calls.filter((args) => args[2] === "ack").map((args) => [args[args.indexOf("--session") + 1], args[args.indexOf("--turn") + 1], args[args.indexOf("--nonce") + 1]]);
  return { run, calls, acks };
};

const gateHandlers = (source: ReturnType<typeof cliPolicySource>) => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  installDelegateGate({ on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; }, setActiveTools: () => {} }, { delegate: true, policySource: source });
  return handlers;
};

test("installDelegateGate: every turn of a retained session fetches a fresh policy and acks its nonce with the turn number", async () => {
  const sandy = noncingSandy();
  const handlers = gateHandlers(cliPolicySource("thr_child", { run: sandy.run, retryMs: 1 }));
  handlers.session_start({}, { sessionManager: { getSessionId: () => "pi-a" } });
  for (let turn = 0; turn < 4; turn++) await handlers.before_agent_start({});
  assert.deepEqual(sandy.acks(), [["pi-a", "1", "nonce_1"], ["pi-a", "2", "nonce_2"], ["pi-a", "3", "nonce_3"], ["pi-a", "4", "nonce_4"]]);
  assert.deepEqual(sandy.calls.map((args) => args[2]), ["policy", "ack", "policy", "ack", "policy", "ack", "policy", "ack"], "each ack follows its own policy call");
});

test("installDelegateGate: a released session's resume (new pi session) re-fetches the policy before acking, counting turns from 1", async () => {
  const sandy = noncingSandy();
  const first = gateHandlers(cliPolicySource("thr_child", { run: sandy.run, retryMs: 1 }));
  first.session_start({}, { sessionManager: { getSessionId: () => "pi-a" } });
  await first.before_agent_start({});
  // SANDY released the pi process; the next message starts a new one.
  const resumed = gateHandlers(cliPolicySource("thr_child", { run: sandy.run, retryMs: 1 }));
  resumed.session_start({}, { sessionManager: { getSessionId: () => "pi-b" } });
  assert.equal(resumed.tool_call({ toolName: "read" })?.block, true, "the new session is pending until its policy is applied");
  await resumed.before_agent_start({});
  await resumed.before_agent_start({});
  assert.deepEqual(sandy.acks(), [["pi-a", "1", "nonce_1"], ["pi-b", "1", "nonce_2"], ["pi-b", "2", "nonce_3"]]);
  assert.equal(resumed.tool_call({ toolName: "read" }), undefined);
  // A new session in the same pi process starts pending and counts from 1 again.
  resumed.session_start({}, { sessionManager: { getSessionId: () => "pi-c" } });
  assert.equal(resumed.tool_call({ toolName: "read" })?.block, true);
  await resumed.before_agent_start({});
  assert.deepEqual(sandy.acks().slice(3), [["pi-c", "1", "nonce_4"]]);
});

test("installDelegateGate: a retained turn whose policy load fails keeps the earlier policy and sends no ack", async () => {
  let fail = false;
  const sandy = noncingSandy();
  const run = async (args: string[]) => {
    if (fail && args[2] === "policy") throw new Error("plugin delegate is not running");
    return sandy.run(args);
  };
  const handlers = gateHandlers(cliPolicySource("thr_child", { run, retryMs: 1, pendingTimeoutMs: 5 }));
  handlers.session_start({}, { sessionManager: { getSessionId: () => "pi-a" } });
  await handlers.before_agent_start({});
  fail = true;
  await handlers.before_agent_start({});
  assert.deepEqual(sandy.acks(), [["pi-a", "1", "nonce_1"]], "no ack for turn 2: the plugin stops the child");
  assert.equal(handlers.tool_call({ toolName: "read" }), undefined);
  assert.equal(handlers.tool_call({ toolName: "edit" })?.block, true);
});

test("piSubagentsGate: blocks the pi-subagents tools and their MCP aliases, passes everything else", () => {
  const blocked = ["subagents_enable", "subagent", "subagent_supervisor", "mcp__pi_subagents__subagent", "mcp__x__subagents_enable", "mcp__x__subagent_supervisor"];
  for (const toolName of blocked) {
    const result = piSubagentsGate({ toolName });
    assert.equal(result?.block, true, toolName);
    assert.equal(result?.reason, "pi-subagents is not used in SANDY threads. Delegate with sandy_delegate (agents: sandy work delegate agents list); pi-subagents stays only in a pi TUI outside SANDY.");
  }
  for (const toolName of ["read", "bash", "sandy_delegate", "subagents", "my_subagent", "mcp__x__subagent_list", "mcp__subagent"]) assert.equal(piSubagentsGate({ toolName }), undefined, toolName);
});

test("installPiSubagentsBlock: registers the gate in a SANDY thread (tool list set), nothing outside SANDY", () => {
  const register = (toolsFile: string | undefined) => {
    const handlers: Record<string, (...args: any[]) => any> = {};
    installPiSubagentsBlock({ on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; } }, toolsFile);
    return handlers;
  };
  assert.deepEqual(Object.keys(register(undefined)), []);
  assert.deepEqual(Object.keys(register("")), []);
  const parent = register(file("parent-tools.json", JSON.stringify([{ name: "sandy_other" }])));
  assert.equal(parent.tool_call({ toolName: "subagent" })?.block, true);
  assert.equal(parent.tool_call({ toolName: "read" }), undefined);
  // a delegated child: the marker tool is listed, the block still applies
  const child = register(file("child-tools.json", JSON.stringify([{ name: "sandy_delegate_brief" }])));
  assert.equal(child.tool_call({ toolName: "subagents_enable" })?.block, true);
});


test("installDelegateGate: turn_start narrows the active tools to the policy after other extensions re-added theirs, and leaves an unchanged set alone", async () => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const registered = ["sandy_delegate_brief", "codemode", "create_goal", "edit", "get_goal", "read"];
  let active = [...registered];
  let sets = 0;
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers[name] = handler; },
    getAllTools: () => registered.map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { sets += 1; active = names.filter((name) => registered.includes(name)); },
  };
  const policy = { delegationId: "dlg_t", snapshotHash: "h", allowTools: ["sandy_delegate_brief", "read", "web_search"], transportTools: ["codemode"] };
  installDelegateGate(pi, { delegate: true, policySource: { load: async () => policy } });
  handlers.session_start({}, { sessionManager: { getSessionId: () => "pi-t" } });
  await handlers.before_agent_start({});
  assert.deepEqual([...active].sort(), ["sandy_delegate_brief", "codemode", "read"]);
  active.push("create_goal", "get_goal"); // pi-goal-x's before_agent_start runs after ours
  handlers.turn_start({});
  assert.deepEqual([...active].sort(), ["sandy_delegate_brief", "codemode", "read"], "turn_start drops the re-added tools; an unregistered allowed tool is skipped");
  const before = sets;
  handlers.turn_start({});
  assert.equal(sets, before, "no setActiveTools when the set is already the policy's");
});
