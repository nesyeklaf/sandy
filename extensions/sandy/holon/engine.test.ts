import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HolonEngine } from "./engine.ts";
import { HolonError } from "./error.ts";

const FAKE = fileURLToPath(new URL("./test/fake-serve.mjs", import.meta.url));

interface Info {
  pid: number;
  root: string;
  token: string;
  address: number;
}

const engines: HolonEngine[] = [];
const dirs: string[] = [];
const saved = { mode: process.env.FAKE_MODE, marker: process.env.FAKE_CRASH_MARKER, pidLog: process.env.FAKE_PID_LOG, path: process.env.PATH, bin: process.env.HOLON_BIN };

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of [["FAKE_MODE", saved.mode], ["FAKE_CRASH_MARKER", saved.marker], ["FAKE_PID_LOG", saved.pidLog], ["PATH", saved.path], ["HOLON_BIN", saved.bin]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function engine(options: ConstructorParameters<typeof HolonEngine>[0] = { bin: FAKE }): HolonEngine {
  const created = new HolonEngine(options);
  engines.push(created);
  return created;
}

async function info(target: HolonEngine, root: string): Promise<Info> {
  const reply = await target.call(root, { method: "GET", path: "/v0/info" });
  return JSON.parse(reply.text) as Info;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "holon-engine-"));
  dirs.push(dir);
  const log = join(dir, "pids");
  process.env.FAKE_PID_LOG = log;
  return log;
}

function pidsIn(log: string): number[] {
  try {
    return readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map(Number);
  } catch {
    return [];
  }
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function failure(promise: Promise<unknown>): Promise<HolonError> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(HolonError);
    return cause as HolonError;
  }
  throw new Error("expected the call to fail");
}

describe("HolonEngine without a binary", () => {
  it("names HOLON_BIN and the holons repository when the configured binary is missing", async () => {
    const error = await failure(engine({ bin: "/nonexistent/holon" }).call("/tmp", { method: "GET", path: "/v0/check" }));
    expect(error.code).toBe("holon_not_installed");
    expect(error.message).toContain("/nonexistent/holon");
    expect(error.hint).toContain("HOLON_BIN");
    expect(error.hint).toContain("nesyeklaf/holons");
    expect(error.hint).toContain("cargo install --path holon-cli");
  });

  it("looks for holon on PATH when HOLON_BIN is unset", async () => {
    delete process.env.HOLON_BIN;
    process.env.PATH = "/nonexistent";
    const error = await failure(engine({}).call("/tmp", { method: "GET", path: "/v0/check" }));
    expect(error.code).toBe("holon_not_installed");
    expect(error.hint).toContain("HOLON_BIN");
  });

  it("reads HOLON_BIN from the environment at call time", async () => {
    process.env.HOLON_BIN = FAKE;
    const reply = await engine({}).call("/tmp", { method: "GET", path: "/v0/check" });
    expect(reply.status).toBe(200);
  });
});

describe("HolonEngine start", () => {
  it("fails with the stderr tail when no address appears in time, and kills the process", async () => {
    process.env.FAKE_MODE = "hang";
    const error = await failure(engine({ bin: FAKE, startTimeoutMs: 300 }).call("/tmp", { method: "GET", path: "/v0/check" }));
    expect(error.code).toBe("holon_start_timeout");
    expect(error.message).toContain("fake holon: still waiting");
  });

  it("fails with the stderr tail when the process exits before it is ready", async () => {
    process.env.FAKE_MODE = "die";
    const error = await failure(engine().call("/tmp", { method: "GET", path: "/v0/check" }));
    expect(error.code).toBe("holon_start_failed");
    expect(error.message).toContain("fake holon: boom");
  });

  it("tries again on the next call after a failed start", async () => {
    process.env.FAKE_MODE = "die";
    const target = engine();
    await failure(target.call("/tmp", { method: "GET", path: "/v0/check" }));
    process.env.FAKE_MODE = "ok";
    expect((await target.call("/tmp", { method: "GET", path: "/v0/check" })).status).toBe(200);
  });
});

describe("HolonEngine processes", () => {
  it("serves each root from its own process with its own token, and starts it once", async () => {
    const target = engine();
    const [first, again, other] = [await info(target, "/tmp/a"), await info(target, "/tmp/a"), await info(target, "/tmp/b")];
    expect(first.pid).toBe(again.pid);
    expect(first.root).toBe("/tmp/a");
    expect(other.pid).not.toBe(first.pid);
    expect(other.root).toBe("/tmp/b");
    expect(first.token).toMatch(/^[0-9a-f]{48}$/);
    expect(other.token).not.toBe(first.token);
  });

  it("starts one process for concurrent first calls", async () => {
    const target = engine();
    const results = await Promise.all([info(target, "/tmp/a"), info(target, "/tmp/a"), info(target, "/tmp/a")]);
    expect(new Set(results.map((item) => item.pid)).size).toBe(1);
  });

  it("sends the bearer token, which the server refuses without", async () => {
    const target = engine();
    const served = await info(target, "/tmp/a");
    const bare = await fetch(`http://127.0.0.1:${served.address}/v0/info`);
    expect(bare.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${served.address}/v0/info`, { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("turns an error envelope into a HolonError with code and hint", async () => {
    const error = await failure(engine().call("/tmp", { method: "GET", path: "/v0/nothing" }));
    expect(error).toMatchObject({ code: "not_found", hint: "fake hint" });
  });

  it("passes a 422 answer through for the caller to read", async () => {
    const reply = await engine().call("/tmp", { method: "GET", path: "/v0/check", query: { commit: "broken" } });
    expect(reply.status).toBe(422);
    expect(JSON.parse(reply.text)).toMatchObject({ format: "holon-check/v0" });
  });

  it("restarts a process that exited on the next call", async () => {
    const target = engine();
    const first = JSON.parse((await target.call("/tmp/a", { method: "GET", path: "/v0/exit-soon" })).text) as { pid: number };
    await until(() => !alive(first.pid));
    const second = await info(target, "/tmp/a");
    expect(second.pid).not.toBe(first.pid);
  });

  it("retries once on a fresh process when the call hits a process that dies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holon-engine-"));
    dirs.push(dir);
    process.env.FAKE_CRASH_MARKER = join(dir, "marker");
    const target = engine();
    const before = await info(target, "/tmp/a");
    const reply = await target.call("/tmp/a", { method: "GET", path: "/v0/crash-once" });
    const after = JSON.parse(reply.text) as { pid: number };
    expect(after.pid).not.toBe(before.pid);
    expect(alive(before.pid)).toBe(false);
  });

  it("gives up with holon_unreachable when the retry dies too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holon-engine-"));
    dirs.push(dir);
    process.env.FAKE_CRASH_MARKER = join(dir, "never-created", "marker");
    const error = await failure(engine().call("/tmp/a", { method: "GET", path: "/v0/crash-once" }));
    expect(error.code).toBe("holon_unreachable");
  });

  it("stops every process on close and leaves no orphan", async () => {
    const target = engine();
    const pids = [(await info(target, "/tmp/a")).pid, (await info(target, "/tmp/b")).pid];
    expect(pids.every(alive)).toBe(true);
    await target.close();
    expect(pids.some(alive)).toBe(false);
  });

  it("fails a call still starting when close runs with code closed and leaves no process behind", async () => {
    const log = pidLog();
    const target = engine();
    const pending = failure(target.call("/tmp/a", { method: "GET", path: "/v0/info" }));
    await target.close();
    expect((await pending).code).toBe("closed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pidsIn(log).filter(alive)).toEqual([]);
  });

  it("fails every call after close with code closed without starting a process", async () => {
    const log = pidLog();
    const target = engine();
    await info(target, "/tmp/a");
    await target.close();
    expect((await failure(target.call("/tmp/a", { method: "GET", path: "/v0/info" }))).code).toBe("closed");
    expect((await failure(target.call("/tmp/b", { method: "GET", path: "/v0/info" }))).code).toBe("closed");
    expect(pidsIn(log)).toHaveLength(1);
    expect(pidsIn(log).filter(alive)).toEqual([]);
  });

  it("does not retry on a new process when close runs while a call is in flight", async () => {
    const log = pidLog();
    const target = engine();
    await info(target, "/tmp/a");
    const pending = failure(target.call("/tmp/a", { method: "GET", path: "/v0/slow" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await target.close();
    expect((await pending).code).toBe("closed");
    expect(pidsIn(log)).toHaveLength(1);
    expect(pidsIn(log).filter(alive)).toEqual([]);
  });

  it("waits in close until every child has exited", async () => {
    const log = pidLog();
    const target = engine();
    await Promise.all([info(target, "/tmp/a"), info(target, "/tmp/b")]);
    const starting = target.call("/tmp/c", { method: "GET", path: "/v0/info" }).catch(() => null);
    await target.close();
    expect(pidsIn(log).filter(alive)).toEqual([]);
    await starting;
  });

  it("stops an idle process and starts a new one on the next call", async () => {
    const target = engine({ bin: FAKE, idleStopMs: 150 });
    const first = await info(target, "/tmp/a");
    await until(() => !alive(first.pid));
    const second = await info(target, "/tmp/a");
    expect(second.pid).not.toBe(first.pid);
  });

  it("keeps a process that is used within the idle time", async () => {
    const target = engine({ bin: FAKE, idleStopMs: 400 });
    const first = await info(target, "/tmp/a");
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await info(target, "/tmp/a")).pid).toBe(first.pid);
    }
  });
});
