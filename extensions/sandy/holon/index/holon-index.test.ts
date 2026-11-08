import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { HolonIndex } from "./holon-index.ts";
import { Model } from "../core/model.ts";
import type { EvalEnv } from "../core/evaluate.ts";
import { expected, fixtureEnv, noGit, SHOP, shopEvidence } from "../test/fixture.ts";
import { memoryDatabase, tempCopy } from "../test/temp.ts";

function sameAsCore(index: HolonIndex, root: string, env: EvalEnv): void {
  const model = Model.load(root, shopEvidence());
  const drift = model.drift(env);
  expect(index.drift()).toEqual(drift);
  expect(index.check()).toEqual(model.check());
  expect(index.size()).toBe(model.holons.size);
  for (const id of model.holons.keys()) expect(index.view(id)).toEqual(model.view(id, env));
}

function editHolon(root: string, path: string, change: (json: Record<string, unknown>) => void): void {
  const file = join(root, path);
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
}

describe("HolonIndex", () => {
  let copy: { dir: string; dispose(): void };
  let db: Database.Database;
  let index: HolonIndex;

  beforeEach(() => {
    copy = tempCopy(SHOP);
    db = memoryDatabase();
    index = new HolonIndex(db, copy.dir, noGit);
    index.recordEvidence(shopEvidence(), fixtureEnv);
    index.refresh(fixtureEnv);
  });

  afterEach(() => {
    db.close();
    copy.dispose();
  });

  it("serves the expected fixture outputs", () => {
    expect(index.check()).toEqual(expected("check.json"));
    expect(index.drift()).toEqual(expected("drift.json"));
    for (const slug of ["password-reset", "account", "sign-in"]) expect(index.view(slug)).toEqual(expected(`view-${slug}.json`));
  });

  it("agrees with the core model for every holon", () => {
    sameAsCore(index, copy.dir, fixtureEnv);
  });

  it("reparses nothing when nothing changed", () => {
    const stats = index.refresh(fixtureEnv);
    expect(stats.reparsed).toBe(0);
    expect(stats.evaluated).toBe(0);
  });

  it("reparses one edited file and keeps the rest", () => {
    editHolon(copy.dir, "apps/account/reset-mail.holon", (json) => {
      json.title = "Reset mail, renamed";
    });
    const stats = index.reindexPaths(["apps/account/reset-mail.holon"], fixtureEnv);
    expect(stats.reparsed).toBe(1);
    expect(index.get("reset-mail")?.holon.title).toBe("Reset mail, renamed");
    sameAsCore(index, copy.dir, fixtureEnv);
  });

  it("moves driftBelow when a holon with drift changes its parent", () => {
    const below = (id: string) => index.get(id)!.driftBelow;
    const moved = below("reset-mail");
    const before = { account: below("account"), passwordReset: below("password-reset"), signIn: below("sign-in") };
    expect(moved).toBeGreaterThan(0);
    editHolon(copy.dir, "apps/account/reset-mail.holon", (json) => {
      json.partOf = "sign-in";
    });
    index.refresh(fixtureEnv);
    expect(below("account")).toBe(before.account);
    expect(below("password-reset")).toBe(before.passwordReset - moved);
    expect(below("sign-in")).toBe(before.signIn + moved);
    sameAsCore(index, copy.dir, fixtureEnv);
  });

  it("follows added, removed and duplicated holons", () => {
    rmSync(join(copy.dir, "apps/account/reset-rate-limit.holon"));
    const extra = join(copy.dir, "apps/account/extra/reset-audit.holon");
    mkdirSync(dirname(extra), { recursive: true });
    const base = JSON.parse(readFileSync(join(copy.dir, "apps/account/reset-token.holon"), "utf8")) as Record<string, unknown>;
    writeFileSync(extra, JSON.stringify({ ...base, id: "reset-audit", title: "Reset audit", status: "proposed", why: "" }));
    writeFileSync(join(copy.dir, "apps/account/extra/reset-token.holon"), JSON.stringify(base));
    index.refresh(fixtureEnv);
    sameAsCore(index, copy.dir, fixtureEnv);
    expect(index.check().errors.map((error) => error.message)).toContainEqual(expect.stringContaining("duplicate id reset-token"));
    rmSync(join(copy.dir, "apps/account/extra"), { recursive: true });
    index.refresh(fixtureEnv);
    sameAsCore(index, copy.dir, fixtureEnv);
  });

  it("finds a new contradiction when another holon starts writing to an exclusive target", () => {
    editHolon(copy.dir, "apps/search/search.holon", (json) => {
      json.seams = [{ to: "user-db", contract: "Writes search history" }];
    });
    index.refresh(fixtureEnv);
    const contradiction = index.view("account")!.focus.drift.find((item) => item.kind === "contradiction");
    expect(contradiction?.detail).toContain("search");
    sameAsCore(index, copy.dir, fixtureEnv);
  });

  it("re-evaluates on a new confirmation, on time passing and on a cycle", () => {
    const confirmations = join(copy.dir, ".holons/confirmations/sign-in");
    const source = readFileSync(join(confirmations, "2026-10-20-I-maria.json"), "utf8");
    const confirmation = JSON.parse(source) as Record<string, unknown>;
    writeFileSync(
      join(confirmations, "2026-11-01-I-maria.json"),
      JSON.stringify({ ...confirmation, at: "2026-11-01", result: "refuted", answer: "Not any more" }),
    );
    index.refresh(fixtureEnv);
    expect(index.view("sign-in")!.focus.sides.I.light).toBe("refuted");
    sameAsCore(index, copy.dir, fixtureEnv);
    const later: EvalEnv = { ...fixtureEnv, nowMs: Date.parse("2027-06-01T00:00:00Z") };
    index.refresh(later);
    sameAsCore(index, copy.dir, later);
    editHolon(copy.dir, "apps/account/account.holon", (json) => {
      json.partOf = "reset-token";
    });
    const stats = index.refresh(later);
    expect(stats.fullRollUp).toBe(true);
    sameAsCore(index, copy.dir, later);
  });
});

