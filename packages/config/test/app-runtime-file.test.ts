import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimSandyAppRuntimeFile,
  clearOwnSandyAppRuntimeFile,
  readSandyAppRuntimeFile,
} from "../src/app-runtime-file.js";
import {
  stopVerifiedProcess,
  type VerifiedProcessOps,
} from "../src/verified-process-stop.js";

const tempDirs: string[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "sandy-runtime-file-"));
  tempDirs.push(dataDir);
  return dataDir;
}

function recordFor(dataDir: string, pid: number) {
  return {
    dataDir,
    entryPath: "/opt/sandy/sandy-app.js",
    pid,
    serverUrl: "http://127.0.0.1:38886",
    startedAt: "2026-08-03T10:00:00.000Z",
    surface: "web",
    version: "0.34.0",
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dataDir = tempDirs.pop();
    if (dataDir !== undefined) {
      await rm(dataDir, { force: true, recursive: true });
    }
  }
});

describe("claimSandyAppRuntimeFile", () => {
  it("refuses to overwrite a record whose launcher still runs", async () => {
    const dataDir = await createDataDir();
    await claimSandyAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(
      claimSandyAppRuntimeFile({
        ...recordFor(dataDir, 2_222),
        isRunning: () => true,
      }),
    ).resolves.toBe(false);
    await expect(readSandyAppRuntimeFile(dataDir)).resolves.toMatchObject({
      pid: 1_111,
    });
  });

  it("replaces a record whose launcher is gone", async () => {
    const dataDir = await createDataDir();
    await claimSandyAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(
      claimSandyAppRuntimeFile({
        ...recordFor(dataDir, 2_222),
        isRunning: () => false,
      }),
    ).resolves.toBe(true);
    await expect(readSandyAppRuntimeFile(dataDir)).resolves.toMatchObject({
      pid: 2_222,
    });
  });
});

describe("clearOwnSandyAppRuntimeFile", () => {
  it("leaves a record that belongs to another launcher", async () => {
    const dataDir = await createDataDir();
    await claimSandyAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(
      clearOwnSandyAppRuntimeFile({ dataDir, pid: 2_222 }),
    ).resolves.toBe(false);
    await expect(readSandyAppRuntimeFile(dataDir)).resolves.not.toBeNull();
  });

  it("removes its own record", async () => {
    const dataDir = await createDataDir();
    await claimSandyAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(
      clearOwnSandyAppRuntimeFile({ dataDir, pid: 1_111 }),
    ).resolves.toBe(true);
    await expect(readSandyAppRuntimeFile(dataDir)).resolves.toBeNull();
  });
});

describe("stopVerifiedProcess", () => {
  function createOps(
    overrides: Partial<VerifiedProcessOps> = {},
  ): VerifiedProcessOps {
    return {
      isRunning: () => true,
      kill: () => undefined,
      readIdentity: async () => ({
        command: "node /opt/sandy/sandy-app.js start",
        startedAt: Date.now() - 60_000,
      }),
      waitForExit: async () => true,
      ...overrides,
    };
  }

  const startedAt = new Date(Date.now() - 60_000).toISOString();

  it("reports still-running when the process survives SIGKILL", async () => {
    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        processOps: createOps({ waitForExit: async () => false }),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["sandy-app.js"],
      }),
    ).resolves.toEqual({ kind: "still-running" });
  });

  it("refuses a process whose start time contradicts the record", async () => {
    const result = await stopVerifiedProcess({
      killTimeoutMs: 10,
      pid: 4_242,
      processOps: createOps({
        readIdentity: async () => ({
          command: "node /opt/sandy/sandy-app.js start",
          startedAt: Date.now() - 172_800_000,
        }),
      }),
      signal: "SIGTERM",
      startedAt,
      timeoutMs: 10,
      verifyTokens: ["sandy-app.js"],
    });

    expect(result).toMatchObject({ kind: "unverified", reason: "start-time" });
  });

  it("refuses when the start time cannot be read at all", async () => {
    const result = await stopVerifiedProcess({
      killTimeoutMs: 10,
      pid: 4_242,
      processOps: createOps({
        readIdentity: async () => ({
          command: "node /opt/sandy/sandy-app.js start",
          startedAt: null,
        }),
      }),
      signal: "SIGTERM",
      startedAt,
      timeoutMs: 10,
      verifyTokens: ["sandy-app.js"],
    });

    expect(result).toMatchObject({ kind: "unverified", reason: "start-time" });
  });
});
