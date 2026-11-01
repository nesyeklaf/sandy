import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db-fixture.ts";
import { admit, getDelegation, getStopRequest } from "../server/ledger.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import { storeBrief } from "../server/protocol.ts";
import { delegate, DELEGATE_PROVIDER } from "../server/launch.ts";
import { createSandyHosts, type SandyHostApi } from "../server/sandy-host.ts";
import { SPAWN_SETTLE_MS, sweepWatchdog } from "../server/watchdog.ts";
import { admitWorker, sweepWorkers } from "../server/workers.ts";

type Db = ReturnType<typeof openDb>;

const WINDOW = 120_000;
const PLUGIN = "delegate";

type FakeThread = { id: string; parentThreadId: string | null; originPluginId: string | null; createdAt: number; status: string; archivedAt: number | null };

// The plugin API as the adapters see it: descendants per listed parent (a parent missing here is omitted,
// as SANDY omits unknown and deleted ids), this plugin's metadata, and threads by id (missing: HTTP 404).
function fakeSandy(world: {
  descendants: Record<string, string[]>;
  metadata?: Record<string, Record<string, unknown>>;
  threads?: Record<string, FakeThread>;
  spawn?: () => Promise<{ id: string }>;
}) {
  const stops: string[] = [];
  const notFound = () => Object.assign(new Error("HTTP 404: Thread not found"), { status: 404, code: "thread_not_found" });
  const sandy = {
    pluginId: PLUGIN,
    sdk: {
      providers: { list: async () => [{ id: DELEGATE_PROVIDER, available: true, capabilities: { permissionModes: ["full"] } }] },
      environments: { get: async () => ({ hostId: "host_test", isGitRepo: true, branchName: "feature" }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "thr_parent") return { id: threadId, projectId: "proj_test", environmentId: "env_parent", parentThreadId: null };
          const thread = world.threads?.[threadId];
          if (thread === undefined) throw notFound();
          return thread;
        },
        spawn: async () => (world.spawn ?? (async () => ({ id: "thr_spawned" })))(),
        stop: async ({ threadId }: { threadId: string }) => { stops.push(threadId); },
        defaultExecutionOptions: async () => ({ permissionMode: "full" }),
        experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, ancestorIds: [] })) }),
        experimental_listDescendants: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.filter((threadId) => threadId in world.descendants).map((threadId) => ({ threadId, descendantIds: world.descendants[threadId] })),
        }),
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.filter((threadId) => world.metadata?.[threadId] !== undefined).map((threadId) => ({ threadId, metadata: world.metadata![threadId] })),
        }),
      },
    },
    storage: { kv: { get: async () => null } },
  };
  return { sandy: sandy as unknown as SandyHostApi, stops };
}

// threads.events.list as SANDY serves it: the newest-first rows of the requested types, limited.
type FakeEvent = { seq: number; type: string; createdAt: number; data: unknown };

test("sandy-host status adapter: tokens and context come from the newest usage events, a missing event is null, 404 is null", async () => {
  const events: FakeEvent[] = [
    { seq: 5, type: "thread/tokenUsage/updated", createdAt: 500, data: { tokenUsage: { total: { totalTokens: 27_766 }, modelContextWindow: 1_000_000 } } },
    { seq: 6, type: "thread/contextWindowUsage/updated", createdAt: 600, data: { contextWindowUsage: { usedTokens: null, modelContextWindow: null } } },
    { seq: 7, type: "provider/error", createdAt: 700, data: { message: "Provider error", detail: "pi exited (code 1)" } },
  ];
  const { sandy } = fakeSandy({ descendants: {} });
  const threads = sandy.sdk.threads as unknown as Record<string, unknown>;
  threads.events = {
    list: async ({ threadId, types, order, limit }: { threadId: string; types?: string[]; order: string; limit: string }) => {
      if (threadId === "thr_gone") throw Object.assign(new Error("HTTP 404"), { status: 404 });
      assert.equal(order, "desc");
      assert.equal(limit, "1");
      return events.filter((event) => types === undefined || types.includes(event.type)).sort((a, b) => b.seq - a.seq).slice(0, 1);
    },
  };
  threads.defaultExecutionOptions = async () => ({ model: "anthropic/claude-haiku-5-5", reasoningLevel: "medium", permissionMode: "full" });
  const { statusHost } = createSandyHosts(sandy);
  assert.deepEqual(await statusHost.usage("thr_x"), { totalTokens: 27_766, contextTokens: null, contextWindow: 1_000_000 });
  assert.equal(await statusHost.lastEventAt("thr_x"), 700);
  assert.deepEqual(await statusHost.latestFailure("thr_x"), { at: 700, source: "provider/error", message: "pi exited (code 1)" });
  assert.deepEqual(await statusHost.executionOptions("thr_x"), { model: "anthropic/claude-haiku-5-5", reasoningLevel: "medium" });
  assert.deepEqual(await statusHost.usage("thr_gone"), { totalTokens: null, contextTokens: null, contextWindow: null });
  assert.equal(await statusHost.lastEventAt("thr_gone"), null);
  assert.equal(await statusHost.latestFailure("thr_gone"), null);
  events.length = 0;
  assert.equal(await statusHost.latestFailure("thr_x"), null);
  assert.equal(await statusHost.lastEventAt("thr_x"), null);
});

const reserve = (db: Db, now: number) => {
  const result = admit(db, { rootThreadId: "thr_parent", callerThreadId: "thr_parent", kind: "delegate", agent: "scout", inputHash: "h" }, DEFAULT_SETTINGS, now);
  assert.ok(result.ok);
  storeBrief(db, result.delegation.delegationId, "t", null, now);
  return result.delegation.delegationId;
};

test("sandy-host watchdog adapter: a parent SANDY omits from the descendant listing keeps the reservation; a listed parent without threads releases it", async () => {
  const db = openDb();
  const delegationId = reserve(db, 1_000);
  const omitted = createSandyHosts(fakeSandy({ descendants: {} }).sandy).watchdogHost;
  assert.equal(await omitted.spawnCandidates("thr_parent", delegationId), null);
  const kept = await sweepWatchdog(db, omitted, WINDOW, 1_000 + WINDOW);
  assert.deepEqual(kept.kept, [{ delegationId, reason: "SANDY does not list its parent thr_parent" }]);
  assert.equal(getDelegation(db, delegationId)?.state, "reserved");
  const empty = createSandyHosts(fakeSandy({ descendants: { thr_parent: [] } }).sandy).watchdogHost;
  assert.deepEqual(await empty.spawnCandidates("thr_parent", delegationId), []);
  assert.deepEqual((await sweepWatchdog(db, empty, WINDOW, 1_000 + SPAWN_SETTLE_MS)).released, [delegationId]);
});

test("sandy-host watchdog adapter: candidates carry SANDY's origin, parent and creation time; metadata naming another delegation or a deleted thread is skipped", async () => {
  const db = openDb();
  const delegationId = reserve(db, 1_000);
  const { sandy } = fakeSandy({
    descendants: { thr_parent: ["thr_child", "thr_other", "thr_deleted", "thr_plain"] },
    metadata: { thr_child: { delegationId }, thr_other: { delegationId: "dlg_other" }, thr_deleted: { delegationId } },
    threads: { thr_child: { id: "thr_child", parentThreadId: "thr_parent", originPluginId: PLUGIN, createdAt: 1_500, status: "active", archivedAt: null } },
  });
  const { watchdogHost } = createSandyHosts(sandy);
  assert.deepEqual(await watchdogHost.spawnCandidates("thr_parent", delegationId), [
    { threadId: "thr_child", parentThreadId: "thr_parent", originPluginId: PLUGIN, createdAt: 1_500, metadata: { delegationId } },
  ]);
  assert.deepEqual((await sweepWatchdog(db, watchdogHost, WINDOW, 1_000 + WINDOW)).bound, [{ delegationId, childThreadId: "thr_child" }]);
});

test("sandy-host watchdog adapter: threadState is null for a thread SANDY answers 404 for, and rethrows other errors", async () => {
  const { sandy } = fakeSandy({ descendants: {}, threads: { thr_live: { id: "thr_live", parentThreadId: "thr_parent", originPluginId: PLUGIN, createdAt: 0, status: "stopping", archivedAt: null } } });
  const { watchdogHost } = createSandyHosts(sandy);
  assert.equal(await watchdogHost.threadState("thr_gone"), null);
  assert.deepEqual(await watchdogHost.threadState("thr_live"), { status: "stopping", archived: false });
  (sandy.sdk.threads as { get: unknown }).get = async () => { throw Object.assign(new Error("HTTP 500: boom"), { status: 500 }); };
  await assert.rejects(watchdogHost.threadState("thr_live"), /boom/);
});

test("sandy-host: a sweep while sandy_delegate's spawn is still deferred keeps the reservation, even on an empty listing; the late spawn then binds", async () => {
  const db = openDb();
  let resolveSpawn!: (child: { id: string }) => void;
  let spawnCalled!: () => void;
  const spawnStarted = new Promise<void>((resolve) => { spawnCalled = resolve; });
  const { sandy, stops } = fakeSandy({
    descendants: { thr_parent: [] },
    spawn: () => { spawnCalled(); return new Promise((resolve) => { resolveSpawn = resolve; }); },
  });
  const { launchHost, watchdogHost } = createSandyHosts(sandy);
  const launching = delegate(db, launchHost, "thr_parent", { agent: "scout", task: "t", mode: "async" }, DEFAULT_SETTINGS);
  await spawnStarted;
  const delegationId = (db.prepare("SELECT delegation_id AS id FROM delegations").get() as { id: string }).id;
  assert.equal(watchdogHost.spawnInFlight(delegationId), true);
  const report = await sweepWatchdog(db, watchdogHost, WINDOW, Date.now() + 10 * WINDOW);
  assert.deepEqual(report.released, []);
  assert.deepEqual(report.kept, [{ delegationId, reason: "its spawn is still in flight" }]);
  assert.equal(getDelegation(db, delegationId)?.state, "reserved");
  resolveSpawn({ id: "thr_late" });
  const result = await launching;
  assert.ok(result.ok);
  assert.deepEqual([result.launched.threadId, getDelegation(db, delegationId)?.state], ["thr_late", "starting"]);
  assert.equal(watchdogHost.spawnInFlight(delegationId), false);
  assert.equal(getStopRequest(db, "thr_late"), null);
  assert.deepEqual(stops, []);
});

// SANDY's view of workflows-plus workers (live SANDY 0.47): a hidden thread with parentThreadId null whose lifecycle
// owner is the origin, so the origin's descendant listing is empty. threads.list serves the project's threads
// filtered as the SDK does (projectId, originPluginId, includeHidden, archived, limit/offset).
type ListedThread = { id: string; projectId: string; parentThreadId: string | null; lifecycleOwnerThreadId: string | null; originPluginId: string | null; createdAt: number; status: string; archivedAt: number | null; visibility: "hidden" | "visible" };

function fakeWorkerSandy(world: { threads: ListedThread[]; metadata: Record<string, Record<string, unknown>>; list?: (args: Record<string, unknown>) => Promise<ListedThread[]> }) {
  const { sandy } = fakeSandy({ descendants: { thr_origin: [] } });
  const threads = sandy.sdk.threads as unknown as Record<string, unknown>;
  threads.get = async ({ threadId }: { threadId: string }) => {
    const thread = world.threads.find((entry) => entry.id === threadId);
    if (thread === undefined) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
    return thread;
  };
  threads.experimental_listPluginMetadata = async ({ pluginId, threadIds }: { pluginId: string; threadIds: string[] }) => ({
    threads: pluginId !== PLUGIN ? [] : threadIds.filter((threadId) => world.metadata[threadId] !== undefined).map((threadId) => ({ threadId, metadata: world.metadata[threadId] })),
  });
  threads.list = world.list ?? (async (args: { projectId?: string; originPluginId?: string; includeHidden?: boolean; archived?: boolean; limit?: number; offset?: number }) =>
    world.threads
      .filter((thread) => (args.projectId === undefined || thread.projectId === args.projectId)
        && (args.originPluginId === undefined || thread.originPluginId === args.originPluginId)
        && (args.includeHidden === true || thread.visibility === "visible")
        && (args.archived === undefined || (thread.archivedAt !== null) === args.archived))
      .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50)));
  return sandy;
}

const originThread: ListedThread = { id: "thr_origin", projectId: "proj_test", parentThreadId: null, lifecycleOwnerThreadId: null, originPluginId: null, createdAt: 0, status: "idle", archivedAt: null, visibility: "visible" };
const workerThread = (id: string, createdAt: number, owner = "thr_origin"): ListedThread =>
  ({ id, projectId: "proj_test", parentThreadId: null, lifecycleOwnerThreadId: owner, originPluginId: PLUGIN, createdAt, status: "active", archivedAt: null, visibility: "hidden" });

const reserveWorker = async (db: Db, now: number) => {
  const admitted = await admitWorker(db, { workerPluginId: PLUGIN, workerCandidates: async () => [], rootOf: async (threadId) => threadId }, { originThreadId: "thr_origin", runId: "wfr_1", callId: "wfc_1" }, DEFAULT_SETTINGS, now);
  assert.ok(admitted.ok);
  return admitted.reservationId;
};

test("sandy-host worker reconcile: a running worker owned by the origin (parentThreadId null, lifecycle owner set) is attached after a restart, never released", async () => {
  const db = openDb();
  const reservationId = await reserveWorker(db, 1_000);
  const sandy = fakeWorkerSandy({
    threads: [originThread, workerThread("thr_worker", 1_500), workerThread("thr_foreign", 1_600, "thr_other_origin")],
    metadata: {
      thr_worker: { workflowWorker: 1, runId: "wfr_1", callId: "wfc_1", originThreadId: "thr_origin" },
      thr_foreign: { workflowWorker: 1, runId: "wfr_1", callId: "wfc_1", originThreadId: "thr_origin" },
    },
  });
  const { watchdogHost } = createSandyHosts(sandy);
  const report = await sweepWorkers(db, watchdogHost, WINDOW, 1_000 + SPAWN_SETTLE_MS, { startup: true });
  assert.deepEqual(report.released, []);
  assert.deepEqual(report.attached, [{ reservationId, threadId: "thr_worker" }]);
  assert.deepEqual([getDelegation(db, reservationId)?.state, getDelegation(db, reservationId)?.childThreadId], ["active", "thr_worker"]);
});

test("sandy-host worker reconcile: a writer worker in another project than its origin (agent option project) is attached, never released", async () => {
  const db = openDb();
  const reservationId = await reserveWorker(db, 1_000);
  const sandy = fakeWorkerSandy({
    threads: [originThread, { ...workerThread("thr_elsewhere", 1_500), projectId: "proj_target" }],
    metadata: { thr_elsewhere: { workflowWorker: 1, runId: "wfr_1", callId: "wfc_1", originThreadId: "thr_origin" } },
  });
  const { watchdogHost } = createSandyHosts(sandy);
  const report = await sweepWorkers(db, watchdogHost, WINDOW, 1_000 + SPAWN_SETTLE_MS, { startup: true });
  assert.deepEqual(report.released, []);
  assert.deepEqual(report.attached, [{ reservationId, threadId: "thr_elsewhere" }]);
});

test("sandy-host workerCallRunning asks the workflows part through the link; null while it is not linked", async () => {
  const sandy = fakeWorkerSandy({ threads: [originThread], metadata: {} });
  const calls: unknown[] = [];
  const workers: { workflows: { callRunning(call: { runId: string; callId: string; attempt: number }): boolean } | null } = { workflows: null };
  const { watchdogHost } = createSandyHosts(sandy, workers);
  const call = { runId: "wfr_1", callId: "wfc_1", attempt: 1 };
  assert.equal(await watchdogHost.workerCallRunning(call), null);
  let running = true;
  workers.workflows = { callRunning: (asked) => { calls.push(asked); return running; } };
  assert.equal(await watchdogHost.workerCallRunning(call), true);
  running = false;
  assert.equal(await watchdogHost.workerCallRunning(call), false);
  assert.deepEqual(calls, [call, call]);
});

test("sandy-host worker reconcile: a failed or incomplete thread listing keeps the reservation (unknown is not absent)", async () => {
  const db = openDb();
  const reservationId = await reserveWorker(db, 1_000);
  const failing = createSandyHosts(fakeWorkerSandy({
    threads: [originThread], metadata: {},
    list: async () => { throw Object.assign(new Error("HTTP 500: boom"), { status: 500 }); },
  })).watchdogHost;
  const failed = await sweepWorkers(db, failing, WINDOW, 1_000 + SPAWN_SETTLE_MS);
  assert.deepEqual([failed.released, failed.failures.map((entry) => entry.subject)], [[], [reservationId]]);
  const endless = createSandyHosts(fakeWorkerSandy({
    threads: [originThread], metadata: {},
    list: async (args) => Array.from({ length: args.limit as number }, (_, index) => workerThread(`thr_unowned_${(args.offset as number) + index}`, 2_000, "thr_other_origin")),
  })).watchdogHost;
  assert.equal(await endless.workerCandidates("thr_origin"), null);
  assert.deepEqual((await sweepWorkers(db, endless, WINDOW, 1_000 + SPAWN_SETTLE_MS)).released, []);
  assert.equal(getDelegation(db, reservationId)?.state, "reserved");
  const empty = createSandyHosts(fakeWorkerSandy({ threads: [originThread], metadata: {} })).watchdogHost;
  assert.deepEqual((await sweepWorkers(db, empty, WINDOW, 1_000 + SPAWN_SETTLE_MS)).released, [reservationId]);
});

