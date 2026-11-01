import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { pluginNotInstalled } from "./worker-test-host.js";
import { afterEach, describe, expect, it } from "vitest";
import { getCall, getRunRequired, migrations, retiredWorkers } from "./data.js";
import { KEEP_WARM_FILE, KEEP_WARM_WAIT_MS } from "./keep-warm.js";
import { createWorkflowService } from "./service.js";

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function source(body: string): string {
  return `export const meta = { name: "session-test", description: "Session reuse" };\n${body}`;
}

const model = {
  id: "model-a",
  model: "model-a",
  displayName: "model-a",
  description: "test",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "test" }],
  defaultReasoningEffort: "medium",
  isDefault: true,
};

describe("reusable worker sessions", () => {
  const hosts: Array<ReturnType<typeof createFakePluginHost>["harness"]> = [];
  const workers: Array<{ controller: AbortController; done: Promise<unknown> }> = [];

  afterEach(async () => {
    for (const worker of workers) worker.controller.abort();
    await Promise.allSettled(workers.map((worker) => worker.done));
    workers.length = 0;
    await Promise.all(hosts.map((host) => host.dispose()));
    hosts.length = 0;
  });

  function setup() {
    const status = new Map<string, string>();
    const spawned: Array<{ id: string; prompt: string }> = [];
    const sent: Array<{ threadId: string; text: string }> = [];
    const files = new Map<string, string>();
    const { sandy, harness } = createFakePluginHost({
      pluginId: "workflows-plus",
      sdk: {
        plugins: { callRpc: pluginNotInstalled },
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            ({
              id: threadId,
              environmentId: "environment-1",
              providerId: "pi",
              status: threadId === "origin" ? "idle" : (status.get(threadId) ?? "active"),
            }) as never,
          defaultExecutionOptions: async () => ({
            model: "model-a",
            reasoningLevel: "medium",
            permissionMode: "auto",
            serviceTier: "default",
            source: "default",
          }),
          spawn: async (input: { prompt: string }) => {
            const id = `child-${spawned.length + 1}`;
            spawned.push({ id, prompt: input.prompt });
            status.set(id, "active");
            return { id } as never;
          },
          send: async (input: { threadId: string; input: Array<{ text: string }> }) => {
            sent.push({ threadId: input.threadId, text: input.input[0]!.text });
            status.set(input.threadId, "active");
            return { ok: true } as never;
          },
          stop: async () => ({ ok: true }) as never,
          archive: async () => ({ ok: true }) as never,
          storageLocation: async ({ threadId }: { threadId: string }) =>
            ({ hostId: "worker-host", storageRootPath: `/storage/${threadId}` }) as never,
        },
        files: {
          write: async (input: { hostId?: string; path: string; content: string }) => {
            files.set(`${input.hostId}:${input.path}`, input.content);
            return { outcome: "written" } as never;
          },
          remove: async (input: { hostId?: string; path: string }) => {
            files.delete(`${input.hostId}:${input.path}`);
            return { ok: true } as never;
          },
        },
        providers: {
          list: async () => [
            {
              id: "pi",
              displayName: "Pi",
              logoUrl: null,
              available: true,
              capabilities: {
                supportsThreadArchive: true,
                supportsThreadRename: true,
                supportsServiceTier: false,
                supportsNativeUserQuestion: false,
                supportsFork: true,
                permissionModes: ["auto"],
              },
              composerActions: [],
            },
          ],
          models: async () => ({
            providers: [],
            models: [model],
            selectedOnlyModels: [],
            modelLoadError: null,
          }),
        },
      } as never,
    });
    hosts.push(harness);
    const db = sandy.storage.database();
    sandy.storage.migrate(db, migrations);
    const service = createWorkflowService(sandy, db);
    const controller = new AbortController();
    workers.push({ controller, done: service.runWorker(controller.signal) });

    return {
      db,
      service,
      spawned,
      sent,
      files,
      start: (body: string) =>
        service.start({
          projectId: "project-test",
          originThreadId: "origin",
          source: source(body),
          args: null,
          resumedFromRunId: null,
        }),
      /** The worker's turn ends: the thread goes idle with this last text. */
      finish(threadId: string, output: string) {
        status.set(threadId, "idle");
        service.onThreadIdle(threadId, output);
      },
    };
  }

  it("continues a kept worker thread instead of spawning a new one", async () => {
    const test = setup();
    const run = await test.start(`
      const first = await agent("write the tests", { keep: true });
      const second = await agent("reviewer says: cover the error path", { session: first.session });
      return { first, second };`);

    await eventually(() => expect(test.spawned).toHaveLength(1));
    test.finish("child-1", "round 1");
    await eventually(() => expect(test.sent).toHaveLength(1));
    expect(test.sent[0]!.threadId).toBe("child-1");
    expect(test.sent[0]!.text).toContain("reviewer says: cover the error path");
    expect(retiredWorkers(test.db, Date.now() + 120_000)).toEqual([]);

    test.finish("child-1", "round 2");
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("succeeded"));
    expect(JSON.parse(getRunRequired(test.db, run.id).resultJson!)).toEqual({
      first: { value: "round 1", session: "child-1" },
      second: { value: "round 2", session: "child-1" },
    });
    expect(test.spawned).toHaveLength(1);
    expect(getCall(test.db, run.id, 0)!.childThreadId).toBeNull();
    expect(getCall(test.db, run.id, 1)!.childThreadId).toBe("child-1");
  });

  it("announces a kept worker's wait in its thread storage until the worker continues", async () => {
    const test = setup();
    const run = await test.start(`
      const first = await agent("write the tests", { keep: true });
      const review = await agent("review the tests");
      return await agent("reviewer says: " + review, { session: first.session });`);
    const signal = `worker-host:/storage/child-1/${KEEP_WARM_FILE}`;
    await eventually(() => expect(test.spawned).toHaveLength(1));
    expect(test.files.has(signal)).toBe(false);
    const finished = Date.now();
    test.finish("child-1", "round 1");
    await eventually(() => expect(test.spawned).toHaveLength(2));
    const { until } = JSON.parse(test.files.get(signal)!) as { until: number };
    expect(until).toBeGreaterThanOrEqual(finished + KEEP_WARM_WAIT_MS);
    expect(until).toBeLessThan(finished + KEEP_WARM_WAIT_MS + 5_000);
    test.finish("child-2", "cover the error path");
    await eventually(() => expect(test.sent).toHaveLength(1));
    expect(test.files.has(signal)).toBe(false);
    test.finish("child-1", "round 2");
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("succeeded"));
  });

  it("sends a raw prompt verbatim so a slash command reaches the worker", async () => {
    const test = setup();
    const run = await test.start(`return await agent("/autopilot backend-tests", { raw: true });`);
    await eventually(() => expect(test.spawned).toHaveLength(1));
    expect(test.spawned[0]!.prompt).toBe("/autopilot backend-tests");
    test.finish("child-1", "");
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("succeeded"));
  });

  it("returns the value an autopilot recorded instead of the last text", async () => {
    const test = setup();
    const run = await test.start(`return await agent("/autopilot backend-tests", { raw: true });`);
    await eventually(() => expect(test.spawned).toHaveLength(1));
    expect(test.service.submitWorkerResult("child-1", { green: true, files: 2 })).toEqual({ ok: true });
    test.finish("child-1", "");
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("succeeded"));
    expect(JSON.parse(getRunRequired(test.db, run.id).resultJson!)).toEqual({ green: true, files: 2 });
  });

  it("waits through an autopilot's own turns until it reports, with report: true", async () => {
    const test = setup();
    const run = await test.start(`return await agent("/autopilot --report steer", { raw: true, report: true });`);
    await eventually(() => expect(test.spawned).toHaveLength(1));
    test.finish("child-1", "one");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getRunRequired(test.db, run.id).status).toBe("running");
    expect(test.service.submitWorkerResult("child-1", { restored: true })).toEqual({ ok: true });
    test.finish("child-1", "ok");
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("succeeded"));
    expect(JSON.parse(getRunRequired(test.db, run.id).resultJson!)).toEqual({ restored: true });
  });

  it("rejects a recorded value that does not match the call's schema", async () => {
    const test = setup();
    await test.start(
      `return await agent("/autopilot x", { raw: true, schema: { type: "object", required: ["green"], properties: { green: { type: "boolean" } } } });`,
    );
    await eventually(() => expect(test.spawned).toHaveLength(1));
    const outcome = test.service.submitWorkerResult("child-1", { green: "yes" });
    expect(outcome.ok).toBe(false);
  });

  it("refuses to continue a worker that was not kept", async () => {
    const test = setup();
    const run = await test.start(`
      const first = await agent("write");
      return await agent("again", { session: "child-1" });`);
    await eventually(() => expect(test.spawned).toHaveLength(1));
    test.finish("child-1", "done");
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("failed"));
    expect(getRunRequired(test.db, run.id).error).toContain("keep: true");
    expect(test.sent.filter((message) => message.threadId === "child-1")).toEqual([]);
  });

  it("gives a kept worker the same configuration in every call, schema or not", async () => {
    const test = setup();
    const run = await test.start(`
      const first = await agent("write the tests", { keep: true });
      return await agent("now report", { session: first.session, schema: { type: "object", required: ["green"], properties: { green: { type: "boolean" } } } });`);
    await eventually(() => expect(test.spawned).toHaveLength(1));
    const during = test.service.agentConfiguration("child-1");
    test.finish("child-1", "round 1");
    await eventually(() => expect(test.sent).toHaveLength(1));
    expect(test.service.agentConfiguration("child-1")).toEqual(during);
    expect(during).toEqual({ reusable: true });
    expect(test.sent[0]!.text).toContain('"green"');

    expect(await test.service.submitStructuredResult("child-1", { green: "yes" })).toMatchObject({ ok: false, terminal: false });
    expect(await test.service.submitStructuredResult("child-1", { green: true })).toEqual({ ok: true });
    expect(getRunRequired(test.db, run.id).status).toBe("running");
    test.finish("child-1", "done");
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("succeeded"));
    expect(JSON.parse(getRunRequired(test.db, run.id).resultJson!)).toEqual({ value: { green: true }, session: "child-1" });
  });

  it("rejects a non-boolean keep option", async () => {
    const test = setup();
    const run = await test.start(`return await agent("x", { keep: "yes" });`);
    await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("failed"));
    expect(getRunRequired(test.db, run.id).error).toContain("keep must be a boolean");
  });
});
