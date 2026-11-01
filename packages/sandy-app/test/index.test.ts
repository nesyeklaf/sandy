import { execHostFile, nodeNetworkArgs } from "@sandy/process-utils";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { waitForProcessExit } from "@sandy/config/child-process-exit";
import { resolvePortFromEnv } from "@sandy/config/runtime";
import {
  assertSandyAppArtifacts,
  assertSandyHostArtifacts,
  completeFullStackSupervision,
  createDaemonEnv,
  createHostEnrollKeyRequestBody,
  createServerEnv,
  createHostDaemonJoinEnv,
  parseLauncherArgs,
  readSandyAppPackageVersion,
  resolveSandyAppRuntimeState,
  resolveDataDir,
  resolveSandyAppStartContext,
  resolveSandyAppCommand,
  resolveServerListenerUrl,
  resolveBundledCliLaunch,
  resolveWorktreeRuntimePolicy,
  runSandyApp,
  runBundledCliCommand,
  superviseFullStackProcesses,
  terminateManagedFullStackProcesses,
  waitForHostDaemonStatus,
} from "../src/launcher.js";
import type {
  SandyAppStartContext,
  DelayMillisecondsArgs,
  DelayMillisecondsFn,
  FullStackSupervisionResult,
  ManagedFullStackProcesses,
  ManagedProcessName,
  ManagedProcessRun,
  NamedProcessExitResult,
  ProcessExitResult,
  ReadServerMovedFileFn,
} from "../src/launcher.js";

interface DelayArgs {
  ms: number;
}

interface ControlledDelayCall {
  ms: number;
  resolve(): void;
}

interface ConfigReloadTestServer {
  close(): Promise<void>;
  port: number;
  reloadCount(): number;
  reloadRequests(): ConfigReloadRequest[];
  url: string;
}

interface HostListTestServer {
  close(): Promise<void>;
  requests(): string[];
  url: string;
}

interface ConfigReloadRequest {
  host: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

interface InvalidConfigCommandCase {
  expectedError: RegExp;
  key: string;
  value: string;
}

interface StartupOnlyManagedEnvCase {
  key: string;
  value: string;
}

type DelayResult = "timeout";
type ResolveFakeManagedProcessExit = (result: NamedProcessExitResult) => void;
type StartFakeManagedProcess = () => Promise<ManagedProcessRun>;

interface FakeManagedProcessRunArgs {
  id: string;
  processName: ManagedProcessName;
}

interface WaitForProcessReplacementArgs {
  currentRun: () => ManagedProcessRun | null;
  previousRun: ManagedProcessRun;
}

interface WaitForDelayCallArgs {
  delay: ControlledDelay;
  index: number;
}

interface FakeSupervisor {
  daemonRuns: FakeManagedProcessRun[];
  daemonStart: StartFakeManagedProcess;
  processes: ManagedFullStackProcesses;
  serverRuns: FakeManagedProcessRun[];
  serverStart: StartFakeManagedProcess;
  setShutdownRequested(value: boolean): void;
  shutdownRequested(): boolean;
}

const invalidConfigCommandCases: InvalidConfigCommandCase[] = [
  ...["SANDY_INFERENCE", "SANDY_INFERENCE_FALLBACK", "SANDY_TRANSCRIPTION"].map(
    (key) => ({
      expectedError: /were removed\. Choose AI services in Settings/u,
      key,
      value: "codex/gpt-5.6-luna",
    }),
  ),
  {
    expectedError: /SANDY_APP_URL must be a valid URL/u,
    key: "SANDY_APP_URL",
    value: "not-a-url",
  },
  {
    expectedError: /SANDY_SERVER_URL must be a valid URL/u,
    key: "SANDY_SERVER_URL",
    value: "not-a-url",
  },
  {
    expectedError: /SANDY_LOG_LEVEL must be one of/u,
    key: "SANDY_LOG_LEVEL",
    value: "bogus",
  },
];

const startupOnlyManagedEnvCases: StartupOnlyManagedEnvCase[] = [
  { key: "SANDY_APP_SURFACE", value: "desktop" },
  { key: "SANDY_APP_URL", value: "https://app.example.test" },
  { key: "SANDY_DATA_DIR", value: "/tmp/sandy-managed-data" },
  { key: "SANDY_DEV_APP_PORT", value: "4173" },
  { key: "SANDY_EXTERNAL_URL", value: "https://external.example.test" },
  { key: "SANDY_FF_PLACEHOLDER", value: "true" },
  { key: "SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET", value: "2000" },
  { key: "SANDY_HOST_DAEMON_PORT", value: "48887" },
  { key: "SANDY_INHERITED_SKILLS_ROOTS", value: "/tmp/sandy-skills" },
  { key: "SANDY_LOG_LEVEL", value: "debug" },
  { key: "SANDY_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD", value: "1" },
  { key: "SANDY_OTLP_ENDPOINT", value: "http://127.0.0.1:4318" },
  { key: "SANDY_SERVER_BIND_HOST", value: "127.0.0.1" },
  { key: "SANDY_SERVER_PORT", value: "48886" },
];

const packageMetadataSchema = z.object({
  engines: z.object({
    node: z.string(),
  }),
  files: z.array(z.string()),
  os: z.array(z.string()),
});

type PackageMetadata = z.infer<typeof packageMetadataSchema>;

class FakeManagedProcessRun implements ManagedProcessRun {
  readonly exit: Promise<NamedProcessExitResult>;
  readonly id: string;
  readonly processName: ManagedProcessName;
  readonly terminationSignals: NodeJS.Signals[] = [];
  running = true;
  private resolveExit: ResolveFakeManagedProcessExit = () => undefined;

  constructor(args: FakeManagedProcessRunArgs) {
    this.id = args.id;
    this.processName = args.processName;
    this.exit = new Promise<NamedProcessExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
  }

  exitWith(result: ProcessExitResult): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.resolveExit({ processName: this.processName, result });
  }

  async terminate(signal: NodeJS.Signals): Promise<void> {
    this.terminationSignals.push(signal);
    this.exitWith({ code: null, signal });
  }
}

class ControlledDelay {
  readonly calls: ControlledDelayCall[] = [];

  async delayMilliseconds(args: DelayMillisecondsArgs): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.calls.push({
        ms: args.ms,
        resolve: resolvePromise,
      });
    });
  }
}

function delay(args: DelayArgs): Promise<DelayResult> {
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      resolvePromise("timeout");
    }, args.ms);
  });
}

const immediateDelay: DelayMillisecondsFn = () => {
  return Promise.resolve();
};

const noServerMovedFile: ReadServerMovedFileFn = async () => null;

async function unexpectedServerMove(): Promise<FullStackSupervisionResult> {
  throw new Error("Unexpected server move");
}

function createTestStartContext(): SandyAppStartContext {
  return {
    appDistDir: "/tmp/sandy-app-test/app/dist",
    appVersion: "0.0.0-test",
    configFile: "/tmp/sandy-app-test/config.json",
    daemonBundleDir: "/tmp/sandy-app-test/host-daemon/dist",
    daemonEntry: "/tmp/sandy-app-test/host-daemon/dist/daemon-bundle.mjs",
    daemonLockDir: "/tmp/sandy-app-test/daemon.lock.lock",
    daemonLockFile: "/tmp/sandy-app-test/daemon.lock",
    daemonPort: 38887,
    dataDir: "/tmp/sandy-app-test",
    dbPath: "/tmp/sandy-app-test/sandy.db",
    envFile: "/tmp/sandy-app-test/env.json",
    logDir: "/tmp/sandy-app-test/logs",
    packageRoot: "/tmp/sandy-app-test/package",
    serverEntry: "/tmp/sandy-app-test/server/dist/index.js",
    serverPort: 38886,
    serverUrl: "http://127.0.0.1:38886",
  };
}

function createFakeSupervisor(): FakeSupervisor {
  let shutdownRequested = false;
  const serverRuns = [
    new FakeManagedProcessRun({ id: "server-1", processName: "server" }),
  ];
  const daemonRuns = [
    new FakeManagedProcessRun({ id: "daemon-1", processName: "daemon" }),
  ];
  const processes: ManagedFullStackProcesses = {
    daemonRun: daemonRuns[0],
    serverRun: serverRuns[0],
  };
  const serverStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `server-${serverRuns.length + 1}`,
      processName: "server",
    });
    serverRuns.push(run);
    processes.serverRun = run;
    return run;
  };
  const daemonStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `daemon-${daemonRuns.length + 1}`,
      processName: "daemon",
    });
    daemonRuns.push(run);
    processes.daemonRun = run;
    return run;
  };
  return {
    daemonRuns,
    daemonStart,
    processes,
    serverRuns,
    serverStart,
    setShutdownRequested(value) {
      shutdownRequested = value;
    },
    shutdownRequested() {
      return shutdownRequested;
    },
  };
}

async function waitForProcessReplacement(
  args: WaitForProcessReplacementArgs,
): Promise<ManagedProcessRun> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const currentRun = args.currentRun();
    if (currentRun !== null && currentRun !== args.previousRun) {
      return currentRun;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for process replacement");
}

async function waitForDelayCall(
  args: WaitForDelayCallArgs,
): Promise<ControlledDelayCall> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const call = args.delay.calls[args.index];
    if (call !== undefined) {
      return call;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for restart throttle delay");
}

async function stopFakeSupervisor(
  supervisor: FakeSupervisor,
  supervision: Promise<FullStackSupervisionResult>,
): Promise<FullStackSupervisionResult> {
  supervisor.setShutdownRequested(true);
  await terminateManagedFullStackProcesses({
    processes: supervisor.processes,
    signal: "SIGTERM",
  });
  return supervision;
}

async function startConfigReloadTestServer(): Promise<ConfigReloadTestServer> {
  const reloadRequests: ConfigReloadRequest[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (
        request.method === "POST" &&
        request.url === "/api/v1/system/config/reload"
      ) {
        reloadRequests.push({
          host: request.headers.host,
          method: request.method,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }
  const addressInfo: AddressInfo = address;

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    port: addressInfo.port,
    reloadCount(): number {
      return reloadRequests.length;
    },
    reloadRequests(): ConfigReloadRequest[] {
      return [...reloadRequests];
    },
    url: `http://127.0.0.1:${addressInfo.port}`,
  };
}

async function startHostListTestServer(
  hosts: unknown[],
): Promise<HostListTestServer> {
  const requests: string[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "GET" && request.url === "/api/v1/hosts") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(hosts));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }
  const addressInfo: AddressInfo = address;

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    requests(): string[] {
      return [...requests];
    },
    url: `http://127.0.0.1:${addressInfo.port}`,
  };
}

function readPackageMetadata(): PackageMetadata {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return packageMetadataSchema.parse(
    JSON.parse(readFileSync(resolve(testDir, "..", "package.json"), "utf8")),
  );
}

function expectedConfigReloadRequest(
  server: ConfigReloadTestServer,
): ConfigReloadRequest {
  return {
    host: `127.0.0.1:${server.port}`,
    method: "POST",
    url: "/api/v1/system/config/reload",
  };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return chunks.join("");
}

describe("sandy-app launcher", () => {
  it("waits for the expected host daemon identity and connection", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/status") {
        response.writeHead(404).end();
        return;
      }
      statusRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          connected: statusRequests >= 2,
          hostId: "host-expected",
          serverUrl: "http://127.0.0.1:38886/",
        }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await waitForHostDaemonStatus({
        childProcess: null,
        expectedHostId: "host-expected",
        expectedServerUrl: "http://localhost:38886",
        port: address.port,
        timeoutMs: 1_000,
      });
      expect(statusRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("does not accept another daemon's successful health response", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.url === "/health"
          ? JSON.stringify({ ok: true })
          : JSON.stringify({
              connected: true,
              hostId: "host-other",
              serverUrl: "https://other.example.test",
            }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await expect(
        waitForHostDaemonStatus({
          childProcess: null,
          expectedHostId: "host-expected",
          expectedServerUrl: "https://sandy.example.test",
          port: address.port,
          timeoutMs: 25,
        }),
      ).rejects.toThrow("Timed out waiting for host daemon host-expected");
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("resolves production defaults for npx startup", () => {
    const context = resolveSandyAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.dataDir).toBe(join("/home/tester", ".sandy"));
    expect(context.configFile).toBe(join("/home/tester", ".sandy", "config.json"));
    expect(context.envFile).toBe(join("/home/tester", ".sandy", "env.json"));
    expect(context.serverPort).toBe(38886);
    expect(context.daemonPort).toBe(38887);
    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
    expect(context.serverEntry).toBe(
      resolve("/repo/packages/sandy-app/server/dist/index.js"),
    );
    expect(context.daemonEntry).toBe(
      resolve("/repo/packages/sandy-app/host-daemon/dist/daemon-bundle.mjs"),
    );
    expect(context.appVersion).toBe("0.0.0-dev");
  });

  it("uses workspace build outputs when run from a source checkout", () => {
    const context = resolveSandyAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/src/launcher.ts")
        .href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.packageRoot).toBe(resolve("/repo/packages/sandy-app"));
    expect(context.appDistDir).toBe(resolve("/repo/apps/app/dist"));
    expect(context.serverEntry).toBe(
      resolve("/repo/apps/server/dist/index.js"),
    );
    expect(context.daemonBundleDir).toBe(
      resolve("/repo/apps/host-daemon/dist"),
    );
    expect(context.daemonEntry).toBe(
      resolve("/repo/apps/host-daemon/dist/daemon-bundle.mjs"),
    );
  });

  it("reads appVersion from the package.json next to the resolved package root", () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const expectedVersion = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      ).version;
    expect(readSandyAppPackageVersion(packageRoot)).toBe(expectedVersion);
  });

  it("falls back to the dev sentinel when package.json is missing", () => {
    expect(readSandyAppPackageVersion("/nonexistent/sandy-app/path")).toBe(
      "0.0.0-dev",
    );
  });

  it("honors explicit production ports and data directory", () => {
    const env = {
      SANDY_DATA_DIR: "~/custom-sandy",
      SANDY_HOST_DAEMON_PORT: "48887",
      SANDY_SERVER_PORT: "48886",
    };

    expect(resolveDataDir({ env, homeDir: "/home/tester" })).toBe(
      resolve("/home/tester/custom-sandy"),
    );
    expect(
      resolvePortFromEnv({ defaultPort: 1, env, name: "SANDY_SERVER_PORT" }),
    ).toBe(48886);
    expect(
      resolvePortFromEnv({ defaultPort: 1, env, name: "SANDY_HOST_DAEMON_PORT" }),
    ).toBe(48887);
  });

  it("creates host enroll-key request bodies", () => {
    expect(createHostEnrollKeyRequestBody({ requestedHostId: null })).toEqual(
      {},
    );
    expect(
      createHostEnrollKeyRequestBody({
        requestedHostId: "host_local",
      }),
    ).toEqual({
      hostId: "host_local",
    });
  });

  it("starts sandy when no command or the explicit start command is provided", () => {
    expect(resolveSandyAppCommand([])).toEqual({ kind: "start" });
    expect(resolveSandyAppCommand(["start"])).toEqual({ kind: "start" });
  });

  it("stops sandy on the explicit stop command only", () => {
    expect(resolveSandyAppCommand(["stop"])).toEqual({ kind: "stop" });
    expect(resolveSandyAppCommand(["stop", "now"])).toEqual({
      command: "stop",
      kind: "invalid",
    });
  });

  it("keeps CLI commands on the sandy binary", () => {
    expect(resolveSandyAppCommand(["status"])).toEqual({
      command: "status",
      kind: "invalid",
    });
    expect(resolveSandyAppCommand(["thread", "list"])).toEqual({
      command: "thread",
      kind: "invalid",
    });
  });

  it("starts only the host daemon for the explicit host-daemon start command", () => {
    expect(resolveSandyAppCommand(["host-daemon"])).toEqual({
      args: [],
      kind: "host-daemon",
    });
    expect(resolveSandyAppCommand(["host-daemon", "join"])).toEqual({
      args: ["join"],
      kind: "host-daemon",
    });
  });

  it("prints help for help requests", () => {
    expect(resolveSandyAppCommand(["--help"])).toEqual({ kind: "help" });
    expect(resolveSandyAppCommand(["help"])).toEqual({ kind: "help" });
  });

  it("parses launcher flags separately from commands", () => {
    expect(
      parseLauncherArgs([
        "host-daemon",
        "join",
        "--data-dir",
        "~/sandy-data",
        "--server-url",
        "https://sandy.example.test",
        "--join-code",
        "sandyde_supplied",
        "--host-id",
        "host_remote",
        "--host-daemon-port",
        "48887",
        "--auto-update",
      ]),
    ).toEqual({
      options: {
        autoUpdate: true,
        dataDir: "~/sandy-data",
        help: false,
        hostDaemonPort: "48887",
        hostId: "host_remote",
        joinCode: "sandyde_supplied",
        json: false,
        serverUrl: "https://sandy.example.test",
      },
      positionals: ["host-daemon", "join"],
    });
  });

  it("passes opt-in performance diagnostics through to the launched server", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-performance-"));
    try {
      for (const enabled of [false, true]) {
        const runtime = await resolveSandyAppRuntimeState({
          entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js")
            .href,
          env: { SANDY_DATA_DIR: dataDir },
          homeDir: "/home/tester",
          options: parseLauncherArgs(enabled ? ["--perf-diagnostics"] : [])
            .options,
          serverUrlMode: "local",
        });
        expect(runtime.serverEnv.SANDY_PERF_DIAGNOSTICS).toBe(
          enabled ? "1" : undefined,
        );
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps the connection URL on loopback when extra bind addresses are set", async () => {
    const parsedArgs = parseLauncherArgs(["--server-bind-host", "100.64.0.7"]);
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-bind-host-"));
    const runtime = await resolveSandyAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: { SANDY_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: parsedArgs.options,
      serverUrlMode: "local",
    });

    expect(parsedArgs.options.serverBindHost).toBe("100.64.0.7");
    expect(runtime.serverEnv.SANDY_SERVER_BIND_HOST).toBe("100.64.0.7");
    expect(
      resolveServerListenerUrl({
        port: runtime.context.serverPort,
      }),
    ).toBe("http://127.0.0.1:38886");
    expect(runtime.context.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("strips parent thread context from the production server without stripping the CLI", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-thread-context-"));
    const runtime = await resolveSandyAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: {
        SANDY_DATA_DIR: dataDir,
        SANDY_ENVIRONMENT_ID: "env_parent",
        SANDY_PROJECT_ID: "proj_parent",
        SANDY_THREAD_ID: "thr_parent",
        SANDY_THREAD_STORAGE: "/home/tester/.sandy/thread-storage/thr_parent",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(runtime.serverEnv.SANDY_ENVIRONMENT_ID).toBeUndefined();
    expect(runtime.serverEnv.SANDY_THREAD_ID).toBeUndefined();
    expect(runtime.serverEnv.SANDY_THREAD_STORAGE).toBeUndefined();
    expect(runtime.serverEnv.SANDY_PROJECT_ID).toBe("proj_parent");

    const daemonEnv = createDaemonEnv({
      context: runtime.context,
      env: runtime.env,
      serverUrl: runtime.context.serverUrl,
    });
    expect(daemonEnv.SANDY_ENVIRONMENT_ID).toBeUndefined();
    expect(daemonEnv.SANDY_THREAD_ID).toBeUndefined();
    expect(daemonEnv.SANDY_THREAD_STORAGE).toBeUndefined();
    expect(daemonEnv.SANDY_PROJECT_ID).toBe("proj_parent");

    expect(runtime.env.SANDY_ENVIRONMENT_ID).toBe("env_parent");
    expect(runtime.env.SANDY_THREAD_ID).toBe("thr_parent");
    expect(runtime.env.SANDY_THREAD_STORAGE).toBe(
      "/home/tester/.sandy/thread-storage/thr_parent",
    );

    const cliThreadIdPath = join(dataDir, "cli-thread-id.txt");
    const exitCode = await runBundledCliCommand({
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.env.SANDY_THREAD_ID ?? 'missing')",
        cliThreadIdPath,
      ],
      context: runtime.context,
      env: { ...runtime.env, SANDY_CLI: process.execPath },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(cliThreadIdPath, "utf8")).toBe("thr_parent");
  });

  it("rejects an invalid server bind host before launcher startup", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-invalid-bind-host-"));

    await expect(
      runSandyApp(["--data-dir", dataDir, "--server-bind-host", "localhost"]),
    ).rejects.toThrow(
      'SANDY_SERVER_BIND_HOST entry "localhost" is not an IP address',
    );
  });

  it("tells the bundled CLI where the server's machine installer is", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-cli-installer-"));
    const outputPath = join(dataDir, "installer-path.txt");

    const exitCode = await runBundledCliCommand({
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.env.SANDY_MACHINE_INSTALLER ?? 'missing')",
        outputPath,
      ],
      context: { ...createTestStartContext(), dataDir },
      env: { SANDY_CLI: process.execPath },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(
      join("/tmp/sandy-app-test/server/dist", "assets", "install-machine.sh"),
    );
  });

  it("runs the bundled CLI when a SANDY_CLI launcher re-enters the sandy entry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-cli-reentry-"));
    const daemonBundleDir = join(dataDir, "host-daemon");
    mkdirSync(daemonBundleDir);
    writeFileSync(
      join(daemonBundleDir, "sandy"),
      "require('node:fs').writeFileSync(process.argv[2], 'bundled')",
    );
    const context = { ...createTestStartContext(), dataDir, daemonBundleDir };
    const launcherEnvPath = join(dataDir, "launcher-env.json");

    expect(
      await runBundledCliCommand({
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
          launcherEnvPath,
        ],
        context,
        env: { SANDY_CLI: process.execPath },
      }),
    ).toBe(0);

    const outputPath = join(dataDir, "reentry.txt");
    const reentryExitCode = await runBundledCliCommand({
      args: [outputPath],
      context,
      env: JSON.parse(readFileSync(launcherEnvPath, "utf8")),
    });

    expect(reentryExitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("bundled");
  });

  it("uses a supplied join code without requesting a loopback enroll key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-remote-join-"));
    const context = { ...createTestStartContext(), dataDir };

    const env = await createHostDaemonJoinEnv({
      context,
      env: {
        SANDY_HOST_ENROLL_KEY: "sandyde_supplied",
        SANDY_HOST_ID: "host_remote",
        SANDY_CONNECT_MACHINE_CREDENTIAL: "sandycm_machine",
      },
      serverUrl: "https://sandy.example.test",
    });

    expect(env).toMatchObject({
      SANDY_HOST_ENROLL_KEY: "sandyde_supplied",
      SANDY_HOST_ID: "host_remote",
    });
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({ serverUrl: "https://sandy.example.test" });
  });

  it("requires the join-code host ID on a fresh machine", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-remote-join-"));

    await expect(
      createHostDaemonJoinEnv({
        context: { ...createTestStartContext(), dataDir },
        env: { SANDY_HOST_ENROLL_KEY: "sandyde_supplied" },
        serverUrl: "https://sandy.example.test",
      }),
    ).rejects.toThrow("--host-id is required when --join-code is supplied");
  });

  it("parses the json launcher flag", () => {
    expect(
      parseLauncherArgs(["client", "ssh-target", "list", "--json"]),
    ).toEqual({
      options: {
        help: false,
        json: true,
      },
      positionals: ["client", "ssh-target", "list"],
    });
  });

  it("uses managed config server URL when env and flags omit it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://sandy.example.test" }),
      "utf8",
    );

    const context = (
      await resolveSandyAppRuntimeState({
        entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js")
          .href,
        env: { SANDY_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        serverUrlMode: "managed",
      })
    ).context;

    expect(context.serverUrl).toBe("https://sandy.example.test");
  });

  it("uses managed config server URL over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-server-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveSandyAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: {
        SANDY_DATA_DIR: dataDir,
        SANDY_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://stored.example.test");
    expect(runtime.env.SANDY_SERVER_URL).toBe("https://stored.example.test");
  });

  it("keeps full-stack startup local even when managed config has a server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-local-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://sandy.example.test" }),
      "utf8",
    );

    const context = (
      await resolveSandyAppRuntimeState({
        entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js")
          .href,
        env: { SANDY_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        serverUrlMode: "local",
      })
    ).context;

    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("applies managed config environment values over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-env-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        config: {
          SANDY_APP_URL: "https://sandy.example.test",
          SANDY_LOG_LEVEL: "debug",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );

    const runtime = await resolveSandyAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: { SANDY_DATA_DIR: dataDir, OPENAI_API_KEY: "ambient-openai-key" },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(runtime.env.SANDY_APP_URL).toBe("https://sandy.example.test");
    expect(runtime.env.SANDY_LOG_LEVEL).toBe("debug");
    expect(runtime.env.OPENAI_API_KEY).toBe("stored-openai-key");
    expect(runtime.serverEnv.SANDY_LOG_LEVEL).toBe("debug");
    expect(runtime.serverEnv.OPENAI_API_KEY).toBe("stored-openai-key");
  });

  it("applies the worktree policy after conflicting saved environment values", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-worktree-policy-"));
    const storedDataDir = join(dataDir, "stored-data");
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          SANDY_DATA_DIR: storedDataDir,
          SANDY_DEV_APP_PORT: "4173",
          SANDY_HOST_DAEMON_PORT: "48887",
          SANDY_INHERITED_SKILLS_ROOTS: "/stored/skills",
          SANDY_SERVER_BIND_HOST: "100.64.0.7",
          SANDY_SERVER_PORT: "48886",
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );
    const worktreeEnv: NodeJS.ProcessEnv = {
      SANDY_DATA_DIR: dataDir,
      SANDY_HOST_DAEMON_PORT: "47887",
      SANDY_INHERITED_SKILLS_ROOTS: "/worktree/skills",
      SANDY_SERVER_PORT: "47886",
    };

    const runtime = await resolveSandyAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: worktreeEnv,
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
      worktreePolicy: resolveWorktreeRuntimePolicy({
        env: worktreeEnv,
        homeDir: "/home/tester",
      }),
    });

    expect(runtime.context).toMatchObject({
      daemonPort: 47887,
      dataDir,
      serverPort: 47886,
      serverUrl: "http://127.0.0.1:47886",
    });
    for (const env of [runtime.env, runtime.serverEnv]) {
      expect(env).toMatchObject({
        SANDY_DATA_DIR: dataDir,
        SANDY_HOST_DAEMON_PORT: "47887",
        SANDY_INHERITED_SKILLS_ROOTS: "/worktree/skills",
        SANDY_SERVER_PORT: "47886",
        OPENAI_API_KEY: "stored-openai-key",
      });
      expect(env.SANDY_SERVER_BIND_HOST).toBeUndefined();
      expect(env.SANDY_DEV_APP_PORT).toBeUndefined();
    }
  });

  it("uses launcher flags over managed config and ambient server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-flag-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveSandyAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: {
        SANDY_DATA_DIR: dataDir,
        SANDY_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: {
        help: false,
        serverUrl: "https://flag.example.test",
      },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://flag.example.test");
    expect(runtime.env.SANDY_SERVER_URL).toBe("https://flag.example.test");
  });

  it("stores managed config values from the config command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-config-command-"));

    await runSandyApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "SANDY_APP_URL",
      "https://sandy.example.test",
    ]);
    await runSandyApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "SANDY_LOG_LEVEL",
      "debug",
    ]);
    await runSandyApp([
      "--data-dir",
      dataDir,
      "env",
      "set",
      "OPENAI_API_KEY",
      "test-openai-key",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        SANDY_APP_URL: "https://sandy.example.test",
        SANDY_LOG_LEVEL: "debug",
      },
    });
    expect(JSON.parse(readFileSync(join(dataDir, "env.json"), "utf8"))).toEqual(
      {
        env: {
          OPENAI_API_KEY: "test-openai-key",
        },
      },
    );
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "env.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("stores client SSH targets from the client command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-client-command-"));
    const server = await startHostListTestServer([
      {
        id: "host_1",
        name: "mbp-intel",
        status: "connected",
      },
    ]);

    try {
      await runSandyApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "set",
        `${server.url}/projects/proj_1`,
        "mbp-intel",
      ]);

      expect(server.requests()).toContain("GET /api/v1/hosts");
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {
          [server.url]: {
            hosts: {
              host_1: {
                sshAuthority: "mbp-intel",
              },
            },
          },
        },
      });
      if (process.platform !== "win32")
        expect(statSync(join(dataDir, "client.json")).mode & 0o777).toBe(0o600);

      await runSandyApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "set",
        server.url,
        "buildbox",
        "--host-id",
        "host_2",
      ]);
      expect(
        server.requests().filter((request) => request.includes("/hosts")),
      ).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toMatchObject({
        servers: {
          [server.url]: {
            hosts: {
              host_1: { sshAuthority: "mbp-intel" },
              host_2: { sshAuthority: "buildbox" },
            },
          },
        },
      });

      await runSandyApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "remove",
        server.url,
        "--host-id",
        "host_2",
      ]);
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {
          [server.url]: {
            hosts: {
              host_1: { sshAuthority: "mbp-intel" },
            },
          },
        },
      });

      await runSandyApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "remove",
        server.url,
      ]);

      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {},
      });
    } finally {
      await server.close();
    }
  });

  it("loads a config that still carries the removed customAcpAgents array and drops it on the next write", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-config-custom-acp-"));
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({
        customAcpAgents: [
          { id: "my-agent", displayName: "My Agent", command: "my-agent" },
          { id: "bad agent" },
        ],
      })}\n`,
      "utf8",
    );

    await runSandyApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "SANDY_APP_URL",
      "https://sandy.example.test",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        SANDY_APP_URL: "https://sandy.example.test",
      },
    });
  });

  it("keeps secrets out of the config command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-secret-config-"));

    await expect(
      runSandyApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "OPENAI_API_KEY",
        "test-openai-key",
      ]),
    ).rejects.toThrow(/sandy-app env set OPENAI_API_KEY/u);
  });

  it("rejects invalid server bind hosts before writing managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-invalid-bind-env-"));
    const envPath = join(dataDir, "env.json");
    const initialEnvFile = {
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    };
    writeFileSync(envPath, JSON.stringify(initialEnvFile), "utf8");

    await expect(
      runSandyApp([
        "--data-dir",
        dataDir,
        "env",
        "set",
        "SANDY_SERVER_BIND_HOST",
        "localhost",
      ]),
    ).rejects.toThrow(
      'SANDY_SERVER_BIND_HOST entry "localhost" is not an IP address',
    );
    await expect(
      runSandyApp([
        "--data-dir",
        dataDir,
        "env",
        "set",
        "SANDY_SERVER_BIND_HOST",
        "0.0.0.0",
      ]),
    ).rejects.toThrow("must not contain the wildcard address 0.0.0.0");

    expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual(initialEnvFile);
  });

  it("unsets an invalid server bind host already in managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-recover-bind-env-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { SANDY_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    await runSandyApp([
      "--data-dir",
      dataDir,
      "env",
      "unset",
      "SANDY_SERVER_BIND_HOST",
    ]);

    expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual({});
  });

  it("names the env file when a persisted server bind host is invalid", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-bad-bind-env-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { SANDY_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    await expect(runSandyApp(["--data-dir", dataDir])).rejects.toThrow(envPath);
  });

  it("blames the flag, not the env file, for an invalid flag value", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-bad-bind-flag-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { SANDY_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    const failure = await runSandyApp([
      "--data-dir",
      dataDir,
      "--server-bind-host",
      "0.0.0.0.0",
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("SANDY_SERVER_BIND_HOST");
    expect((failure as Error).message).not.toContain(envPath);
  });

  it("rejects invalid env key names", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-invalid-env-"));

    await expect(
      runSandyApp(["--data-dir", dataDir, "env", "set", "1BAD", "value"]),
    ).rejects.toThrow(/Invalid env key/u);
  });

  it("uses the explicit server bind host flag over managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-bind-host-env-"));
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({ env: { SANDY_SERVER_BIND_HOST: "100.64.0.7" } }),
      "utf8",
    );
    const parsedArgs = parseLauncherArgs(["--server-bind-host", "127.0.0.1"]);

    const runtime = await resolveSandyAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/sandy-app/dist/sandy-app.js").href,
      env: { SANDY_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: parsedArgs.options,
      serverUrlMode: "local",
    });

    expect(runtime.serverEnv.SANDY_SERVER_BIND_HOST).toBe("127.0.0.1");
  });

  it("rejects invalid managed config values before writing or reloading", async () => {
    const server = await startConfigReloadTestServer();
    try {
      for (const testCase of invalidConfigCommandCases) {
        const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-invalid-config-"));
        const configPath = join(dataDir, "config.json");
        const initialConfig = {
          config: {
            SANDY_APP_URL: "https://existing.example.test",
          },
        };
        writeFileSync(
          configPath,
          `${JSON.stringify(initialConfig, null, 2)}\n`,
          "utf8",
        );

        await expect(
          runSandyApp([
            "--data-dir",
            dataDir,
            "--server-port",
            String(server.port),
            "config",
            "set",
            testCase.key,
            testCase.value,
          ]),
        ).rejects.toThrow(testCase.expectedError);

        expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(
          initialConfig,
        );
      }

      expect(server.reloadCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("prints a restart notice when setting a startup-only config key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-startup-config-set-"));
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runSandyApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "config",
          "set",
          "SANDY_LOG_LEVEL",
          "debug",
        ]),
      );

      expect(output).toContain(
        "SANDY_LOG_LEVEL is startup-only. The running process keeps its current value; a full sandy-app restart is required to apply this change. Run `sandy-app stop && sandy-app start`, or restart the desktop app.",
      );
      expect(output).not.toContain("Reloaded running sandy server config.");
      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("prints restart notices for every server startup-only managed env key", async () => {
    const server = await startConfigReloadTestServer();

    try {
      for (const testCase of startupOnlyManagedEnvCases) {
        const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-startup-env-set-"));
        const output = await captureStdout(() =>
          runSandyApp([
            "--data-dir",
            dataDir,
            "--server-port",
            String(server.port),
            "env",
            "set",
            testCase.key,
            testCase.value,
          ]),
        );

        expect(output).toContain(
          `${testCase.key} is startup-only. The running process keeps its current value; a full sandy-app restart is required to apply this change.`,
        );
        expect(output).not.toContain("Reloaded running sandy server config.");
      }
      expect(server.reloadCount()).toBe(startupOnlyManagedEnvCases.length);
    } finally {
      await server.close();
    }
  });

  it("warns that the previous listen addresses remain after unsetting the server bind host", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-startup-bind-unset-"));
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({ env: { SANDY_SERVER_BIND_HOST: "100.64.0.7" } }),
      "utf8",
    );
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runSandyApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "env",
          "unset",
          "SANDY_SERVER_BIND_HOST",
        ]),
      );

      expect(output).toContain(
        "SANDY_SERVER_BIND_HOST is startup-only. The running process keeps its current value; a full sandy-app restart is required to apply this change. Run `sandy-app stop && sandy-app start`, or restart the desktop app.",
      );
      expect(output).toContain(
        "Until then, the server keeps listening on its previous addresses.",
      );
      expect(output).not.toContain("Reloaded running sandy server config.");
      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps the reload confirmation for reloadable keys", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-reloadable-env-set-"));
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runSandyApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "env",
          "set",
          "OPENAI_API_KEY",
          "test-openai-key",
        ]),
      );

      expect(output).toContain("Reloaded running sandy server config.");
      expect(output).not.toContain("is startup-only");
    } finally {
      await server.close();
    }
  });

  it("reports that startup-only config will apply on next start without a running server", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-startup-next-start-"));
    const unavailableServer = await startConfigReloadTestServer();
    const unavailablePort = unavailableServer.port;
    await unavailableServer.close();

    const output = await captureStdout(() =>
      runSandyApp([
        "--data-dir",
        dataDir,
        "--server-port",
        String(unavailablePort),
        "env",
        "set",
        "SANDY_SERVER_BIND_HOST",
        "100.64.0.7",
      ]),
    );

    expect(output).toContain("config will apply on next start.");
    expect(output).not.toContain("is startup-only");
  });

  it("notes configured startup-only keys after explicit refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-startup-refresh-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ config: { SANDY_LOG_LEVEL: "debug" } }),
      "utf8",
    );
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          SANDY_FF_PLACEHOLDER: "true",
          SANDY_SERVER_BIND_HOST: "100.64.0.7",
          SANDY_SERVER_PORT: "48886",
        },
      }),
      "utf8",
    );
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runSandyApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "config",
          "refresh",
        ]),
      );

      expect(output).toContain("Reloaded running sandy server config.");
      expect(output).toContain(
        "Startup-only settings currently configured (SANDY_FF_PLACEHOLDER, SANDY_LOG_LEVEL, SANDY_SERVER_BIND_HOST, SANDY_SERVER_PORT) apply on the next full sandy-app restart.",
      );
    } finally {
      await server.close();
    }
  });

  it("uses SANDY_SERVER_URL for config refresh when set", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-config-env-refresh-"));
    const server = await startConfigReloadTestServer();
    const previousServerUrl = process.env.SANDY_SERVER_URL;

    try {
      process.env.SANDY_SERVER_URL = server.url;

      await runSandyApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.SANDY_SERVER_URL;
      } else {
        process.env.SANDY_SERVER_URL = previousServerUrl;
      }
      await server.close();
    }
  });

  it("uses persisted SANDY_SERVER_URL for config refresh without env or flags", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-config-persisted-url-"));
    const server = await startConfigReloadTestServer();

    try {
      await runSandyApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "SANDY_SERVER_URL",
        server.url,
      ]);

      expect(
        JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
      ).toEqual({
        serverUrl: server.url,
      });
      expect(server.reloadRequests()).toEqual([]);

      await runSandyApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("uses --server-url over env and persisted config for config refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-config-flag-url-"));
    const configServer = await startConfigReloadTestServer();
    const envServer = await startConfigReloadTestServer();
    const flagServer = await startConfigReloadTestServer();
    const previousServerUrl = process.env.SANDY_SERVER_URL;

    try {
      await runSandyApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "SANDY_SERVER_URL",
        configServer.url,
      ]);

      process.env.SANDY_SERVER_URL = envServer.url;
      await runSandyApp([
        "--data-dir",
        dataDir,
        "--server-url",
        flagServer.url,
        "config",
        "refresh",
      ]);

      expect(configServer.reloadRequests()).toEqual([]);
      expect(envServer.reloadRequests()).toEqual([]);
      expect(flagServer.reloadRequests()).toEqual([
        expectedConfigReloadRequest(flagServer),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.SANDY_SERVER_URL;
      } else {
        process.env.SANDY_SERVER_URL = previousServerUrl;
      }
      await flagServer.close();
      await envServer.close();
      await configServer.close();
    }
  });

  it("observes child processes that exited before wait registration", async () => {
    const childProcess = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", () => {
        resolvePromise();
      });
    });

    await expect(
      Promise.race([waitForProcessExit(childProcess), delay({ ms: 100 })]),
    ).resolves.toEqual({ code: 7, signal: null });
  });

  it("keeps daemon running and starts only a new server after server exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialServerRun.exitWith({ code: 1, signal: null });
    const nextServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: initialServerRun,
    });

    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(true);
    expect(supervisor.processes.daemonRun).toBe(initialDaemonRun);
    expect(supervisor.daemonRuns).toHaveLength(1);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(nextServerRun).toBe(supervisor.serverRuns[1]);
    expect(supervisor.serverRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("keeps server running and starts only a new daemon after daemon exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialDaemonRun.exitWith({ code: 1, signal: null });
    const nextDaemonRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.daemonRun,
      previousRun: initialDaemonRun,
    });

    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.running).toBe(true);
    expect(supervisor.processes.serverRun).toBe(initialServerRun);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(2);
    expect(nextDaemonRun).toBe(supervisor.daemonRuns[1]);
    expect(supervisor.daemonRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("terminates both children without restarting during shutdown", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    supervisor.setShutdownRequested(true);
    await terminateManagedFullStackProcesses({
      processes: supervisor.processes,
      signal: "SIGINT",
    });

    await expect(supervision).resolves.toBe("shutdown");
    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.terminationSignals).toEqual(["SIGINT"]);
    expect(initialDaemonRun.terminationSignals).toEqual(["SIGINT"]);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(1);
  });

  it("sets exit code to 0 after clean full-stack shutdown", async () => {
    const previousExitCode = process.exitCode;
    const supervisor = createFakeSupervisor();
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    try {
      process.exitCode = 1;
      supervisor.setShutdownRequested(true);
      const shutdownPromise = terminateManagedFullStackProcesses({
        processes: supervisor.processes,
        signal: "SIGINT",
      });
      const supervisionResult = await supervision;

      await completeFullStackSupervision({
        shutdownPromise,
        supervisionResult,
      });

      expect(process.exitCode).toBe(0);
      expect(supervisor.serverRuns).toHaveLength(1);
      expect(supervisor.daemonRuns).toHaveLength(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("throttles repeated healthy child exits before restarting", async () => {
    const restartThrottle = new ControlledDelay();
    const supervisor = createFakeSupervisor();
    const firstServerRun = supervisor.serverRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: (args) => restartThrottle.delayMilliseconds(args),
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    firstServerRun.exitWith({ code: 1, signal: null });
    const firstDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 0,
    });
    expect(firstDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.processes.serverRun).toBeNull();
    firstDelay.resolve();

    const secondServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: firstServerRun,
    });
    expect(supervisor.serverRuns).toHaveLength(2);

    supervisor.serverRuns[1]?.exitWith({ code: 1, signal: null });
    const secondDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 1,
    });
    expect(secondDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(supervisor.processes.serverRun).toBeNull();
    secondDelay.resolve();

    const thirdServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: secondServerRun,
    });
    expect(thirdServerRun).toBe(supervisor.serverRuns[2]);
    expect(supervisor.serverRuns).toHaveLength(3);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("runs the bundled CLI with the launcher's own Node runtime", () => {
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "/opt/sandy/host-daemon/dist/sandy",
        cliOverride: null,
        nodePath: "/Applications/sandy.app/Contents/MacOS/sandy",
        platform: "darwin",
      }),
    ).toEqual({
      command: "/Applications/sandy.app/Contents/MacOS/sandy",
      args: ["/opt/sandy/host-daemon/dist/sandy", "status"],
    });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "C:\\sandy\\host-daemon\\dist\\sandy",
        cliOverride: null,
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\sandy\\host-daemon\\dist\\sandy", "status"],
    });
  });

  it("runs a SANDY_CLI override directly, or through Node when it is extensionless on Windows", () => {
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "C:\\sandy\\host-daemon\\dist\\sandy",
        cliOverride: "C:\\dev\\sandy",
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\dev\\sandy", "status"],
    });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "C:\\sandy\\host-daemon\\dist\\sandy",
        cliOverride: "C:\\tools\\sandy.exe",
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({ command: "C:\\tools\\sandy.exe", args: ["status"] });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "/opt/sandy/host-daemon/dist/sandy",
        cliOverride: "/repo/apps/cli/bin/sandy",
        nodePath: "/usr/bin/node",
        platform: "linux",
      }),
    ).toEqual({ command: "/repo/apps/cli/bin/sandy", args: ["status"] });
  });

  it("limits npm package metadata to documented runtimes", () => {
    const metadata = readPackageMetadata();

    expect(metadata.engines.node).toBe("^22.19.0 || ^24.0.0 || ^26.0.0");
    expect(metadata.files).toContain(
      "host-daemon/dist/sandy-plugin-host-worker.mjs",
    );
    expect(metadata.files).toContain("host-daemon/dist/sandy");
    expect(metadata.files).toContain("host-daemon/dist/sandy.cmd");
    expect(metadata.files).toContain("host-daemon/dist/sandy-chunks");
    expect(metadata.os).toEqual(["darwin", "linux", "win32"]);
  });

  it("requires the bundled CLI's chunk directory next to host-daemon/dist/sandy", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "sandy-app-artifacts-"));
    try {
      const context = resolveSandyAppStartContext({
        entrypointUrl: pathToFileURL(join(packageRoot, "dist", "sandy.js")).href,
        env: {},
        homeDir: join(packageRoot, "home"),
      });
      for (const artifact of [
        context.serverEntry,
        context.daemonEntry,
        join(context.daemonBundleDir, "sandy"),
        join(context.daemonBundleDir, "sandy-provider-bridge-worker.mjs"),
        join(context.daemonBundleDir, "sandy-parcel-watcher-child.mjs"),
        join(context.daemonBundleDir, "sandy-plugin-host-worker.mjs"),
        join(context.appDistDir, "index.html"),
      ]) {
        mkdirSync(dirname(artifact), { recursive: true });
        writeFileSync(artifact, "");
      }

      const missingChunks = `Missing bundled sandy CLI chunks at ${join(packageRoot, "host-daemon", "dist", "sandy-chunks")}. Rebuild sandy-app`;
      expect(() => assertSandyAppArtifacts(context)).toThrow(missingChunks);

      const chunkDir = join(context.daemonBundleDir, "sandy-chunks");
      mkdirSync(chunkDir);
      expect(() => assertSandyAppArtifacts(context)).toThrow(missingChunks);

      writeFileSync(join(chunkDir, "chunk-AAAAAAAA.js"), "");
      expect(() => assertSandyAppArtifacts(context)).not.toThrow();

      rmSync(context.serverEntry);
      rmSync(join(context.appDistDir, "index.html"));
      expect(() => assertSandyHostArtifacts(context)).not.toThrow();
      expect(() => assertSandyAppArtifacts(context)).toThrow(
        /^Missing server entry/u,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("prunes stale sandy CLI chunks from package build output", () => {
    const pruneScript = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "prune-sandy-chunks.mjs",
    );
    const packageRoot = mkdtempSync(join(tmpdir(), "sandy-app-prune-"));
    try {
      const chunkDir = join(packageRoot, "host-daemon", "dist", "sandy-chunks");
      mkdirSync(chunkDir, { recursive: true });
      writeFileSync(
        join(packageRoot, "host-daemon", "dist", "sandy"),
        'import"./sandy-chunks/chunk-LIVE.js";\n',
      );
      writeFileSync(join(chunkDir, "chunk-LIVE.js"), "export var a=1;\n");
      writeFileSync(join(chunkDir, "chunk-STALE.js"), "export var s=1;\n");
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "sandy-app-prune-fixture",
          version: "0.0.1",
          files: ["host-daemon/dist/sandy", "host-daemon/dist/sandy-chunks"],
        }),
      );

      execFileSync("node", [pruneScript], { cwd: packageRoot });
      expect(readdirSync(chunkDir)).toEqual(["chunk-LIVE.js"]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("keeps the desktop app surface the desktop shell passes to the server", () => {
    const context = createTestStartContext();

    const desktopServerEnv = createServerEnv({
      cliLauncherPath: null,
      context,
      env: { SANDY_APP_SURFACE: "desktop" },
    });
    const webServerEnv = createServerEnv({
      cliLauncherPath: null,
      context,
      env: {},
    });
    const invalidSurfaceServerEnv = createServerEnv({
      cliLauncherPath: null,
      context,
      env: { SANDY_APP_SURFACE: "bogus" },
    });

    expect(desktopServerEnv.SANDY_APP_SURFACE).toBe("desktop");
    expect(webServerEnv.SANDY_APP_SURFACE).toBe("web");
    expect(invalidSurfaceServerEnv.SANDY_APP_SURFACE).toBe("web");
  });

  it("tells the server about the sandy command launcher only when this start wrote one", () => {
    const context = createTestStartContext();

    expect(
      createServerEnv({
        cliLauncherPath: "/home/me/.sandy/bin/sandy",
        context,
        env: { SANDY_CLI_LAUNCHER: "/stale/bin/sandy" },
      }).SANDY_CLI_LAUNCHER,
    ).toBe("/home/me/.sandy/bin/sandy");
    expect(
      createServerEnv({
        cliLauncherPath: null,
        context,
        env: { SANDY_CLI_LAUNCHER: "/stale/bin/sandy" },
      }),
    ).not.toHaveProperty("SANDY_CLI_LAUNCHER");
  });
});

it("preserves machine identity and access headers through real config set and unset", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sandy-app-config-machine-"));
  const identity = {
    serverUrl: "https://machine.example",
    serverHeaders: { "x-sandy-machine-access": "private-machine-access" },
    machineCredential: "legacy-private",
    connectMachineId: "cloud-device",
  };
  try {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(identity));
    await runSandyApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "SANDY_APP_URL",
      "https://other.example",
    ]);
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toMatchObject(identity);
    await runSandyApp(["--data-dir", dataDir, "config", "unset", "SANDY_APP_URL"]);
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual(identity);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("managed process networking", () => {
  it.each(["server", "daemon"] as const)(
    "%s uses the environment proxy and keeps loopback direct",
    async (kind) => {
      if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) return;
      const proxy = createServer();
      proxy.on("connect", (_request, socket) => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.once("data", () => {
          socket.end(
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied",
          );
        });
      });
      const direct = createServer((_request, response) =>
        response.end("direct"),
      );
      await Promise.all(
        [proxy, direct].map(
          (server) =>
            new Promise<void>((resolve) =>
              server.listen(0, "127.0.0.1", resolve),
            ),
        ),
      );
      const port = (server: ReturnType<typeof createServer>) => {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing listener");
        return address.port;
      };
      const env = {
        HTTP_PROXY: `http://127.0.0.1:${port(proxy)}`,
      };
      const context = createTestStartContext();
      const launchEnv =
        kind === "server"
          ? createServerEnv({
              context,
              env,
              cliLauncherPath: null,
            })
          : createDaemonEnv({
              context,
              env,
              serverUrl: "http://127.0.0.1:38886",
            });
      try {
        const result = await execHostFile(
          process.execPath,
          [
            ...nodeNetworkArgs(launchEnv),
            "--input-type=module",
            "-e",
            `for (const url of process.argv.slice(1)) console.log(await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text());`,
            "http://sandy-proxy-test.invalid/",
            `http://127.0.0.1:${port(direct)}/`,
          ],
          { env: launchEnv, timeout: 10000 },
        );
        expect(result.stdout.trim().split("\n")).toEqual(["proxied", "direct"]);
        expect(nodeNetworkArgs(launchEnv)).toEqual([
          "--use-system-ca",
          "--use-env-proxy",
        ]);
        expect(launchEnv.NODE_USE_ENV_PROXY).toBeUndefined();
        expect(launchEnv.NODE_USE_SYSTEM_CA).toBeUndefined();
      } finally {
        proxy.closeAllConnections();
        direct.closeAllConnections();
        await Promise.all(
          [proxy, direct].map(
            (server) =>
              new Promise<void>((resolve) => server.close(() => resolve())),
          ),
        );
      }
    },
  );

  it("preserves explicit network opt-outs and extra CA configuration", () => {
    const env = createDaemonEnv({
      context: createTestStartContext(),
      serverUrl: "http://127.0.0.1:38886",
      env: {
        NODE_USE_ENV_PROXY: "0",
        NODE_USE_SYSTEM_CA: "0",
        NODE_EXTRA_CA_CERTS: "/company.pem",
      },
    });
    expect(env).toMatchObject({
      NODE_USE_ENV_PROXY: "0",
      NODE_USE_SYSTEM_CA: "0",
      NODE_EXTRA_CA_CERTS: "/company.pem",
    });
    expect(nodeNetworkArgs(env)).toEqual([]);
  });
});
