import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { PathLike } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  readSandyAppRuntimeFile,
  writeSandyAppRuntimeFile,
} from "@sandy/config/app-runtime-file";
import { expect, it, vi } from "vitest";
import { runSandyApp } from "../src/launcher.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const artifacts = new Set([
    "daemon-bundle.mjs",
    "sandy",
    "sandy-provider-bridge-worker.mjs",
    "sandy-parcel-watcher-child.mjs",
    "sandy-plugin-host-worker.mjs",
    "index.js",
    "index.html",
  ]);
  return {
    ...actual,
    existsSync: (filePath: PathLike) =>
      (typeof filePath === "string" && artifacts.has(basename(filePath))) ||
      actual.existsSync(filePath),
    readdirSync: (filePath: PathLike) =>
      typeof filePath === "string" && basename(filePath) === "sandy-chunks"
        ? ["chunk.js"]
        : actual.readdirSync(filePath),
  };
});

it.each([
  { liveOwner: true, healthy: true, shouldStart: false },
  { liveOwner: true, healthy: false, shouldStart: true },
  { liveOwner: false, healthy: true, shouldStart: true },
])(
  "startup with live owner=$liveOwner and healthy=$healthy attempts server=$shouldStart",
  async ({ liveOwner, healthy, shouldStart }) => {
    const dataDir = await mkdtemp(join(tmpdir(), "sandy-startup-owner-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: healthy }));
    });
    const previousExitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const beforeServerStart = vi.fn(() => {
      throw new Error("Startup reached the server launch boundary");
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }
      if (liveOwner) {
        await writeSandyAppRuntimeFile({
          dataDir,
          entryPath: process.execPath,
          pid: process.ppid,
          serverUrl: `http://127.0.0.1:${address.port}`,
          startedAt: new Date().toISOString(),
          surface: "web",
          version: "0.0.0-test",
        });
      }
      const recordBefore = await readSandyAppRuntimeFile(dataDir);
      await runSandyApp(
        [
          "start",
          "--data-dir",
          dataDir,
          "--server-port",
          String(address.port),
          "--host-daemon-port",
          String(address.port),
        ],
        { beforeServerStart, worktreePolicy: null },
      );
      expect(beforeServerStart).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
      expect(process.exitCode).toBe(1);
      expect(await readSandyAppRuntimeFile(dataDir)).toEqual(recordBefore);
    } finally {
      process.exitCode = previousExitCode;
      output.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
