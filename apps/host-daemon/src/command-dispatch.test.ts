import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime } from "@sandy/agent-runtime";
import type {
  HostDaemonInjectedSkillSource,
  ProviderCliStatus,
} from "@sandy/host-daemon-contract";
import type { HostWorkspace } from "@sandy/host-workspace";
import { createDeferredPromise, makeTempDir } from "@sandy/test-helpers";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "./command-dispatch.js";
import {
  DISPATCH_TEST_BRIDGE_LAUNCH,
  dispatchTestRuntimeBridgeLaunch,
  makeDispatchOptions,
  silentLogger,
  fetchDispatchTestArtifact,
  unexpectedProviderMaintenance,
} from "../test/command/dispatch-helpers.js";
import type { CommandOf } from "./command-dispatch-support.js";
import { PROVIDER_INSTALLATION_GATE_TTL_MS } from "./provider-installation-gate.js";
import { RuntimeManager } from "./runtime-manager.js";
import { stageInjectedSkillSources } from "./injected-skills.js";

const WORKSPACE_PATH = "/tmp/sandy-command-dispatch-test";

interface WriteInjectedSkillSourceArgs {
  dataDir: string;
  token: string;
}

interface BusySkillCatalogFixture {
  createRuntimeSpy: Mock<() => AgentRuntime>;
  dataDir: string;
  manager: RuntimeManager;
  originalCatalogHash: string | null;
  runtime: FakeDispatchRuntime;
  source: HostDaemonInjectedSkillSource;
}

async function writeInjectedSkillSource(
  args: WriteInjectedSkillSourceArgs,
): Promise<HostDaemonInjectedSkillSource> {
  const sourceRootPath = path.join(args.dataDir, "skills", "release-notes");
  await fs.mkdir(sourceRootPath, { recursive: true });
  await fs.writeFile(
    path.join(sourceRootPath, "SKILL.md"),
    [
      "---",
      "name: release-notes",
      "description: Use release-notes when command dispatch tests run.",
      "---",
      "",
      args.token,
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    kind: "host-path",
    sourceType: "shared-user",
    name: "release-notes",
    description: "Use release-notes when command dispatch tests run.",
    sourceRootPath,
    skillFilePath: path.join(sourceRootPath, "SKILL.md"),
  };
}

async function setupBusySkillCatalogEnvironment(args: {
  activeThreadId: string;
}): Promise<BusySkillCatalogFixture> {
  const dataDir = await makeTempDir("sandy-command-dispatch-skills-");
  const source = await writeInjectedSkillSource({
    dataDir,
    token: "first-token",
  });
  const runtime = createRuntime();
  const createRuntimeSpy = vi.fn(() => runtime);
  const manager = new RuntimeManager({
    dataDir,
    createRuntime: createRuntimeSpy,
    provisionWorkspace: async () => createWorkspace(),
  });
  const entry = await manager.ensureEnvironment({
    environmentId: "env-1",
    injectedSkillSources: [source],
    workspacePath: WORKSPACE_PATH,
  });
  runtime.setActiveTurn(args.activeThreadId, "turn-busy-1");
  await writeInjectedSkillSource({ dataDir, token: "second-token" });
  return {
    createRuntimeSpy,
    dataDir,
    manager,
    originalCatalogHash: entry.skillCatalogHash,
    runtime,
    source,
  };
}

async function unexpectedWorkspaceCall(): Promise<never> {
  throw new Error("Unexpected workspace call");
}

function createWorkspace(workspacePath = WORKSPACE_PATH): HostWorkspace {
  return {
    path: workspacePath,
    isGitRepo: false,
    isWorktree: false,
    getDefaultBranch: unexpectedWorkspaceCall,
    getCurrentBranch: unexpectedWorkspaceCall,
    getHeadSha: unexpectedWorkspaceCall,
    getLocalStateSnapshot: unexpectedWorkspaceCall,
    getSharedGitRefsSnapshot: unexpectedWorkspaceCall,
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    commit: unexpectedWorkspaceCall,
  };
}

interface FakeDispatchRuntime extends AgentRuntime {
  setActiveTurn: (threadId: string, turnId: string) => void;
  setIdle: (threadId: string) => void;
}

function createRuntime(): FakeDispatchRuntime {
  const activeTurnsByThreadId = new Map<string, string>();
  const hostedThreadIds = new Set<string>();
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async (args: { threadId: string }) => {
      hostedThreadIds.add(args.threadId);
      return { providerThreadId: "provider-thread-1" };
    }),
    prepareThreadRewind: vi.fn(async () => ({
      providerThreadId: "provider-thread-rewind-1",
    })),
    discardThreadRewind: vi.fn(async () => undefined),
    resumeThread: vi.fn(async (args: { threadId: string }) => {
      hostedThreadIds.add(args.threadId);
      return { providerThreadId: "provider-thread-1" };
    }),
    runTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => ({ status: "steered" as const })),
    stopThread: vi.fn(async (args: { threadId: string }) => {
      activeTurnsByThreadId.delete(args.threadId);
      hostedThreadIds.delete(args.threadId);
      return { providerCheckpointId: null };
    }),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => ({
      models: [],
      selectedOnlyModels: [],
    })),
    listCommands: vi.fn(async () => ({ commands: [] })),
    providerHealth: vi.fn(async () => ({ supported: false as const })),
    providerUsage: vi.fn(async () => ({ supported: false as const })),
    providerInstallationStatus: vi.fn(async () => {
      throw new Error("Unexpected provider installation status call");
    }),
    listRunningProviders: vi.fn(() => ["fake"]),
    getActiveTurnId: (threadId) => activeTurnsByThreadId.get(threadId) ?? null,
    waitForActiveTurn: vi.fn(
      async (threadId: string) => activeTurnsByThreadId.get(threadId) ?? null,
    ),
    getProviderSession: (threadId) =>
      hostedThreadIds.has(threadId)
        ? { providerId: "fake", providerThreadId: "provider-thread-1" }
        : null,
    reapIdleProviderSessions: vi.fn(async () => ({ reapedSessions: [] })),
    hasThread: (threadId) => hostedThreadIds.has(threadId),
    getLiveThreadIds: vi.fn(() => [...activeTurnsByThreadId.keys()]),
    hasOpenBackgroundWork: () => false,
    shutdown: vi.fn(async () => undefined),
    setActiveTurn: (threadId, turnId) => {
      hostedThreadIds.add(threadId);
      activeTurnsByThreadId.set(threadId, turnId);
    },
    setIdle: (threadId: string) => {
      hostedThreadIds.add(threadId);
      activeTurnsByThreadId.delete(threadId);
    },
  };
}

function createTurnSubmitCommand(
  target: CommandOf<"turn.submit">["target"],
): CommandOf<"turn.submit"> {
  return {
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    type: "turn.submit",
    environmentId: "env-1",
    threadId: "thread-1",
    requestId: "creq_turn_submit",
    input: [{ type: "text", text: "follow up", mentions: [] }],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    resumeContext: {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
      },
      projectId: "proj_1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    },
    target,
  };
}

function supportedCodexInstallationStatus(): ProviderCliStatus {
  return {
    displayName: "Codex",
    executableName: "codex",
    executablePath: "/usr/local/bin/codex",
    installed: true,
    currentVersion: "0.146.0",
    minimumSupportedVersion: "0.136.0",
    versionUnsupported: false,
  };
}

function createInstallationGatedThreadStart(
  threadId: string,
  environmentId = "env-1",
): CommandOf<"thread.start"> {
  return {
    bridgeLaunch: {
      ...DISPATCH_TEST_BRIDGE_LAUNCH,
      capabilities: {
        ...DISPATCH_TEST_BRIDGE_LAUNCH.capabilities,
        providerInstallation: true,
      },
    },
    type: "thread.start",
    environmentId,
    threadId,
    workspaceContext: {
      workspacePath: WORKSPACE_PATH,
    },
    projectId: "proj_1",
    providerId: "codex",
    requestId: `creq_${threadId}`,
    input: [{ type: "text", text: "hello", mentions: [] }],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    instructions: "Be concise.",
    dynamicTools: [],
    contributedEnv: [],
    injectedSkillSources: [],
    instructionMode: "append",
  };
}

describe("dispatchCommand", () => {
  it("probes projectless commands in a stable empty directory and preserves selected workspaces", async () => {
    const dataDir = await makeTempDir("sandy-command-catalog-");
    const workspace = path.join(dataDir, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "project-file"), "project");
    const directories: string[] = [];
    const options = makeDispatchOptions({
      dataDir,
      runtimeManager: new RuntimeManager({
        createRuntime,
        provisionWorkspace: async () => createWorkspace(),
      }),
      listCommands: async ({ cwd }) => {
        directories.push(cwd);
        const files = await fs.readdir(cwd);
        return { commands: files.map((name) => ({ name, description: "" })) };
      },
    });
    for (const cwd of [null, null, workspace]) {
      const result = await dispatchOnlineRpcCommand(
        {
          type: "provider.list_commands",
          providerId: "pi",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
          cwd,
        },
        options,
        new AbortController().signal,
      );
      expect(result).toEqual({
        commands:
          cwd === null ? [] : [{ name: "project-file", description: "" }],
      });
    }
    expect(directories[0]).toBe(directories[1]);
    expect(directories[2]).toBe(workspace);
  });

  it("steers an auto submit when the active turn appears after the server snapshot", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");
    vi.mocked(runtime.getLiveThreadIds).mockReturnValueOnce(["thread-1"]);
    vi.mocked(runtime.waitForActiveTurn).mockImplementationOnce(
      async (threadId) => {
        runtime.setActiveTurn(threadId, "turn-starting");
        return "turn-starting";
      },
    );

    const result = await dispatchCommand(
      createTurnSubmitCommand({ mode: "auto", expectedTurnId: null }),
      {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      },
    );

    expect(result).toEqual({ trace: { spans: [] } });
    expect(runtime.waitForActiveTurn).toHaveBeenCalledWith("thread-1", {
      timeoutMs: 5_000,
    });
    expect(runtime.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "creq_turn_submit",
        expectedTurnId: "turn-starting",
        threadId: "thread-1",
      }),
    );
    expect(runtime.runTurn).not.toHaveBeenCalled();
  });

  it("rebases auto input onto the daemon's newer active turn", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-new");

    const result = await dispatchCommand(
      createTurnSubmitCommand({
        mode: "auto",
        expectedTurnId: "turn-old",
      }),
      {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      },
    );

    expect(result).toEqual({ trace: { spans: [] } });
    expect(runtime.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTurnId: "turn-new" }),
    );
    expect(runtime.runTurn).not.toHaveBeenCalled();
  });

  it("starts auto input immediately when the prior turn already completed", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");

    const result = await dispatchCommand(
      createTurnSubmitCommand({ mode: "auto", expectedTurnId: null }),
      {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      },
    );

    expect(result).toEqual({ trace: { spans: [] } });
    expect(runtime.waitForActiveTurn).not.toHaveBeenCalled();
    expect(runtime.runTurn).toHaveBeenCalledOnce();
  });

  it("rejects auto input when a pending turn still has no id after the wait", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");
    vi.mocked(runtime.getLiveThreadIds).mockReturnValue(["thread-1"]);
    vi.mocked(runtime.waitForActiveTurn).mockResolvedValueOnce(null);

    await expect(
      dispatchCommand(
        createTurnSubmitCommand({ mode: "auto", expectedTurnId: null }),
        {
          dataDir: "/tmp/sandy-data",
          logger: silentLogger,
          eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          ...unexpectedProviderMaintenance,
          runtimeManager: manager,
          threadStorageRootPath: "/tmp/sandy-thread-storage",
        },
      ),
    ).rejects.toThrow(
      "Refusing to start a competing turn while thread-1 is still starting",
    );
    expect(runtime.runTurn).not.toHaveBeenCalled();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
  });

  it("flushes buffered events before reporting thread.stop success", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/sandy-command-dispatch-test",
    });
    runtime.setActiveTurn("thread-1", "turn-1");

    const flushDeferred = createDeferredPromise<void>();
    const flush = vi.fn(async () => flushDeferred.promise);
    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      intent: "interrupt",
      environmentId: "env-1",
      threadId: "thread-1",
    };
    let resolved = false;
    const dispatchPromise = dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush,
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    }).then((result) => {
      resolved = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(flush).toHaveBeenCalledTimes(1);
    });
    expect(resolved).toBe(false);

    flushDeferred.resolve(undefined);
    await expect(dispatchPromise).resolves.toEqual({
      providerCheckpointId: null,
    });

    expect(resolved).toBe(true);
    expect(runtime.hasThread("thread-1")).toBe(false);
  });

  it("cancels Plan through the active provider runtime before flushing events", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-1");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
      },
      {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: true });
    expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("does not cancel Plan after its turn has already ended", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-plan-1",
      },
      {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: false });
    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not cancel a newer turn when the Plan cancellation is stale", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-newer-2");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-plan-1",
      },
      {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: false });
    expect(runtime.getActiveTurnId("thread-1")).toBe("turn-newer-2");
    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("resumes a reaped Codex runtime before clearing its Goal", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const flush = vi.fn(async () => undefined);
    const command: CommandOf<"thread.goal.clear"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.goal.clear",
      environmentId: "env-1",
      threadId: "thread-1",
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: WORKSPACE_PATH,
        },
        projectId: "proj-1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({ cleared: true });
    expect(runtime.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        threadId: "thread-1",
      }),
    );
    expect(runtime.clearThreadGoal).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("releases a moved thread from its old environment before resuming it", async () => {
    const oldRuntime = createRuntime();
    const newRuntime = createRuntime();
    const createRuntimeSpy = vi
      .fn<() => AgentRuntime>()
      .mockReturnValueOnce(oldRuntime)
      .mockReturnValueOnce(newRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      provisionWorkspace: async (args) => createWorkspace(args.path),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/sandy-command-dispatch-old",
    });
    oldRuntime.setIdle("thread-1");

    const command: CommandOf<"turn.submit"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "turn.submit",
      environmentId: "env-new",
      threadId: "thread-1",
      requestId: "creq_moved_thread",
      input: [{ type: "text", text: "follow up", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: "/tmp/sandy-command-dispatch-new",
        },
        projectId: "proj_1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
      target: { mode: "start" },
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({ trace: { spans: [] } });
    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspacePath: "/tmp/sandy-command-dispatch-new",
      }),
    );
    expect(newRuntime.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        providerThreadId: "provider-thread-1",
        threadId: "thread-1",
      }),
    );
    expect(newRuntime.runTurn).toHaveBeenCalledOnce();
    expect(
      (oldRuntime.stopThread as unknown as Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (newRuntime.resumeThread as unknown as Mock).mock.invocationCallOrder[0],
    );
  });

  it("stops the old owner when the moved thread has no runtime yet", async () => {
    const oldRuntime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => oldRuntime,
      provisionWorkspace: async () => createWorkspace("/tmp/sandy-stop-old"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/sandy-stop-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");
    (oldRuntime.stopThread as Mock).mockResolvedValueOnce({
      providerCheckpointId: "pi-entry-at-stop",
    });

    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      intent: "interrupt",
      environmentId: "env-new",
      threadId: "thread-1",
    };
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({ providerCheckpointId: "pi-entry-at-stop" });
    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("releases an idle runtime without the active-turn wait", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace("/tmp/sandy-release"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-release",
      workspacePath: "/tmp/sandy-release",
    });
    runtime.setIdle("thread-1");

    const options = {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    };

    await dispatchCommand(
      {
        type: "thread.stop",
        intent: "release",
        environmentId: "env-release",
        threadId: "thread-1",
      },
      options,
    );
    expect(runtime.waitForActiveTurn).not.toHaveBeenCalled();
    expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });

    runtime.setIdle("thread-1");
    await dispatchCommand(
      {
        type: "thread.stop",
        intent: "interrupt",
        environmentId: "env-release",
        threadId: "thread-1",
      },
      options,
    );
    expect(runtime.waitForActiveTurn).toHaveBeenCalledWith("thread-1", {
      timeoutMs: expect.any(Number),
    });
  });

  it("reports a retained turn instead of releasing a turn that started after the server read the thread", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace("/tmp/sandy-release-race"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-release-race",
      workspacePath: "/tmp/sandy-release-race",
    });
    runtime.setActiveTurn("thread-1", "turn-new");
    const options = {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    };

    const result = await dispatchCommand(
      {
        type: "thread.stop",
        intent: "release",
        environmentId: "env-release-race",
        threadId: "thread-1",
      },
      options,
    );

    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(runtime.getActiveTurnId("thread-1")).toBe("turn-new");
    expect(result).toEqual({
      providerCheckpointId: null,
      activeTurnRetained: true,
    });

    const interrupted = await dispatchCommand(
      {
        type: "thread.stop",
        intent: "interrupt",
        environmentId: "env-release-race",
        threadId: "thread-1",
      },
      options,
    );

    expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(runtime.getActiveTurnId("thread-1")).toBeNull();
    expect(interrupted).toEqual({ providerCheckpointId: null });
  });

  it("treats thread.stop as successful when no runtime holds the thread", async () => {
    const manager = new RuntimeManager({
      createRuntime: () => createRuntime(),
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      intent: "interrupt",
      environmentId: "env-missing-runtime",
      threadId: "thread-1",
    };

    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      }),
    ).resolves.toEqual({ providerCheckpointId: null });
  });

  it("cancels a plan in the environment the thread moved away from", async () => {
    const oldRuntime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => oldRuntime,
      provisionWorkspace: async () => createWorkspace("/tmp/sandy-plan-old"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/sandy-plan-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const command: CommandOf<"thread.plan.cancel"> = {
      type: "thread.plan.cancel",
      environmentId: "env-new",
      threadId: "thread-1",
      expectedTurnId: "turn-old",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({ cancelled: true });
    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
  });

  it("leaves a plan alone when no runtime runs the expected turn", async () => {
    const oldRuntime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => oldRuntime,
      provisionWorkspace: async () => createWorkspace("/tmp/sandy-plan-old"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/sandy-plan-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-other");

    const command: CommandOf<"thread.plan.cancel"> = {
      type: "thread.plan.cancel",
      environmentId: "env-new",
      threadId: "thread-1",
      expectedTurnId: "turn-old",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({ cancelled: false });
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
  });

  it("keeps an old-environment turn alive through a rename", async () => {
    const oldRuntime = createRuntime();
    const newRuntime = createRuntime();
    const createRuntimeSpy = vi
      .fn<() => AgentRuntime>()
      .mockReturnValueOnce(oldRuntime)
      .mockReturnValueOnce(newRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      provisionWorkspace: async (args) => createWorkspace(args.path),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/sandy-rename-old",
    });
    await manager.ensureEnvironment({
      environmentId: "env-new",
      workspacePath: "/tmp/sandy-rename-new",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const command: CommandOf<"thread.rename"> = {
      type: "thread.rename",
      environmentId: "env-new",
      threadId: "thread-1",
      title: "Renamed",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({});
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
    expect(oldRuntime.getActiveTurnId("thread-1")).toBe("turn-old");
    expect(newRuntime.renameThread).toHaveBeenCalledWith({
      threadId: "thread-1",
      title: "Renamed",
    });
  });

  it("refuses a goal clear while the old environment still runs the turn", async () => {
    const oldRuntime = createRuntime();
    const newRuntime = createRuntime();
    const createRuntimeSpy = vi
      .fn<() => AgentRuntime>()
      .mockReturnValueOnce(oldRuntime)
      .mockReturnValueOnce(newRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      provisionWorkspace: async (args) => createWorkspace(args.path),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/sandy-goal-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const command: CommandOf<"thread.goal.clear"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.goal.clear",
      environmentId: "env-new",
      threadId: "thread-1",
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: "/tmp/sandy-goal-new",
        },
        projectId: "proj_1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
    };

    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      }),
    ).rejects.toMatchObject({ code: "thread_busy_in_other_environment" });
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
    expect(newRuntime.clearThreadGoal).not.toHaveBeenCalled();
  });

  it("treats thread.rename as best-effort when the runtime is not loaded", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.rename"> = {
      type: "thread.rename",
      environmentId: "env-missing-runtime",
      threadId: "thread-1",
      title: "Renamed",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({});
    expect(runtime.renameThread).not.toHaveBeenCalled();
  });

  it("blocks any installation-managed provider whose bridge reports an unsupported version", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.start"> = {
      bridgeLaunch: {
        ...DISPATCH_TEST_BRIDGE_LAUNCH,
        capabilities: {
          ...DISPATCH_TEST_BRIDGE_LAUNCH.capabilities,
          providerInstallation: true,
        },
      },
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
      },
      projectId: "proj_1",
      providerId: "example-agent",
      requestId: "creq_unsupported_provider",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };

    const unsupportedCodexStatus: ProviderCliStatus = {
      displayName: "Example Agent",
      executableName: "example-agent",
      executablePath: "/usr/local/bin/example-agent",
      installed: true,
      currentVersion: "0.135.0",
      minimumSupportedVersion: "0.136.0",
      versionUnsupported: true,
    };

    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: {
          emit: vi.fn(),
          flush: vi.fn(async () => undefined),
        },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        providerInstallationStatus: async () => unsupportedCodexStatus,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      }),
    ).rejects.toMatchObject({
      code: "provider_cli_unsupported_version",
    });

    expect(runtime.startThread).not.toHaveBeenCalled();
  });

  it("skips version checks when the provider declaration does not support installation", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.start"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
      },
      projectId: "proj_1",
      providerId: "codex",
      requestId: "creq_unmanaged_provider",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "claude-sonnet-4-6",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };
    const providerInstallationStatus = vi.fn(async () => {
      throw new Error("Provider installation status should not be checked");
    });

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/sandy-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      providerInstallationStatus,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({ providerThreadId: "provider-thread-1" });
    expect(providerInstallationStatus).not.toHaveBeenCalled();
    expect(runtime.startThread).toHaveBeenCalledOnce();
  });

  it("prepares a Codex rewind through the requested retained turn", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.rewind.prepare"> = {
      bridgeLaunch: {
        ...DISPATCH_TEST_BRIDGE_LAUNCH,
        capabilities: {
          ...DISPATCH_TEST_BRIDGE_LAUNCH.capabilities,
          providerInstallation: true,
        },
      },
      type: "thread.rewind.prepare",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
      },
      projectId: "proj_1",
      providerId: "codex",
      leaseId: "lease-1",
      sourceProviderThreadId: "provider-source-1",
      retainThroughProviderCheckpoint: "turn-before-edit",
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };
    const supportedCodexStatus: ProviderCliStatus = {
      displayName: "Codex",
      executableName: "codex",
      executablePath: "/usr/local/bin/codex",
      installed: true,
      currentVersion: "0.146.0",
      minimumSupportedVersion: "0.136.0",
      versionUnsupported: false,
    };

    const providerInstallationStatus = vi.fn(async () => supportedCodexStatus);
    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/sandy-data",
        logger: silentLogger,
        eventSink: {
          emit: vi.fn(),
          flush: vi.fn(async () => undefined),
        },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        providerInstallationStatus,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/sandy-thread-storage",
      }),
    ).resolves.toEqual({ providerThreadId: "provider-thread-rewind-1" });
    expect(providerInstallationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ requirement: "thread_rewind" }),
    );
    expect(runtime.prepareThreadRewind).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: "lease-1",
        sourceProviderThreadId: "provider-source-1",
        retainThroughProviderCheckpoint: "turn-before-edit",
        threadId: "thread-1",
      }),
    );
    await manager.invalidateProviderMaintenanceRuntime();
    await expect(
      dispatchCommand(
        { ...command, leaseId: "lease-old-codex" },
        {
          dataDir: "/tmp/sandy-data",
          logger: silentLogger,
          eventSink: {
            emit: vi.fn(),
            flush: vi.fn(async () => undefined),
          },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          fetchPluginHostArtifact: fetchDispatchTestArtifact,
          ...unexpectedProviderMaintenance,
          providerInstallationStatus: async () => ({
            ...supportedCodexStatus,
            currentVersion: "0.140.0",
            minimumSupportedVersion: "0.143.0",
            versionUnsupported: true,
          }),
          runtimeManager: manager,
          threadStorageRootPath: "/tmp/sandy-thread-storage",
        },
      ),
    ).rejects.toMatchObject({ code: "provider_cli_unsupported_version" });
    expect(runtime.prepareThreadRewind).toHaveBeenCalledOnce();

    await expect(
      dispatchCommand(
        {
          type: "thread.rewind.discard",
          environmentId: "env-1",
          threadId: "thread-1",
          leaseId: "lease-1",
        },
        {
          dataDir: "/tmp/sandy-data",
          logger: silentLogger,
          eventSink: {
            emit: vi.fn(),
            flush: vi.fn(async () => undefined),
          },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          fetchPluginHostArtifact: fetchDispatchTestArtifact,
          ...unexpectedProviderMaintenance,
          runtimeManager: manager,
          threadStorageRootPath: "/tmp/sandy-thread-storage",
        },
      ),
    ).resolves.toEqual({});
    expect(runtime.discardThreadRewind).toHaveBeenCalledWith({
      leaseId: "lease-1",
    });
  });

  it("reuses a supported installation probe across thread starts", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi.fn(async () =>
      supportedCodexInstallationStatus(),
    );
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });
    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-2"), options),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });

    expect(providerInstallationStatus).toHaveBeenCalledOnce();
    expect(runtime.startThread).toHaveBeenCalledTimes(2);
  });

  it("retries concurrent thread starts when a shell env refresh interrupts their shared probe", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
      shellEnv: { PATH: "/old/bin" },
    });
    const staleProbe = createDeferredPromise<ProviderCliStatus>();
    const providerInstallationStatus = vi
      .fn<() => Promise<ProviderCliStatus>>()
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValueOnce(supportedCodexInstallationStatus());
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    const starts = Promise.all([
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
      dispatchCommand(createInstallationGatedThreadStart("thread-2"), options),
    ]);
    await vi.waitFor(() =>
      expect(providerInstallationStatus).toHaveBeenCalledOnce(),
    );

    await manager.replaceBaseShellEnv({ PATH: "/new/bin" });
    staleProbe.reject(new Error("Runtime shutting down"));

    await expect(starts).resolves.toEqual([
      { providerThreadId: "provider-thread-1" },
      { providerThreadId: "provider-thread-1" },
    ]);
    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(runtime.startThread).toHaveBeenCalledTimes(2);
  });

  it("keys the rewind requirement separately from thread start", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi.fn(async () =>
      supportedCodexInstallationStatus(),
    );
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });
    const start = createInstallationGatedThreadStart("thread-1");
    const rewind: CommandOf<"thread.rewind.prepare"> = {
      bridgeLaunch: start.bridgeLaunch,
      type: "thread.rewind.prepare",
      environmentId: start.environmentId,
      threadId: start.threadId,
      workspaceContext: start.workspaceContext,
      projectId: start.projectId,
      providerId: start.providerId,
      leaseId: "lease-1",
      sourceProviderThreadId: "provider-source-1",
      retainThroughProviderCheckpoint: "turn-before-edit",
      options: start.options,
      instructions: start.instructions,
      dynamicTools: start.dynamicTools,
      contributedEnv: [],
      injectedSkillSources: start.injectedSkillSources,
      instructionMode: start.instructionMode,
    };

    await dispatchCommand(start, options);
    await expect(dispatchCommand(rewind, options)).resolves.toEqual({
      providerThreadId: "provider-thread-rewind-1",
    });

    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(providerInstallationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ requirement: "thread_rewind" }),
    );
  });

  it("re-probes and launches with the new PATH when the shell env refresh finds a change", async () => {
    const oldPath = "/usr/bin:/bin";
    const newPath = "/home/u/.local/bin:/usr/bin:/bin";
    const runtime = createRuntime();
    const createdRuntimeShellPaths: (string | undefined)[] = [];
    const manager = new RuntimeManager({
      createRuntime: (runtimeOptions) => {
        createdRuntimeShellPaths.push(runtimeOptions.shellEnv?.PATH);
        return runtime;
      },
      provisionWorkspace: async () => createWorkspace(),
      shellEnv: { PATH: oldPath },
    });
    let loginShellPath = oldPath;
    const refreshShellEnv = vi.fn(async () => {
      await manager.replaceBaseShellEnv({ PATH: loginShellPath });
    });
    const providerInstallationStatus = vi.fn(async () =>
      supportedCodexInstallationStatus(),
    );
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
      refreshShellEnv,
    });

    await dispatchCommand(
      createInstallationGatedThreadStart("thread-1"),
      options,
    );
    await dispatchCommand(
      createInstallationGatedThreadStart("thread-2"),
      options,
    );
    expect(providerInstallationStatus).toHaveBeenCalledOnce();

    loginShellPath = newPath;
    await dispatchCommand(
      createInstallationGatedThreadStart("thread-3", "env-2"),
      options,
    );

    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(manager.getShellEnv().PATH).toBe(newPath);
    expect(createdRuntimeShellPaths).toEqual([oldPath, newPath]);
    expect(refreshShellEnv).toHaveBeenCalledTimes(3);
  });

  it("remembers the first probe after a shell env change", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
      shellEnv: { PATH: "/old/bin" },
    });
    const refreshShellEnv = async () => {
      await manager.replaceBaseShellEnv({ PATH: "/new/bin" });
    };
    const providerInstallationStatus = vi.fn(async () => {
      await refreshShellEnv();
      return supportedCodexInstallationStatus();
    });
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
      refreshShellEnv,
    });

    await dispatchCommand(
      createInstallationGatedThreadStart("thread-1"),
      options,
    );
    await dispatchCommand(
      createInstallationGatedThreadStart("thread-2"),
      options,
    );

    expect(manager.getShellEnv().PATH).toBe("/new/bin");
    expect(providerInstallationStatus).toHaveBeenCalledOnce();
  });

  it("does not remember a not-installed provider that enforces a minimum version", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi
      .fn<() => Promise<ProviderCliStatus>>()
      .mockResolvedValueOnce({
        ...supportedCodexInstallationStatus(),
        installed: false,
        executablePath: null,
        currentVersion: null,
      })
      .mockResolvedValueOnce({
        ...supportedCodexInstallationStatus(),
        currentVersion: "0.135.0",
        versionUnsupported: true,
      });
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });
    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-2"), options),
    ).rejects.toMatchObject({ code: "provider_cli_unsupported_version" });

    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(runtime.startThread).toHaveBeenCalledOnce();
  });

  it("expires the remembered probe after the gate TTL", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const runtime = createRuntime();
      const manager = new RuntimeManager({
        createRuntime: () => runtime,
        provisionWorkspace: async () => createWorkspace(),
      });
      const providerInstallationStatus = vi.fn(async () =>
        supportedCodexInstallationStatus(),
      );
      const options = makeDispatchOptions({
        runtimeManager: manager,
        providerInstallationStatus,
      });

      await dispatchCommand(
        createInstallationGatedThreadStart("thread-1"),
        options,
      );
      now.mockReturnValue(PROVIDER_INSTALLATION_GATE_TTL_MS - 1);
      await dispatchCommand(
        createInstallationGatedThreadStart("thread-2"),
        options,
      );
      expect(providerInstallationStatus).toHaveBeenCalledOnce();

      now.mockReturnValue(PROVIDER_INSTALLATION_GATE_TTL_MS);
      await dispatchCommand(
        createInstallationGatedThreadStart("thread-3"),
        options,
      );
      await vi.waitFor(() => {
        expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
      });
    } finally {
      now.mockRestore();
    }
  });

  it("injects the current skill snapshot when spawning beside an active sibling", async () => {
    const fixture = await setupBusySkillCatalogEnvironment({
      activeThreadId: "sibling-thread",
    });
    const command: CommandOf<"thread.start"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
      },
      projectId: "proj_1",
      providerId: "codex",
      requestId: "creq_2345678923",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [fixture.source],
      instructionMode: "append",
    };

    const result = await dispatchCommand(command, {
      dataDir: fixture.dataDir,
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      providerInstallationStatus: async () =>
        supportedCodexInstallationStatus(),
      runtimeManager: fixture.manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result.providerThreadId).toBe("provider-thread-1");
    expect(fixture.runtime.startThread).toHaveBeenCalledTimes(1);
    const currentCatalog = await stageInjectedSkillSources({
      workspacePath: fixture.dataDir,
      dataDir: fixture.dataDir,
      injectedSkillSources: [fixture.source],
    });
    expect(currentCatalog.catalogHash).not.toBe(fixture.originalCatalogHash);
    await expect(
      fs.readFile(
        path.join(
          currentCatalog.skillRoots[0]!.path,
          "release-notes",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("second-token");
    expect(fixture.runtime.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ skillRoots: currentCatalog.skillRoots }),
    );
    expect(fixture.createRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.shutdown).not.toHaveBeenCalled();
    expect(fixture.manager.get("env-1")?.skillCatalogHash).toBe(
      fixture.originalCatalogHash,
    );
  });

  it("reuses a busy runtime when turn.submit carries a changed skill catalog", async () => {
    const fixture = await setupBusySkillCatalogEnvironment({
      activeThreadId: "thread-1",
    });
    const command: CommandOf<"turn.submit"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "turn.submit",
      environmentId: "env-1",
      threadId: "thread-1",
      requestId: "creq_2345678923",
      input: [{ type: "text", text: "follow up", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: WORKSPACE_PATH,
        },
        projectId: "proj_1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [fixture.source],
        instructionMode: "append",
      },
      target: { mode: "start" },
    };

    const result = await dispatchCommand(command, {
      dataDir: fixture.dataDir,
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: fixture.manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    });

    expect(result).toEqual({ trace: { spans: [] } });
    expect(fixture.runtime.runTurn).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.resumeThread).not.toHaveBeenCalled();
    expect(fixture.createRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.shutdown).not.toHaveBeenCalled();
    expect(fixture.manager.get("env-1")?.skillCatalogHash).toBe(
      fixture.originalCatalogHash,
    );
  });

  it("routes provider health and usage to the targeted bridge runtime", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerHealth = vi.fn(async () => ({ supported: false as const }));
    const providerUsage = vi.fn(async () => ({ supported: false as const }));
    const options = {
      dataDir: "/tmp/sandy-test-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      providerHealth,
      providerUsage,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/sandy-thread-storage",
    };

    await expect(
      dispatchOnlineRpcCommand(
        {
          type: "provider.health",
          providerId: "pi",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
          cwd: "/tmp/workspace",
        },
        options,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ supported: false });
    await expect(
      dispatchOnlineRpcCommand(
        {
          type: "provider.usage",
          providerId: "pi",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        },
        options,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ supported: false });

    expect(providerHealth).toHaveBeenCalledWith({
      providerId: "pi",
      cwd: "/tmp/workspace",
      bridgeLaunch: dispatchTestRuntimeBridgeLaunch(options.dataDir),
    });
    expect(providerUsage).toHaveBeenCalledWith({
      providerId: "pi",
      bridgeLaunch: dispatchTestRuntimeBridgeLaunch(options.dataDir),
    });
  });
});
