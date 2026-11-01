import { beforeEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@sandy-sdk/plugin-sdk/testing";
import plugin, { type RenameResult } from "./server";

const PLUGIN_ID = "thread-namer";
const THREAD_ID = "thr_named";
const WORKER_ID = "thr_worker";

/**
 * A host whose thread area behaves like the one a naming run walks through:
 * the thread being named, its outline, the spawned worker and the worker's
 * answer.
 */
function createHost(options: {
  thread?: Partial<Parameters<typeof makeThreadResponse>[0]>;
  outline?: { role: "user" | "assistant"; preview: string }[];
  answer?: string;
  settings?: Record<string, string>;
}) {
  const thread = makeThreadResponse({
    id: THREAD_ID,
    projectId: "proj_1",
    environmentId: "env_1",
    providerId: "claude",
    title: null,
    ...options.thread,
  });
  const outline = options.outline ?? [
    { role: "user" as const, preview: "The login test fails on CI" },
  ];

  const updates: { threadId: string; title?: string | null }[] = [];
  const spawns: Record<string, unknown>[] = [];
  const record = (args: unknown) => {
    spawns.push(args as Record<string, unknown>);
  };

  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    ...(options.settings ? { settings: options.settings } : {}),
    sdk: {
      providers: {
        list: async () => [
          {
            id: "claude",
            displayName: "Claude Code",
            available: true,
            capabilities: { permissionModes: ["auto", "full"] },
          },
        ],
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          threadId === THREAD_ID
            ? thread
            : makeThreadResponse({
                id: threadId,
                status: "idle",
                visibility: "hidden",
                originPluginId: PLUGIN_ID,
              }),
        conversationOutline: async () => ({
          items: outline.map((item, index) => ({
            id: `msg_${index}`,
            role: item.role,
            preview: item.preview,
            attachmentSummary: null,
          })),
          maxSeq: outline.length * 2,
        }),
        defaultExecutionOptions: async () => ({
          model: "claude-opus-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "auto",
          source: "client/turn/start",
        }),
        spawn: async (args: unknown) => {
          record(args);
          return makeThreadResponse({ id: WORKER_ID, visibility: "hidden" });
        },
        wait: async () => ({
          event: {
            type: "turn/completed",
            data: { status: "completed", error: null },
          },
        }),
        output: async () => ({ output: options.answer ?? "Flaky login test" }),
        update: async (args: { threadId: string; title?: string | null }) => {
          updates.push(args);
          return thread;
        },
        stop: async () => thread,
        delete: async () => ({ ok: true }),
        archive: async () => thread,
      },
    },
  });

  return { ...host, updates, spawns };
}

async function load(host: ReturnType<typeof createHost>) {
  await plugin(host.sandy);
}

describe("naming a thread", () => {
  it("writes the cleaned answer onto the thread", async () => {
    const host = createHost({ answer: '"Flaky login test."' });
    await load(host);

    const result = (await host.harness.behavior.callRpc("rename", {
      threadId: THREAD_ID,
    })) as RenameResult;

    expect(result).toEqual({ ok: true, title: "Flaky login test" });
    expect(host.updates).toEqual([
      { threadId: THREAD_ID, title: "Flaky login test" },
    ]);
  });

  it("runs the naming turn on the named thread's own agent by default", async () => {
    const host = createHost({});
    await load(host);

    await host.harness.behavior.callRpc("rename", { threadId: THREAD_ID });

    expect(host.spawns).toHaveLength(1);
    expect(host.spawns[0]).toMatchObject({
      providerId: "claude",
      model: "claude-opus-5",
      reasoningLevel: "medium",
      visibility: "hidden",
      // The named thread's environment, so naming provisions no worktree.
      environment: { type: "reuse", environmentId: "env_1" },
      // Naming needs no tools, so the least privileged supported mode is used.
      permissionMode: "auto",
    });
  });

  it("runs on the picked agent once one is chosen", async () => {
    const host = createHost({});
    await load(host);

    await host.harness.behavior.callRpc("selectAgent", {
      selection: {
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "low",
      },
    });
    await host.harness.behavior.callRpc("rename", { threadId: THREAD_ID });

    expect(host.spawns[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "low",
    });
  });

  it("stops and deletes its worker thread", async () => {
    const host = createHost({});
    await load(host);

    await host.harness.behavior.callRpc("rename", { threadId: THREAD_ID });

    const calls = host.harness.inspection.sdk.calls.map((call) => call.path);
    expect(calls).toContain("threads.stop");
    expect(calls).toContain("threads.delete");
  });

  it("reports an empty answer instead of blanking the title", async () => {
    const host = createHost({ answer: "  \n " });
    await load(host);

    const result = (await host.harness.behavior.callRpc("rename", {
      threadId: THREAD_ID,
    })) as RenameResult;

    expect(result).toMatchObject({ ok: false });
    expect(host.updates).toEqual([]);
  });

  it("refuses a thread with nothing said in it yet", async () => {
    const host = createHost({ outline: [] });
    await load(host);

    const result = (await host.harness.behavior.callRpc("rename", {
      threadId: THREAD_ID,
    })) as RenameResult;

    expect(result).toMatchObject({ ok: false });
    expect(host.updates).toEqual([]);
  });

  it("renames a hand-named thread when asked directly", async () => {
    const host = createHost({ thread: { title: "My own name" } });
    await load(host);

    const result = (await host.harness.behavior.callRpc("rename", {
      threadId: THREAD_ID,
    })) as RenameResult;

    expect(result).toMatchObject({ ok: true });
  });

  it("still refuses a hidden thread when asked directly", async () => {
    const host = createHost({ thread: { visibility: "hidden" } });
    await load(host);

    const result = (await host.harness.behavior.callRpc("rename", {
      threadId: THREAD_ID,
    })) as RenameResult;

    expect(result).toMatchObject({ ok: false });
    expect(host.updates).toEqual([]);
  });
});

describe("naming on thread.idle", () => {
  it("names an untitled thread once its turn is over", async () => {
    const host = createHost({});
    await load(host);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await settle();

    expect(host.updates).toEqual([
      { threadId: THREAD_ID, title: "Flaky login test" },
    ]);
  });

  it("names a thread only once in the default mode", async () => {
    const host = createHost({});
    await load(host);
    const idle = () =>
      host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: THREAD_ID }),
        lastAssistantText: "done",
      });

    await idle();
    await settle();
    // The thread now carries the name this plugin wrote.
    host.updates.length = 0;
    const named = createHostWithTitle(host, "Flaky login test");
    await named();
    await idle();
    await settle();

    expect(host.updates).toEqual([]);
  });

  it("leaves the thread alone when automatic naming is off", async () => {
    const host = createHost({
      settings: { mode: "Never name threads automatically" },
    });
    await load(host);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: "done",
    });
    await settle();

    expect(host.updates).toEqual([]);
  });

  it("ignores its own hidden worker going idle", async () => {
    const host = createHost({});
    await load(host);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: WORKER_ID,
        visibility: "hidden",
        originPluginId: PLUGIN_ID,
      }),
      lastAssistantText: "Flaky login test",
    });
    await settle();

    expect(host.updates).toEqual([]);
  });
});

describe("the CLI command", () => {
  it("names the calling thread when no id is given", async () => {
    const host = createHost({});
    await load(host);

    const result = await host.harness.behavior.runCli(["rename"], {
      threadId: THREAD_ID,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Flaky login test");
  });

  it("asks for a thread id when it has none", async () => {
    const host = createHost({});
    await load(host);

    const result = await host.harness.behavior.runCli(["rename"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("thread id");
  });

  it("reports how naming is configured", async () => {
    const host = createHost({});
    await load(host);

    const result = await host.harness.behavior.runCli(["status"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Automatic naming:");
    expect(result.stdout).toContain("the thread's own agent");
  });

  it("rejects an unknown subcommand", async () => {
    const host = createHost({});
    await load(host);

    const result = await host.harness.behavior.runCli(["nope"]);

    expect(result.exitCode).toBe(2);
  });
});

/**
 * Re-point the fake `threads.get` at a thread that now carries the generated
 * title, the way the real thread row would after an update.
 */
function createHostWithTitle(
  host: ReturnType<typeof createHost>,
  title: string,
) {
  return async () => {
    host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({
        id: threadId as string,
        projectId: "proj_1",
        environmentId: "env_1",
        providerId: "claude",
        title,
      }),
    );
  };
}

/** Let the fire-and-forget event handler finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
