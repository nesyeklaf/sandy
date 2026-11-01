// The plugin entry (server/index.ts) wired to a fake SANDY API: one pass of its watchdog background service
// delivers a queued input (the sweep runs the queue drain), as the real plugin does at runtime.
import test from "node:test";
import assert from "node:assert/strict";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { openDb } from "./db-fixture.ts";
import plugin from "../server/index.ts";
import { admit, bindChild, getDelegation, getPendingInput, readmit, transition } from "../server/ledger.ts";
import { issuePolicy, recordAck, storeBrief, type PolicyAnswer } from "../server/protocol.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";

type SandyEvent = { seq: number; type: "turn/started" | "turn/completed"; createdAt: number; data: Record<string, unknown> };

test("the plugin's watchdog service delivers a queued input once a slot is free: SANDY send is called and the ledger has it delivered, the child active", async () => {
  const db = openDb();
  const now = Date.now();
  const start = now - 60_000;
  // A child that ran its first turn (acked) and went idle, with an input queued while its root was full.
  const admitted = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: "h1" }, DEFAULT_SETTINGS, start);
  assert.ok(admitted.ok);
  const delegationId = admitted.delegation.delegationId;
  storeBrief(db, delegationId, "task", "[delegate-test]", start);
  assert.ok(bindChild(db, delegationId, "thr_child", start + 1_000).ok);
  const answer = issuePolicy(db, "thr_child", {}, start + 2_000) as Extract<PolicyAnswer, { status: "ok" }>;
  assert.ok(recordAck(db, { threadId: "thr_child", delegationId, policyHash: answer.policyHash, nonce: answer.nonce, piSessionId: "pi-1", turn: 1 }, 120_000, start + 3_000).ok);
  assert.ok(transition(db, delegationId, "idle", start + 11_000).ok);
  const queued = readmit(db, { delegationId, input: { kind: "queue", payload: { message: "next step", mode: "queue" } } }, { maxConcurrentChildren: 0 }, start + 12_000);
  assert.ok(queued.ok && queued.status === "queued");
  const inputId = queued.pendingInput.inputId;

  const events: SandyEvent[] = [
    { seq: 1, type: "turn/started", createdAt: start + 2_500, data: {} },
    { seq: 2, type: "turn/completed", createdAt: start + 10_000, data: { status: "completed" } },
  ];
  const sends: { threadId: string; text: string }[] = [];
  const services = new Map<string, { start(signal: AbortSignal): Promise<void> }>();
  const controller = new AbortController();
  const logs: string[] = [];
  const log = (level: string) => (message: string) => {
    logs.push(level + " " + message);
    if (message === "watchdog: startup reconciliation done") setTimeout(() => controller.abort(), 0);
  };
  const sandy = {
    pluginId: "delegate",
    settings: { define: () => ({ get: async () => ({ ...DEFAULT_SETTINGS }) }) },
    storage: { database: () => db, migrate: () => {}, kv: { get: async () => undefined, set: async () => {}, delete: async () => {} } },
    sdk: {
      hosts: { list: async () => [] },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId !== "thr_child") throw Object.assign(new Error("not found"), { status: 404 });
          return { id: threadId, status: sends.length > 0 ? "running" : "idle", archivedAt: null, parentThreadId: "thr_parent", originPluginId: "delegate", createdAt: start + 500 };
        },
        send: async (args: { threadId: string; input: { text: string }[] }) => {
          sends.push({ threadId: args.threadId, text: args.input[0]!.text });
          return { delivery: "sent" };
        },
        stop: async () => {},
        update: async () => {},
        events: {
          list: async (args: { threadId: string; types?: string[]; order: "asc" | "desc"; limit: string; afterSeq?: string }) => {
            const matching = (args.threadId === "thr_child" ? events : [])
              .filter((event) => args.types === undefined || args.types.includes(event.type))
              .filter((event) => args.afterSeq === undefined || event.seq > Number(args.afterSeq));
            const ordered = args.order === "desc" ? [...matching].reverse() : matching;
            return ordered.slice(0, Number(args.limit));
          },
        },
        experimental_listDescendants: async () => ({ threads: [] }),
        experimental_listPluginMetadata: async () => ({ threads: [] }),
      },
    },
    hosts: { experimental_client: () => ({ call: async () => ({}), experimental_onWorkerExit: () => {} }) },
    background: { service: (name: string, service: { start(signal: AbortSignal): Promise<void> }) => { services.set(name, service); } },
    agents: { registerTool: () => {}, configure: () => {} },
    cli: { register: () => {} },
    rpc: { register: () => {} },
    ui: { requestInput: async () => ({ outcome: "cancelled", reason: "plugin-disposed" }) },
    log: { info: log("info"), warn: log("warn"), error: log("error") },
  } as unknown as SandyPluginApi;

  await plugin(sandy);
  const watchdog = services.get("watchdog");
  assert.ok(watchdog !== undefined, "the plugin registers its watchdog service");
  await watchdog.start(controller.signal);

  assert.ok(logs.includes("info watchdog: startup reconciliation done"), logs.join("\n"));
  assert.deepEqual(sends, [{ threadId: "thr_child", text: "next step" }], logs.join("\n"));
  assert.equal(getPendingInput(db, inputId)?.state, "delivered");
  assert.equal(getDelegation(db, delegationId)?.state, "active");
});
