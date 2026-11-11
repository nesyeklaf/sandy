import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViewOutput } from "./core/outputs.ts";
import plugin from "./server.ts";
import { expected, FIXTURE_COMMIT, FIXTURE_NOW, SHOP, tempCopy, withoutText } from "./test/fixture.ts";

const BIN = process.env.HOLON_BIN;
const run = BIN !== undefined && BIN !== "" && existsSync(BIN);
const SKIPPED = "real-binary suite skipped: set HOLON_BIN to a holon binary (cargo install --path holon-cli from github.com/nesyeklaf/holons)";

if (!run) console.warn(SKIPPED);

describe.skipIf(!run)("sandy holon against the real holon binary", () => {
  const at = ["--now", FIXTURE_NOW, "--commit", FIXTURE_COMMIT];
  const cleanups: (() => void)[] = [];
  let host: ReturnType<typeof createFakePluginHost>;
  let dataHome: string;
  let savedData: string | undefined;

  function holon(...args: string[]): string {
    return execFileSync(BIN!, args, { encoding: "utf8", env: { ...process.env, XDG_DATA_HOME: dataHome } });
  }

  async function sandy(...args: string[]) {
    return host.harness.runCli(args, {});
  }

  function shop() {
    const copy = tempCopy(SHOP);
    cleanups.push(copy.dispose);
    return copy.dir;
  }

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "holon-data-"));
    savedData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    host = createFakePluginHost({ pluginId: "holon" });
    await plugin(host.sandy);
  });

  afterAll(async () => {
    await host.harness.lifecycle.dispose();
    if (savedData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedData;
    for (const cleanup of cleanups) cleanup();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("answers check, drift and view like expected/*.json after recording evidence.jsonl", async () => {
    const root = shop();
    const recorded = await sandy("evidence", "record", "--file", join(root, "evidence.jsonl"), "--root", root, ...at, "--json");
    expect({ exitCode: recorded.exitCode, stderr: recorded.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(recorded.stdout)).toMatchObject({ format: "holon-evidence-recorded/v0", unknownHolons: [] });

    const check = await sandy("check", "--root", root, ...at, "--json");
    expect({ exitCode: check.exitCode, stderr: check.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(withoutText(JSON.parse(check.stdout))).toEqual(withoutText(expected("check.json")));
    const drift = await sandy("drift", "--root", root, ...at, "--json");
    expect(withoutText(JSON.parse(drift.stdout))).toEqual(withoutText(expected("drift.json")));
    for (const slug of ["password-reset", "account", "sign-in"]) {
      const view = await sandy("view", slug, "--root", root, ...at, "--json");
      expect(withoutText(JSON.parse(view.stdout))).toEqual(withoutText(expected(`view-${slug}.json`)));
    }
  });

  it("prints the same JSON as the holon CLI itself", async () => {
    const viaPlugin = shop();
    const viaCli = shop();
    holon("evidence", "import", join(viaCli, "evidence.jsonl"), "--root", viaCli, ...at);
    await sandy("evidence", "record", "--file", join(viaPlugin, "evidence.jsonl"), "--root", viaPlugin, ...at);
    for (const args of [["check"], ["drift"], ["view", "sign-in"], ["view", "account"]]) {
      const own = holon(...args, "--root", viaCli, ...at, "--json");
      const wrapped = await sandy(...args, "--root", viaPlugin, ...at, "--json");
      expect({ exitCode: wrapped.exitCode, stderr: wrapped.stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(wrapped.stdout)).toEqual(JSON.parse(own));
    }
  });

  it("prints text with the light glyphs", async () => {
    const root = shop();
    await sandy("evidence", "record", "--file", join(root, "evidence.jsonl"), "--root", root, ...at);
    const check = await sandy("check", "--root", root, ...at);
    expect(check.stdout).toContain("● 21 holons, 0 errors, 1 warning");
    const drift = await sandy("drift", "--root", root, ...at);
    expect(drift.stdout).toContain("◇ 6 drifts");
    expect(drift.stdout).toContain("◇ account  contradiction  seam user-db");
    const view = await sandy("view", "password-reset", "--root", root, ...at);
    expect(view.stdout).toMatch(/^◇ /);
  });

  it("exits 1 with the errors when a holon file is broken", async () => {
    const root = shop();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "broken.holon"), "{ not json");
    const check = await sandy("check", "--root", root, ...at, "--json");
    expect(check.exitCode).toBe(1);
    const own = JSON.parse(check.stdout) as { errors: { file: string }[] };
    expect(own.errors.some((error) => error.file.endsWith("broken.holon"))).toBe(true);
    const text = await sandy("check", "--root", root, ...at);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain("✕");
  });

  it("fails an unknown holon with the not-found message and hint", async () => {
    const root = shop();
    const view = await sandy("view", "no-such-holon", "--root", root, ...at);
    expect(view.exitCode).not.toBe(0);
    expect(view.stderr).toContain("no-such-holon");
  });

  it("rejects evidence that is no complete record", async () => {
    const root = shop();
    const result = await sandy("evidence", "record", "--jsonl", '{"holon":"sign-in"}', "--root", root, ...at);
    expect(result.exitCode).not.toBe(0);
  });

  it("writes a confirmation file like the holon CLI and the view then shows it", async () => {
    const viaPlugin = shop();
    const viaCli = shop();
    const args = ["confirm", "sign-in", "--side", "We", "--by", "agent:test", "--answer", "Users sign in without help.", "--hesitation", "mobile is slow", ...at, "--json"];
    const own = JSON.parse(holon(...args, "--root", viaCli)) as Record<string, unknown>;
    const wrapped = await sandy(...args, "--root", viaPlugin);
    expect({ exitCode: wrapped.exitCode, stderr: wrapped.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const result = JSON.parse(wrapped.stdout) as Record<string, unknown>;
    expect(result.format).toBe("holon-confirmed/v0");
    expect(withoutText(result)).toEqual(withoutText(own));
    const file = String(result.path);
    expect(existsSync(join(viaPlugin, file))).toBe(true);
    expect(readFileSync(join(viaPlugin, file), "utf8")).toContain("Users sign in without help.");
    const view = await sandy("view", "sign-in", "--root", viaPlugin, ...at, "--json");
    expect((JSON.parse(view.stdout) as ViewOutput).focus.sides.We).toMatchObject({ light: "soft", kind: "confirmation", by: "agent:test" });
    const text = await sandy("confirm", "sign-in", "--side", "We", "--by", "agent:other", "--answer", "Again.", ...at, "--root", viaPlugin);
    expect({ exitCode: text.exitCode, stderr: text.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(text.stdout).toContain("sign-in");
  });
});
