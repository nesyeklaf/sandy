import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./server.ts";

const FAKE = fileURLToPath(new URL("./test/fake-serve.mjs", import.meta.url));

const disposers: (() => Promise<void> | void)[] = [];
const saved = { bin: process.env.HOLON_BIN, path: process.env.PATH };

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!();
  for (const [name, value] of [["HOLON_BIN", saved.bin], ["PATH", saved.path]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function loaded() {
  const host = createFakePluginHost({ pluginId: "holon" });
  await plugin(host.sandy);
  disposers.push(() => host.harness.lifecycle.dispose());
  return host;
}

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holon-server-"));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("sandy holon with a fake holon serve", () => {
  it("exits 1 with the check output when serve answers 422", async () => {
    process.env.HOLON_BIN = FAKE;
    const host = await loaded();
    const dir = workDir();
    const broken = await host.harness.runCli(["check", "--root", dir, "--commit", "broken", "--json"], {});
    expect(broken.exitCode).toBe(1);
    expect(JSON.parse(broken.stdout)).toMatchObject({ format: "holon-check/v0", errors: [{ file: "a.holon" }] });
    const text = await host.harness.runCli(["check", "--root", dir, "--commit", "broken"], {});
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain("✕ a.holon: invalid JSON");
    const clean = await host.harness.runCli(["check", "--root", dir], {});
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain("● 1 holon, 0 errors");
  });

  it("reads --file in the plugin and posts it as JSONL", async () => {
    process.env.HOLON_BIN = FAKE;
    const host = await loaded();
    const dir = workDir();
    writeFileSync(join(dir, "evidence.jsonl"), '{"a":1}\n{"b":2}\n');
    const recorded = await host.harness.runCli(["evidence", "record", "--file", "evidence.jsonl", "--root", dir, "--json"], { cwd: dir });
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ recorded: 2, contentType: "application/x-ndjson" });
    const text = await host.harness.runCli(["evidence", "record", "--jsonl", '{"a":1}', "--root", dir], {});
    expect(text.stdout).toBe("● recorded 1 evidence record, 1 holons re-evaluated\n");
    const missing = await host.harness.runCli(["evidence", "record", "--file", "nope.jsonl", "--root", dir], { cwd: dir });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("cannot read nope.jsonl");
  });

  it("reports a 413 from serve as body_too_large with the standalone import hint", async () => {
    process.env.HOLON_BIN = FAKE;
    process.env.FAKE_BODY_LIMIT = "100";
    disposers.push(() => {
      delete process.env.FAKE_BODY_LIMIT;
    });
    const host = await loaded();
    const dir = workDir();
    const result = await host.harness.runCli(["evidence", "record", "--jsonl", "x".repeat(500), "--root", dir], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("the body is larger than 64 MB");
    expect(result.stderr).toContain("holon evidence import --file");
  });

  it("refuses the flag form of evidence record and --replace, which holon serve cannot take", async () => {
    process.env.HOLON_BIN = FAKE;
    const host = await loaded();
    const dir = workDir();
    const flags = await host.harness.runCli(["evidence", "record", "--holon", "sign-in", "--side", "It", "--result", "pass", "--root", dir], {});
    expect(flags.exitCode).not.toBe(0);
    expect(flags.stderr).toContain("--holon has no equivalent in holon serve");
    expect(flags.stderr).toContain("--file or --jsonl");
    const replace = await host.harness.runCli(["evidence", "record", "--file", "x.jsonl", "--replace", "--root", dir], {});
    expect(replace.exitCode).not.toBe(0);
    expect(replace.stderr).toContain("--replace has no equivalent in holon serve");
  });

  it("maps a serve error envelope to a coded CLI error", async () => {
    process.env.HOLON_BIN = FAKE;
    const host = await loaded();
    const result = await host.harness.runCli(["view", "sign-in", "--root", workDir()], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no route GET /v0/holons/sign-in");
    expect(result.stderr).toContain("fake hint");
  });

  it("fails with holon_not_installed and its hint when there is no binary", async () => {
    delete process.env.HOLON_BIN;
    process.env.PATH = "/nonexistent";
    const host = await loaded();
    const result = await host.harness.runCli(["check", "--root", workDir()], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("the holon binary is not installed");
    expect(result.stderr).toContain("HOLON_BIN");
    expect(result.stderr).toContain("cargo install --path holon-cli");
  });

  it("rejects a --root that is no directory before it starts any process", async () => {
    process.env.HOLON_BIN = "/nonexistent/holon";
    const host = await loaded();
    const result = await host.harness.runCli(["check", "--root", "/nonexistent/dir"], {});
    expect(result.stderr).toContain("--root /nonexistent/dir is no directory");
  });

  it("kills the serve processes when the plugin is disposed", async () => {
    process.env.HOLON_BIN = FAKE;
    const host = await loaded();
    const dirs = [workDir(), workDir()];
    for (const dir of dirs) expect((await host.harness.runCli(["check", "--root", dir], {})).exitCode).toBe(0);
    const running = () => dirs.flatMap((dir) => pgrep(dir));
    expect(running()).toHaveLength(2);
    await host.harness.lifecycle.dispose();
    expect(running()).toEqual([]);
  });
});

function pgrep(dir: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", "--", `--root ${dir} `], { encoding: "utf8" }).split("\n").filter((line) => line !== "").map(Number);
  } catch {
    return [];
  }
}
