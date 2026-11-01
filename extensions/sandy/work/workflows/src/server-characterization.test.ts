import { createFakePluginHost, makePluginAgentConfigurationContext } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./server.js";
import { eventually, pluginNotInstalled } from "./worker-test-host.js";

/**
 * Characterization of the plugin entry as it behaves today (slice 15): what configure hands out to threads, and what
 * the result tool does for ordinary and reusable workers. Slice 16 (rebase) and slice 18 (worker admission) rely on
 * these staying as they are.
 */

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

function setup() {
  const status = new Map<string, string>();
  const spawned: Array<{ id: string; input: Record<string, unknown> }> = [];
  let onSpawn: (id: string) => Promise<void> = async () => {};
  let harness!: Harness;
  const workerServices: Array<ReturnType<Harness["runService"]>> = [];
  const host = createFakePluginHost({
    pluginId: "workflows-plus",
    agentSkillIds: ["workflows-plus"],
    sdk: {
      plugins: { callRpc: pluginNotInstalled },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          ({
            id: threadId,
            environmentId: "environment-1",
            providerId: "codex",
            status: threadId === "thread-test" ? "idle" : (status.get(threadId) ?? "active"),
          }) as never,
        defaultExecutionOptions: async () => ({
          model: "gpt-test",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "default",
        }),
        spawn: async (input: Record<string, unknown>) => {
          const id = `child-${spawned.length + 1}`;
          spawned.push({ id, input });
          status.set(id, "active");
          await onSpawn(id);
          return { id } as never;
        },
        send: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        archive: async () => ({ ok: true }),
        storageLocation: async ({ threadId }: { threadId: string }) =>
          ({ hostId: "worker-host", storageRootPath: `/storage/${threadId}` }) as never,
      },
      files: {
        write: async () => ({ outcome: "written" }) as never,
        remove: async () => ({ ok: true }) as never,
      },
      providers: {
        list: async () => [
          {
            id: "codex",
            displayName: "Codex",
            logoUrl: null,
            available: true,
            capabilities: {
              supportsThreadArchive: true,
              supportsThreadRename: true,
              supportsServiceTier: true,
              supportsNativeUserQuestion: false,
              supportsFork: true,
              permissionModes: ["full"],
            },
            composerActions: [],
          },
        ],
        models: async () => ({
          providers: [],
          selectedOnlyModels: [],
          modelLoadError: null,
          models: [
            {
              id: "gpt-test",
              model: "gpt-test",
              displayName: "GPT Test",
              description: "test",
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "test" }],
              defaultReasoningEffort: "medium",
              isDefault: true,
            },
          ],
        }),
      },
    } as never,
  });
  harness = host.harness;
  return {
    sandy: host.sandy,
    harness,
    async dispose() {
      for (const worker of workerServices) {
        worker.controller.abort();
        await worker.done;
      }
      await harness.dispose();
    },
    status,
    spawned,
    beforeSpawnReturns(hook: (id: string) => Promise<void>) {
      onSpawn = hook;
    },
    // A worker spawn carries workflowWorker: 1 in its pluginMetadata (service.ts); pass worker: false for a
    // thread this plugin started that is no worker (a delegate child of sandy/work).
    configure: (threadId: string, pluginId?: string, worker = true) =>
      harness.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { id: threadId, parentThreadId: "thread-test" },
          ...(pluginId === undefined ? {} : { origin: { pluginId } }),
          ...(pluginId !== undefined && worker ? { pluginMetadata: { workflowWorker: 1 } } : {}),
        }),
      ),
    async startRun(source: string) {
      const started = JSON.parse((await harness.callAgentTool("sandy_workflow_plus_run", { source })) as string) as {
        runId: string;
      };
      workerServices.push(harness.runService("workflow-worker"));
      return started.runId;
    },
    async runResult(runId: string) {
      const result = await harness.runCli(["status", runId], { threadId: "thread-test", projectId: "project-test" });
      return JSON.parse(result.stdout!) as { status: string; result: unknown };
    },
    callResultTool: (threadId: string, value: unknown) =>
      harness.callAgentTool("sandy_workflow_plus_result", { value }, { threadId, projectId: "project-test" }),
    async idle(threadId: string, text: string) {
      status.set(threadId, "idle");
      await harness.emitThreadEvent("thread.idle", { thread: { id: threadId } as never, lastAssistantText: text });
    },
  };
}

const meta = `export const meta = { name: "configure-test", description: "Configure" };\n`;
const greenSchema = '{ type: "object", required: ["green"], properties: { green: { type: "boolean" } } }';

describe("plugin entry characterization", () => {
  const hosts: Array<{ dispose(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    hosts.length = 0;
  });

  describe("configure recognises a worker by origin before it is attached", () => {
    it("treats a thread started by this plugin as a worker even before its call knows the thread", async () => {
      const test = setup();
      hosts.push(test);
      await plugin(test.sandy);
      // SANDY calls configure shortly after spawn returns, which can be before the plugin attached the child to its call.
      let beforeAttach: Awaited<ReturnType<typeof test.configure>> | undefined;
      test.beforeSpawnReturns(async (id) => {
        beforeAttach = await test.configure(id, "workflows-plus");
      });
      const runId = await test.startRun(
        `${meta}return await agent("work", { outputSchema: ${greenSchema} });`,
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      expect(beforeAttach).toBeDefined();
      expect(beforeAttach!.tools.map((tool) => tool.name)).toEqual(["sandy_workflow_plus_result"]);
      expect(beforeAttach!.skills).toEqual([]);
      expect(beforeAttach!.instructions).toContain("You are starting as a SANDY workflow worker.");
      expect(JSON.stringify(beforeAttach!.tools[0]!.inputSchema)).not.toContain("green");

      // Once attached, the call's own schema and instructions take over.
      const attached = await test.configure("child-1", "workflows-plus");
      expect(JSON.stringify(attached.tools[0]!.inputSchema)).toContain("green");
      expect(attached.instructions).toContain("Required schema:");

      await expect(test.callResultTool("child-1", { green: true })).resolves.toBe(
        JSON.stringify({ accepted: true }, null, 2),
      );
      const terminal = await test.configure("child-1", "workflows-plus");
      expect(terminal.tools).toEqual([]);
      expect(terminal.instructions).toBe("This workflow worker is already terminal. Do not perform more work.");
      await eventually(async () => expect((await test.runResult(runId)).status).toBe("succeeded"));
    });

    it("gives the author configuration to a thread this plugin started that is no workflow worker", async () => {
      const test = setup();
      hosts.push(test);
      await plugin(test.sandy);
      const child = await test.configure("delegate-child", "workflows-plus", false);
      expect(child.tools.map((tool) => tool.name)).toContain("sandy_workflow_plus_run");
    });

    it("gives the author configuration to a thread without this plugin as origin, attached or not", async () => {
      const test = setup();
      hosts.push(test);
      await plugin(test.sandy);
      for (const [threadId, origin] of [
        ["thread-test", undefined],
        ["unknown-thread", undefined],
        ["unknown-thread", "workflows"],
        ["unknown-thread", "delegate"],
      ] as const) {
        const config = await test.configure(threadId, origin);
        expect(config.tools.map((tool) => tool.name)).toEqual(["sandy_workflow_plus_run"]);
        expect(config.skills).toEqual(["workflows-plus"]);
      }
    });
  });

  describe("reusable worker configuration (prompt cache)", () => {
    it("hands a kept worker the same tools and instructions before, during and after every call", async () => {
      const test = setup();
      hosts.push(test);
      await plugin(test.sandy);
      const runId = await test.startRun(
        `${meta}const first = await agent("write", { keep: true });
        return await agent("again", { session: first.session, schema: ${greenSchema} });`,
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      const duringFirst = await test.configure("child-1", "workflows-plus");
      await test.idle("child-1", "round 1");
      await eventually(async () =>
        expect(test.harness.sdk.callsTo("threads.send").some(([input]) => (input as { threadId: string }).threadId === "child-1")).toBe(true),
      );
      const duringSecond = await test.configure("child-1", "workflows-plus");

      // The schema reaches the worker in the prompt and is checked on submit, never through the configuration.
      await expect(test.callResultTool("child-1", { green: "yes" })).resolves.toMatchObject({ isError: true });
      await expect(test.callResultTool("child-1", { green: true })).resolves.toBe(
        JSON.stringify({ accepted: true }, null, 2),
      );
      const stopsOfChild = () =>
        test.harness.sdk.callsTo("threads.stop").filter(([input]) => (input as { threadId: string }).threadId === "child-1");
      expect(stopsOfChild()).toHaveLength(0);
      await test.idle("child-1", "round 2");
      await eventually(async () => expect((await test.runResult(runId)).status).toBe("succeeded"));
      const afterRun = await test.configure("child-1", "workflows-plus");

      expect(duringFirst.tools.map((tool) => tool.name)).toEqual(["sandy_workflow_plus_result"]);
      expect(duringFirst.skills).toEqual([]);
      expect(duringFirst.instructions).toContain("You are a reusable SANDY workflow worker.");
      expect(JSON.stringify(duringFirst.tools)).not.toContain("green");
      expect(duringSecond).toEqual(duringFirst);
      expect(afterRun).toEqual(duringFirst);
      await expect(test.runResult(runId)).resolves.toMatchObject({ result: { value: { green: true }, session: "child-1" } });
    });

    it("changes a plain worker's configuration with its call: schema while running, nothing once terminal", async () => {
      const test = setup();
      hosts.push(test);
      await plugin(test.sandy);
      await test.startRun(`${meta}return await agent("work", { outputSchema: ${greenSchema} });`);
      await eventually(() => expect(test.spawned).toHaveLength(1));
      const running = await test.configure("child-1", "workflows-plus");
      await test.callResultTool("child-1", { green: true });
      const terminal = await test.configure("child-1", "workflows-plus");
      expect(running).not.toEqual(terminal);
      expect(running.instructions).not.toContain("reusable");
    });
  });
});
