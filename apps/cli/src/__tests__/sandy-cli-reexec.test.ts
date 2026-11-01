import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SANDY_CLI_REEXEC_ENV,
  maybeReexecViaSandyCli,
  resolveSandyCliLaunch,
} from "../sandy-cli-reexec.js";

describe("maybeReexecViaSandyCli", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sandy-cli-reexec-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeExecutable(name: string): Promise<string> {
    const path = join(tempRoot, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  }

  it("no-ops when SANDY_CLI is unset", () => {
    const reexec = vi.fn();
    maybeReexecViaSandyCli({
      env: {},
      currentExecutablePath: "/tmp/current-sandy",
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when SANDY_CLI equals the current executable", async () => {
    const path = await writeExecutable("sandy");
    const reexec = vi.fn();
    maybeReexecViaSandyCli({
      env: { SANDY_CLI: path },
      currentExecutablePath: path,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when already in a re-exec hop", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaSandyCli({
      env: { SANDY_CLI: target, [SANDY_CLI_REEXEC_ENV]: "1" },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("re-execs to SANDY_CLI when it differs from the current entry", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaSandyCli({
      env: { SANDY_CLI: target, SANDY_SERVER_URL: "http://127.0.0.1:1" },
      currentExecutablePath: current,
      argv: ["status", "--json"],
      reexec,
    });
    expect(reexec).toHaveBeenCalledOnce();
    expect(reexec.mock.calls[0]?.[0]).toEqual({
      target: realpathSync(target),
      argv: ["status", "--json"],
      env: expect.objectContaining({
        SANDY_CLI: target,
        SANDY_SERVER_URL: "http://127.0.0.1:1",
        [SANDY_CLI_REEXEC_ENV]: "1",
      }),
    });
  });

  it("no-ops when SANDY_CLI path is missing", async () => {
    const current = await writeExecutable("current");
    const reexec = vi.fn();
    maybeReexecViaSandyCli({
      env: { SANDY_CLI: join(tempRoot, "does-not-exist") },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });
});

describe("resolveSandyCliLaunch", () => {
  it("runs an extensionless SANDY_CLI script through Node on Windows", () => {
    expect(
      resolveSandyCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\sandy\\host-daemon\\dist\\sandy",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\sandy\\host-daemon\\dist\\sandy", "status"],
    });
  });

  it("executes SANDY_CLI directly when the platform can run it", () => {
    expect(
      resolveSandyCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\tools\\sandy.exe",
      }),
    ).toEqual({ command: "C:\\tools\\sandy.exe", args: ["status"] });
    expect(
      resolveSandyCliLaunch({
        argv: ["status"],
        nodePath: "/usr/bin/node",
        platform: "darwin",
        target: "/opt/sandy/host-daemon/dist/sandy",
      }),
    ).toEqual({ command: "/opt/sandy/host-daemon/dist/sandy", args: ["status"] });
  });
});
