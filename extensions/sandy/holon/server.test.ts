import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./server.ts";
import { contractHash } from "./core/time.ts";
import { expected, FIXTURE_COMMIT, FIXTURE_NOW, SHOP, withoutText } from "./test/fixture.ts";
import { tempCopy, tempDir } from "./test/temp.ts";

const disposers: (() => void)[] = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

async function loaded() {
  const host = createFakePluginHost({ pluginId: "holon" });
  await plugin(host.sandy);
  disposers.push(() => void host.harness.lifecycle.dispose());
  return host;
}

function track<T extends { dispose(): void }>(value: T): T {
  disposers.push(() => value.dispose());
  return value;
}

async function cli(host: Awaited<ReturnType<typeof loaded>>, argv: string[], cwd?: string) {
  const result = await host.harness.runCli(argv, cwd === undefined ? {} : { cwd });
  return { ...result, json: argv.includes("--json") && result.stdout !== "" ? (JSON.parse(result.stdout) as Record<string, unknown>) : null };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

function holonJson(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      format: "holon/v0",
      id,
      kind: "operation",
      partOf: null,
      title: id,
      status: "active",
      why: "Because a test asks for it.",
      contract: `${id} keeps its promise.`,
      carriedBy: [],
      code: [],
      seams: [],
      proofs: {},
      ...extra,
    },
    null,
    2,
  );
}

describe("sandy holon on the shop fixture", () => {
  const at = ["--now", FIXTURE_NOW, "--commit", FIXTURE_COMMIT];

  it("records evidence.jsonl and then answers like expected/*.json", async () => {
    const host = await loaded();
    const shop = track(tempCopy(SHOP));
    const record = await cli(host, ["evidence", "record", "--file", join(shop.dir, "evidence.jsonl"), "--root", shop.dir, ...at, "--json"]);
    expect(record.exitCode).toBe(0);
    expect(record.json).toMatchObject({ format: "holon-evidence-recorded/v0", unknownHolons: [] });
    const check = await cli(host, ["check", "--root", shop.dir, ...at, "--json"]);
    expect(check.exitCode).toBe(0);
    expect(withoutText(check.json)).toEqual(withoutText(expected("check.json")));
    const drift = await cli(host, ["drift", "--root", shop.dir, ...at, "--json"]);
    expect(withoutText(drift.json)).toEqual(withoutText(expected("drift.json")));
    for (const slug of ["password-reset", "account", "sign-in"]) {
      const view = await cli(host, ["view", slug, "--root", shop.dir, ...at, "--json"]);
      expect(withoutText(view.json)).toEqual(withoutText(expected(`view-${slug}.json`)));
    }
  });

  it("prints text with the light glyphs", async () => {
    const host = await loaded();
    const shop = track(tempCopy(SHOP));
    await cli(host, ["evidence", "record", "--file", "evidence.jsonl", ...at], shop.dir);
    const check = await cli(host, ["check", "--root", shop.dir, ...at]);
    expect(check.stdout).toContain("● 21 holons, 0 errors, 1 warning");
    const drift = await cli(host, ["drift", "--root", shop.dir, ...at]);
    expect(drift.stdout).toContain("◇ 6 drifts");
    expect(drift.stdout).toContain("◇ account  contradiction  seam user-db");
    const view = await cli(host, ["view", "password-reset", "--root", shop.dir, ...at]);
    expect(view.stdout).toMatch(/^◇ /);
    expect(view.stdout).toContain("Parts:");
  });

  it("fails with a JSON envelope for an unknown holon", async () => {
    const host = await loaded();
    const shop = track(tempCopy(SHOP));
    const view = await cli(host, ["view", "nope", "--root", shop.dir, ...at, "--json"]);
    expect(view.exitCode).not.toBe(0);
    expect(view.json).toMatchObject({ ok: false, error: { code: "holon_not_found" } });
  });

  it("fills evidence from the declared proof and clears the expired side", async () => {
    const host = await loaded();
    const shop = track(tempCopy(SHOP));
    await cli(host, ["evidence", "record", "--file", "evidence.jsonl", ...at], shop.dir);
    const record = await cli(host, ["evidence", "record", "--holon", "reset-mail", "--side", "It", "--result", "pass", "--detail", "rerun", "--root", shop.dir, ...at]);
    expect(record.exitCode).toBe(0);
    const view = await cli(host, ["view", "reset-mail", "--root", shop.dir, ...at, "--json"]);
    const focus = view.json!.focus as { sides: { It: { light: string; kind: string; detail: string } }; drift: unknown[] };
    expect(focus.sides.It).toMatchObject({ light: "hard", kind: "ci", detail: "rerun" });
    const drift = await cli(host, ["drift", "--root", shop.dir, ...at, "--json"]);
    expect((drift.json!.drift as { holon: string }[]).map((item) => item.holon)).not.toContain("reset-mail");
  });

  it("writes a confirmation file and refuses a second one for the same day", async () => {
    const host = await loaded();
    const shop = track(tempCopy(SHOP));
    await cli(host, ["evidence", "record", "--file", "evidence.jsonl", ...at], shop.dir);
    const args = ["confirm", "password-reset", "--side", "I", "--by", "maria", "--recorded-by", "agent:they-side", "--answer", "I get the mail within a minute.", "--hesitation", "Only tried on Gmail", "--root", shop.dir, ...at, "--json"];
    const first = await cli(host, args);
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ path: ".holons/confirmations/password-reset/2026-11-08-I-maria.json" });
    expect(["soft", "claimed"]).toContain(first.json!.light);
    const written = JSON.parse(readFileSync(join(shop.dir, ".holons/confirmations/password-reset/2026-11-08-I-maria.json"), "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({ format: "holon-confirmation/v0", expires: "2027-02-06", hesitation: ["Only tried on Gmail"], result: "confirmed" });
    const view = await cli(host, ["view", "password-reset", "--root", shop.dir, ...at, "--json"]);
    expect((view.json!.focus as { sides: { I: { by: string; at: string } } }).sides.I).toMatchObject({ by: "maria", at: "2026-11-08" });
    const second = await cli(host, args);
    expect(second.json).toMatchObject({ ok: false, error: { code: "confirmation_exists" } });
    const machine = await cli(host, ["confirm", "password-reset", "--side", "They", "--by", "maria", "--answer", "x", "--root", shop.dir, ...at, "--json"]);
    expect(machine.json).toMatchObject({ ok: false, error: { code: "machine_side" } });
  });

  it("serves the fileOpener view over RPC", async () => {
    const host = await loaded();
    const shop = track(tempCopy(SHOP));
    const result = (await host.harness.callRpc("view", {
      source: { kind: "host", threadId: "thread-test", environmentId: null },
      path: join(shop.dir, "apps/account/password-reset.holon"),
    })) as { ok: boolean; view?: { focus: { id: string } } };
    expect(result.ok).toBe(true);
    expect(result.view?.focus.id).toBe("password-reset");
  });
});

describe("sandy holon in a Git repository", () => {
  function repo() {
    const temp = track(tempDir());
    git(temp.dir, "init", "-q", "-b", "main");
    return temp.dir;
  }

  it("expires machine evidence when a path in code changed since its build", async () => {
    const host = await loaded();
    const dir = repo();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/token.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "README.md"), "hi\n");
    writeFileSync(join(dir, "token.holon"), holonJson("token", { code: ["src/token.ts"], proofs: { It: { kind: "ci", source: "src/token.test.ts" } } }));
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "one");
    const first = git(dir, "rev-parse", "HEAD");
    await cli(host, ["evidence", "record", "--holon", "token", "--side", "It", "--result", "pass", "--root", dir]);
    const light = async () => {
      const view = await cli(host, ["view", "token", "--root", dir, "--json"]);
      return (view.json!.focus as { sides: { It: { light: string; detail: string } } }).sides.It;
    };
    expect(await light()).toMatchObject({ light: "hard" });
    writeFileSync(join(dir, "README.md"), "changed\n");
    git(dir, "commit", "-qam", "two");
    expect(await light()).toMatchObject({ light: "hard" });
    writeFileSync(join(dir, "src/token.ts"), "export const a = 2;\n");
    git(dir, "commit", "-qam", "three");
    expect(await light()).toMatchObject({ light: "expired", detail: expect.stringContaining("src/token.ts") });
    const back = await cli(host, ["view", "token", "--root", dir, "--commit", first, "--json"]);
    expect((back.json!.focus as { sides: { It: { light: string } } }).sides.It.light).toBe("hard");
    await cli(host, ["evidence", "record", "--holon", "token", "--side", "It", "--result", "pass", "--build", "0123456789abcdef0123456789abcdef01234567", "--root", dir]);
    expect(await light()).toMatchObject({ light: "expired", detail: expect.stringContaining("no known commit") });
  });

  it.each(["src/über.ts", "src/line\nbreak.ts"])("expires machine evidence when %j changed, a path Git quotes", async (path) => {
    const host = await loaded();
    const dir = repo();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, path), "export const a = 1;\n");
    writeFileSync(join(dir, "token.holon"), holonJson("token", { code: [path], proofs: { It: { kind: "ci", source: "src/token.test.ts" } } }));
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "one");
    await cli(host, ["evidence", "record", "--holon", "token", "--side", "It", "--result", "pass", "--root", dir]);
    writeFileSync(join(dir, path), "export const a = 2;\n");
    git(dir, "commit", "-qam", "two");
    const view = await cli(host, ["view", "token", "--root", dir, "--json"]);
    expect((view.json!.focus as { sides: { It: { light: string } } }).sides.It.light).toBe("expired");
  });

  it("merges confirmations from two branches without a conflict", async () => {
    const host = await loaded();
    const dir = repo();
    writeFileSync(join(dir, "maria.holon"), holonJson("maria", { kind: "person" }));
    writeFileSync(join(dir, "bob.holon"), holonJson("bob", { kind: "person" }));
    writeFileSync(
      join(dir, "login.holon"),
      holonJson("login", { proofs: { I: { kind: "interview" }, We: { kind: "confirmation" } } }),
    );
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    const now = ["--now", "2026-11-08T12:00:00Z"];
    git(dir, "checkout", "-qb", "a");
    expect((await cli(host, ["confirm", "login", "--side", "I", "--by", "maria", "--answer", "Works", "--root", dir, ...now])).exitCode).toBe(0);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "maria confirms");
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-qb", "b");
    expect((await cli(host, ["confirm", "login", "--side", "We", "--by", "bob", "--answer", "We rely on it", "--root", dir, ...now])).exitCode).toBe(0);
    expect((await cli(host, ["confirm", "login", "--side", "I", "--by", "bob", "--answer", "Works for me too", "--root", dir, ...now])).exitCode).toBe(0);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "bob confirms");
    git(dir, "checkout", "-q", "a");
    git(dir, "merge", "-q", "--no-edit", "b");
    expect(git(dir, "status", "--porcelain")).toBe("");
    for (const file of ["2026-11-08-I-maria.json", "2026-11-08-I-bob.json", "2026-11-08-We-bob.json"]) {
      expect(existsSync(join(dir, ".holons/confirmations/login", file))).toBe(true);
    }
    const check = await cli(host, ["check", "--root", dir, ...now, "--json"]);
    expect(check.json).toMatchObject({ holons: 3, errors: [], warnings: [] });
    const view = await cli(host, ["view", "login", "--root", dir, ...now, "--json"]);
    const sides = (view.json!.focus as { sides: Record<string, { light: string; by: string }> }).sides;
    expect(sides.I).toMatchObject({ light: "soft", by: "maria" });
    expect(sides.We).toMatchObject({ light: "soft", by: "bob" });
  });
});
