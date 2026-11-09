import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const FAKE = fileURLToPath(new URL("./test/fake-serve.mjs", import.meta.url));
const PARENT = fileURLToPath(new URL("./test/hard-parent.mjs", import.meta.url));
const REAL = process.env.HOLON_BIN;
const FLAG = "--exit-on-stdin-close";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childrenOf(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter((line) => line !== "").map(Number);
  } catch {
    return [];
  }
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function serveSurvivesHardKill(bin: string): Promise<number[]> {
  const dir = mkdtempSync(join(tmpdir(), "holon-hard-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ready = join(dir, "ready");
  const parent = spawn(process.execPath, [PARENT, bin, dir, ready], {
    env: { ...process.env, XDG_DATA_HOME: join(dir, "data") },
    stdio: "ignore",
  });
  cleanups.push(() => parent.kill("SIGKILL"));
  expect(await until(() => existsSync(ready), 10_000)).toBe(true);
  const children = childrenOf(parent.pid!);
  expect(children).toHaveLength(1);
  cleanups.push(() => {
    for (const pid of children) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  parent.kill("SIGKILL");
  await until(() => children.every((pid) => !alive(pid)), 5000);
  return children.filter(alive);
}

function supportsExitOnStdinClose(bin: string | undefined): boolean {
  if (bin === undefined || bin === "") return false;
  try {
    return execFileSync(bin, ["serve", "--help"], { encoding: "utf8" }).includes(FLAG);
  } catch {
    return false;
  }
}

describe("a serve process whose parent is killed with SIGKILL", () => {
  it("exits by itself when the fake serve loses its parent", async () => {
    expect(await serveSurvivesHardKill(FAKE)).toEqual([]);
  });

  const real = supportsExitOnStdinClose(REAL);
  if (!real) console.warn(`hard-kill test against the real binary skipped: HOLON_BIN ${REAL === undefined ? "is unset" : `${REAL} does not list ${FLAG} in 'serve --help'`}`);

  it.skipIf(!real)("exits by itself when the real holon serve loses its parent", async () => {
    expect(await serveSurvivesHardKill(REAL!)).toEqual([]);
  });
});
