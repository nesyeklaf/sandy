import { afterEach, describe, expect, it } from "vitest";
import { getCall, getRunRequired } from "./data.js";
import { ADMISSION_RETRY_DELAYS_MS, createWorkerAdmission } from "./worker-admission.js";
import { createWorkerTestHost, eventually, workflowSource } from "./worker-test-host.js";

/** Slice 18: workers through delegate's admission (workers.admit/attach/release) and writer isolation. */

type Delegate = NonNullable<Parameters<typeof createWorkerTestHost>[0]>["delegate"];

/** A delegate that admits every call with one reservation per call and attempt, or per kept thread. */
function admittingDelegate(): Delegate {
  return (method, input) => {
    if (method === "workers.admit") {
      return { ok: true, reservationId: `dlg_${input.threadId ?? `${input.callId}_${input.attempt}`}`, lease: `wl_${input.callId}`, state: "reserved" };
    }
    if (method === "workers.attach") return { ok: true, reservationId: input.reservationId, threadId: input.threadId };
    return { ok: true, released: true };
  };
}

describe("worker admission and isolation", () => {
  const hosts: Array<ReturnType<typeof createWorkerTestHost>> = [];
  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    hosts.length = 0;
  });
  function setup(options?: Parameters<typeof createWorkerTestHost>[0]) {
    const host = createWorkerTestHost(options);
    hosts.push(host);
    return host;
  }
  const status = (test: ReturnType<typeof setup>, runId: string) => getRunRequired(test.db, runId).status;

  it("admits before the spawn, attaches the spawned thread, releases when the call settles", async () => {
    const test = setup({ delegate: admittingDelegate() });
    const run = await test.start(workflowSource(`return await agent("one");`));
    await eventually(() => expect(test.spawned).toHaveLength(1));
    const callId = getCall(test.db, run.id, 0)!.id;
    expect(test.rpcCalls).toEqual([
      { method: "workers.admit", input: { originThreadId: "origin", runId: run.id, callId, attempt: 0 } },
      { method: "workers.attach", input: { reservationId: `dlg_${callId}_0`, lease: `wl_${callId}`, threadId: "child-1" } },
    ]);
    test.finish("child-1", "done");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
    expect(test.rpcCalls.at(-1)).toEqual({ method: "workers.release", input: { reservationId: `dlg_${callId}_0`, lease: `wl_${callId}` } });
  });

  it("admits a kept-session continuation for the kept thread before sending, and releases after its turn", async () => {
    const test = setup({ delegate: admittingDelegate() });
    const run = await test.start(
      workflowSource(`
        const first = await agent("write", { keep: true });
        return await agent("revise", { session: first.session });`),
    );
    await eventually(() => expect(test.spawned).toHaveLength(1));
    test.finish("child-1", "r1");
    await eventually(() => expect(test.sent).toHaveLength(1));
    const second = getCall(test.db, run.id, 1)!.id;
    const methods = test.rpcCalls.map((entry) => entry.method);
    expect(methods).toEqual(["workers.admit", "workers.attach", "workers.release", "workers.admit"]);
    expect(test.rpcCalls[3]!.input).toEqual({ originThreadId: "origin", runId: run.id, callId: second, attempt: 0, threadId: "child-1" });
    test.finish("child-1", "r2");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
    expect(test.rpcCalls.at(-1)).toEqual({ method: "workers.release", input: { reservationId: "dlg_child-1", lease: `wl_${second}` } });
  });

  it("waits while the root is full and spawns once delegate admits", async () => {
    let full = true;
    const admit = admittingDelegate()!;
    const test = setup({
      delegate: (method, input) =>
        method === "workers.admit" && full
          ? { ok: false, code: "limit_reached", message: "root is full (4 running)", running: ["a", "b", "c", "d"] }
          : admit(method, input),
    });
    const run = await test.start(workflowSource(`return await agent("waits");`));
    await eventually(() => expect(test.rpcCalls.filter((entry) => entry.method === "workers.admit").length).toBeGreaterThanOrEqual(2));
    expect(test.spawned).toHaveLength(0);
    full = false;
    await eventually(() => expect(test.spawned).toHaveLength(1));
    test.finish("child-1", "ok");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
  });

  it("a run cancelled while waiting for a slot never spawns", async () => {
    const test = setup({ delegate: () => ({ ok: false, code: "limit_reached", message: "root is full (4 running)" }) });
    const run = await test.start(workflowSource(`return await agent("never");`));
    await eventually(() => expect(test.rpcCalls.length).toBeGreaterThanOrEqual(1));
    await test.service.stop(run.id);
    await eventually(() => expect(status(test, run.id)).toBe("cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(test.spawned).toHaveLength(0);
  });

  it("fails the call when delegate refuses the worker outright (origin is a delegated child)", async () => {
    const test = setup({ delegate: () => ({ ok: false, code: "nested_delegation", message: "origin is itself a delegated child" }) });
    const run = await test.start(workflowSource(`return await agent("nested");`));
    await eventually(() => expect(status(test, run.id)).toBe("failed"));
    expect(test.spawned).toHaveLength(0);
    expect(getRunRequired(test.db, run.id).error).toContain("nested_delegation");
  });

  it("a cancelled worker's slot is released only once SANDY confirms its stop", async () => {
    const pendingStops: Array<() => void> = [];
    const confirmStop = () => pendingStops.splice(0).forEach((resolve) => resolve());
    const test = setup({ delegate: admittingDelegate(), stopThread: () => new Promise<void>((resolve) => pendingStops.push(resolve)) });
    const run = await test.start(workflowSource(`return await agent("long");`));
    await eventually(() => expect(test.rpcCalls.map((entry) => entry.method)).toEqual(["workers.admit", "workers.attach"]));
    void test.service.stop(run.id);
    await eventually(() => expect(test.stopped).toContain("child-1"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(test.rpcCalls.map((entry) => entry.method)).not.toContain("workers.release");
    confirmStop();
    await eventually(() => expect(test.rpcCalls.at(-1)?.method).toBe("workers.release"));
  });

  it("a cancelled worker whose stop fails keeps its slot (delegate's sweep frees it once SANDY shows the worker stopped)", async () => {
    const test = setup({ delegate: admittingDelegate(), stopThread: async () => { throw new Error("stop failed"); } });
    const run = await test.start(workflowSource(`return await agent("long");`));
    await eventually(() => expect(test.rpcCalls).toHaveLength(2));
    await test.service.stop(run.id);
    await eventually(() => expect(status(test, run.id)).toBe("cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(test.rpcCalls.map((entry) => entry.method)).toEqual(["workers.admit", "workers.attach"]);
  });

  it("a cancelled continuation whose stop fails keeps the kept worker's slot", async () => {
    let failStop = false;
    const test = setup({ delegate: admittingDelegate(), stopThread: async () => { if (failStop) throw new Error("stop failed"); } });
    const run = await test.start(
      workflowSource(`
        const first = await agent("write", { keep: true });
        return await agent("revise", { session: first.session });`),
    );
    await eventually(() => expect(test.spawned).toHaveLength(1));
    test.finish("child-1", "r1");
    await eventually(() => expect(test.sent).toHaveLength(1));
    failStop = true;
    await test.service.stop(run.id);
    await eventually(() => expect(status(test, run.id)).toBe("cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(test.rpcCalls.map((entry) => entry.method)).toEqual(["workers.admit", "workers.attach", "workers.release", "workers.admit"]);
  });

  it("a reporting call's worker attempt counts as running across its idle turns, until the call settles", async () => {
    const test = setup({ delegate: admittingDelegate() });
    const run = await test.start(workflowSource(`return await agent("flow", { report: true });`));
    await eventually(() => expect(test.spawned).toHaveLength(1));
    const callId = getCall(test.db, run.id, 0)!.id;
    test.finish("child-1", "turn one done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status(test, run.id)).toBe("running");
    expect(test.service.isWorkerCallRunning({ runId: run.id, callId, attempt: 0 })).toBe(true);
    expect(test.service.isWorkerCallRunning({ runId: run.id, callId, attempt: 1 })).toBe(false);
    expect(test.service.isWorkerCallRunning({ runId: "other-run", callId, attempt: 0 })).toBe(false);
    await test.service.stop(run.id);
    await eventually(() => expect(status(test, run.id)).toBe("cancelled"));
    expect(test.service.isWorkerCallRunning({ runId: run.id, callId, attempt: 0 })).toBe(false);
  });

  it("a continuation waits while delegate reports the kept worker busy with another call", async () => {
    let busy = true;
    const admit = admittingDelegate()!;
    const test = setup({
      delegate: (method, input) =>
        method === "workers.admit" && input.threadId !== undefined && busy
          ? { ok: false, code: "worker_busy", message: "worker child-1 is running another call" }
          : admit(method, input),
    });
    const run = await test.start(
      workflowSource(`
        const first = await agent("write", { keep: true });
        return await agent("revise", { session: first.session });`),
    );
    await eventually(() => expect(test.spawned).toHaveLength(1));
    test.finish("child-1", "r1");
    await eventually(() => expect(test.rpcCalls.filter((entry) => entry.input.threadId === "child-1").length).toBeGreaterThanOrEqual(2));
    expect(test.sent).toHaveLength(0);
    busy = false;
    await eventually(() => expect(test.sent).toHaveLength(1));
    test.finish("child-1", "r2");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
  });

  it("a writer continuing a reader session (origin's checkout) is rejected; a writer continuing a writer session stays in its worktree", async () => {
    const reader = setup({ delegate: admittingDelegate() });
    const refused = await reader.start(
      workflowSource(`
        const first = await agent("read", { keep: true });
        return await agent("write", { session: first.session, writes: true });`),
    );
    await eventually(() => expect(reader.spawned).toHaveLength(1));
    reader.finish("child-1", "r1");
    await eventually(() => expect(status(reader, refused.id)).toBe("failed"));
    expect(getRunRequired(reader.db, refused.id).error).toContain("not its own managed worktree");
    expect(reader.sent.filter((entry) => entry.threadId === "child-1")).toEqual([]);
    expect(reader.rpcCalls.filter((entry) => entry.method === "workers.admit" && entry.input.threadId !== undefined)).toEqual([]);

    const writer = setup({ delegate: admittingDelegate() });
    const run = await writer.start(
      workflowSource(`
        const first = await agent("write", { keep: true, writes: true });
        return await agent("write more", { session: first.session, writes: true });`),
    );
    await eventually(() => expect(writer.spawned).toHaveLength(1));
    writer.finish("child-1", "w1");
    await eventually(() => expect(writer.sent).toHaveLength(1));
    expect(writer.sent[0]!.threadId).toBe("child-1");
    expect(writer.spawned).toHaveLength(1);
    writer.finish("child-1", "w2");
    await eventually(() => expect(status(writer, run.id)).toBe("succeeded"));
  });

  it("a workers.admit that fails transiently is retried, and the worker spawns under the slot", async () => {
    let failures = 1;
    const admit = admittingDelegate()!;
    const test = setup({
      delegate: (method, input) => {
        if (method === "workers.admit" && failures > 0) {
          failures -= 1;
          throw new Error("timeout");
        }
        return admit(method, input);
      },
    });
    const run = await test.start(workflowSource(`return await agent("one");`));
    await eventually(() => expect(test.spawned).toHaveLength(1));
    expect(test.rpcCalls.map((entry) => entry.method)).toEqual(["workers.admit", "workers.admit", "workers.attach"]);
    test.finish("child-1", "ok");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
  });

  it("without the delegate plugin, skips admission and spawns as before", async () => {
    const test = setup();
    const run = await test.start(workflowSource(`return await agent("alone");`));
    await eventually(() => expect(test.spawned).toHaveLength(1));
    expect(test.rpcCalls).toEqual([]);
    test.finish("child-1", "ok");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
  });

  it("a writer (writes: true) gets its own managed worktree on the origin's branch, a reader reuses the origin's environment", async () => {
    const test = setup({ originEnvironmentId: "env-origin-7", originCheckout: { isGitRepo: true, branchName: "feature/x" } });
    const run = await test.start(
      workflowSource(`return await Promise.all([agent("reader"), agent("writer", { writes: true })]);`),
    );
    await eventually(() => expect(test.spawned).toHaveLength(2));
    const byPrompt = (text: string) => test.spawned.find((entry) => entry.prompt.includes(text))!;
    expect(byPrompt("reader").input.environment).toEqual({ type: "reuse", environmentId: "env-origin-7" });
    expect(byPrompt("writer").input.environment).toEqual({
      type: "host",
      hostId: "worker-host",
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/x" } },
    });
    expect(byPrompt("writer").input.pluginMetadata).toMatchObject({ workflowWorker: 1, originThreadId: "origin" });
    for (const entry of test.spawned) test.finish(entry.id, "ok");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
  });

  const PROJECTS = [
    { id: "proj-repo", name: "repo", kind: "standard" as const, sources: [{ hostId: "other-host", isDefault: true }, { hostId: "worker-host", isDefault: false }] },
    { id: "proj-far", name: "far", kind: "standard" as const, sources: [{ hostId: "other-host", isDefault: true }] },
    { id: "proj-personal", name: "Personal", kind: "personal" as const, sources: [] },
  ];

  it("a writer with project runs in a managed worktree of that project, also from an origin that is no git checkout", async () => {
    const test = setup({ projects: PROJECTS, originCheckout: { isGitRepo: false, branchName: null } });
    const run = await test.start(
      workflowSource(`return await Promise.all([agent("here", { writes: true, project: "repo" }), agent("far", { writes: true, project: "proj-far", baseBranch: "release" })]);`),
    );
    await eventually(() => expect(test.spawned).toHaveLength(2));
    const byPrompt = (text: string) => test.spawned.find((entry) => entry.prompt.includes(text))!;
    expect(byPrompt("here").input).toMatchObject({
      projectId: "proj-repo",
      environment: { type: "host", hostId: "worker-host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
    });
    expect(byPrompt("far").input).toMatchObject({
      projectId: "proj-far",
      environment: { type: "host", hostId: "other-host", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "release" } } },
    });
    for (const entry of test.spawned) test.finish(entry.id, "ok");
    await eventually(() => expect(status(test, run.id)).toBe("succeeded"));
  });

  it("a writer with an unknown or personal project fails without taking a slot", async () => {
    for (const [project, message] of [["nope", "no project with id or name nope"], ["Personal", "personal project"]]) {
      const test = setup({ delegate: admittingDelegate(), projects: PROJECTS });
      const run = await test.start(workflowSource(`return await agent("writer", { writes: true, project: "${project}" });`));
      await eventually(() => expect(status(test, run.id)).toBe("failed"));
      expect(getRunRequired(test.db, run.id).error).toContain(message);
      expect(test.spawned).toHaveLength(0);
      expect(test.rpcCalls).toEqual([]);
    }
  });

  it("project without writes, baseBranch without project and project with session are refused", async () => {
    for (const [options, message] of [
      [`{ project: "repo" }`, "needs writes: true"],
      [`{ writes: true, baseBranch: "main" }`, "baseBranch needs"],
      [`{ writes: true, project: "repo", session: "thr-x" }`, "omit project with session"],
    ]) {
      const test = setup({ projects: PROJECTS });
      const run = await test.start(workflowSource(`return await agent("writer", ${options});`));
      await eventually(() => expect(status(test, run.id)).toBe("failed"));
      expect(getRunRequired(test.db, run.id).error).toContain(message);
      expect(test.spawned).toHaveLength(0);
    }
  });

  it("a writer fails when the origin is not a git checkout on a branch, without taking a slot", async () => {
    const test = setup({ delegate: admittingDelegate(), originCheckout: { isGitRepo: true, branchName: null } });
    const run = await test.start(workflowSource(`return await agent("writer", { writes: true });`));
    await eventually(() => expect(status(test, run.id)).toBe("failed"));
    expect(getRunRequired(test.db, run.id).error).toContain("managed worktree");
    expect(test.spawned).toHaveLength(0);
    expect(test.rpcCalls).toEqual([]);
  });
});

describe("createWorkerAdmission: only a missing delegate skips admission", () => {
  const request = { originThreadId: "origin", runId: "run-1", callId: "call-1", attempt: 0 };
  type Call = (method: string, input: Record<string, unknown>) => Promise<unknown>;
  function admissionWith(call: Call | null) {
    const sleeps: number[] = [];
    const warnings: string[] = [];
    const sandy = { log: { warn: (text: string) => warnings.push(text), info: () => {} } };
    const method = (name: string) => (input: object) => call!(name, { ...input }) as never;
    const workers = { delegate: call === null ? null : { admit: method("workers.admit"), attach: method("workers.attach"), release: method("workers.release") } };
    const admission = createWorkerAdmission(sandy as never, workers, async (ms) => {
      sleeps.push(ms);
    });
    return { admission, sleeps, warnings };
  }

  for (const [name, failure] of [
    ["a database error", () => Promise.reject(new Error("SQLITE_BUSY: database is locked"))],
    ["a host error", () => Promise.reject(Object.assign(new Error("HTTP 504: timeout"), { status: 504 }))],
  ] as const) {
    it(`${name} is retried with backoff, then fails the call (no slotless spawn)`, async () => {
      const { admission, sleeps } = admissionWith(failure);
      await expect(admission.admit(request, new AbortController().signal)).rejects.toThrow(/Worker admission failed/);
      expect(sleeps).toEqual(ADMISSION_RETRY_DELAYS_MS);
    });
  }

  it("the retry wait ends with the run", async () => {
    const controller = new AbortController();
    const { admission } = admissionWith(() => {
      controller.abort();
      return Promise.reject(new Error("SQLITE_BUSY"));
    });
    await expect(admission.admit(request, controller.signal)).rejects.toThrow();
  });

  it("a slot delegate grants while the run is cancelled is released, not leaked (admit answer arrives after the abort)", async () => {
    // delegate may commit the reservation after the run ended
    // (live: dlg_2cb33792 of wfr_df7536d1, reserved 20 ms after the run failed, never released).
    const controller = new AbortController();
    let grant!: (answer: unknown) => void;
    const released: unknown[] = [];
    const { admission } = admissionWith((method, input) => {
      if (method === "workers.release") {
        released.push(input);
        return Promise.resolve({ ok: true, released: true });
      }
      return new Promise((resolve) => {
        grant = resolve;
      });
    });
    const admitting = admission.admit(request, controller.signal);
    controller.abort();
    grant({ ok: true, reservationId: "dlg_late", lease: "wl_late", state: "reserved" });
    await expect(admitting).rejects.toThrow();
    await eventually(() => expect(released).toEqual([{ reservationId: "dlg_late", lease: "wl_late" }]));
  });

  it("an unlinked delegate part skips admission, logged", async () => {
    const missing = admissionWith(null);
    await expect(missing.admission.admit(request, new AbortController().signal)).resolves.toBeNull();
    expect(missing.warnings.join("\n")).toContain("the delegate part is not loaded");
  });
});
