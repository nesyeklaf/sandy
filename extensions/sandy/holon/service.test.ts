import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Model } from "./core/model.ts";
import { HolonService } from "./service.ts";
import { FIXTURE_COMMIT, FIXTURE_NOW, fixtureEnv, SHOP, shopEvidence } from "./test/fixture.ts";
import { memoryDatabase, tempCopy, tempDir } from "./test/temp.ts";

const at = { now: FIXTURE_NOW, commit: FIXTURE_COMMIT };

function editJson(file: string, change: (json: Record<string, unknown>) => void): void {
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
}

describe("HolonService keeps the index current without scanning", () => {
  let copy: { dir: string; dispose(): void };
  let outside: { dir: string; dispose(): void };
  let db: Database.Database;
  let service: HolonService;

  beforeEach(async () => {
    copy = tempCopy(SHOP);
    outside = tempDir();
    db = memoryDatabase();
    service = new HolonService(db);
    const { index, env } = await service.open(copy.dir, at);
    index.recordEvidence(shopEvidence(), env);
  });

  afterEach(() => {
    service.close();
    db.close();
    copy.dispose();
    outside.dispose();
  });

  async function sameAsFreshModel(label: string): Promise<void> {
    const { index } = await service.open(copy.dir, at);
    const model = Model.load(copy.dir, shopEvidence());
    try {
      expect(index.check()).toEqual(model.check());
      expect(index.drift()).toEqual(model.drift(fixtureEnv));
      expect(index.size()).toBe(model.holons.size);
      for (const id of model.holons.keys()) expect(index.view(id)).toEqual(model.view(id, fixtureEnv));
    } catch (cause) {
      throw new Error(`after "${label}": ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  it("reads nothing from disk when nothing changed", async () => {
    const { stats } = await service.open(copy.dir, at);
    expect(stats).toMatchObject({ scanned: 0, reparsed: 0, evaluated: 0 });
  });

  it("picks up one edit by reading only that file", async () => {
    editJson(join(copy.dir, "apps/account/reset-mail.holon"), (json) => {
      json.title = "Reset mail, renamed";
    });
    const { index, stats } = await service.open(copy.dir, at);
    expect(stats).toMatchObject({ scanned: 1, reparsed: 1 });
    expect(index.view("reset-mail")?.focus.title).toBe("Reset mail, renamed");
  });

  it("equals a fresh model after every kind of change on disk", async () => {
    const path = (relative: string) => join(copy.dir, relative);
    const base = readFileSync(path("apps/account/reset-token.holon"), "utf8");
    const confirmation = readFileSync(path(".holons/confirmations/sign-in/2026-10-20-I-maria.json"), "utf8");
    const steps: [string, () => void][] = [
      ["edit", () => editJson(path("apps/account/reset-mail.holon"), (json) => { json.why = ""; })],
      ["new file in a new directory", () => {
        mkdirSync(path("apps/account/audit/deep"), { recursive: true });
        writeFileSync(path("apps/account/audit/deep/reset-audit.holon"), JSON.stringify({ ...JSON.parse(base), id: "reset-audit", status: "proposed" }));
      }],
      ["delete", () => rmSync(path("apps/account/reset-rate-limit.holon"))],
      ["rename a file", () => renameSync(path("apps/account/audit/deep/reset-audit.holon"), path("apps/account/audit/other.holon"))],
      ["fix the renamed file", () => renameSync(path("apps/account/audit/other.holon"), path("apps/account/audit/reset-audit.holon"))],
      ["move a directory out", () => renameSync(path("apps/search"), join(outside.dir, "search"))],
      ["move it back in", () => renameSync(join(outside.dir, "search"), path("apps/search"))],
      ["remove a directory", () => rmSync(path("apps/account/audit"), { recursive: true })],
      ["a subdirectory becomes its own model", () => mkdirSync(path("apps/catalog/.holons"))],
      ["and stops being one", () => rmSync(path("apps/catalog/.holons"), { recursive: true })],
      ["holon in node_modules", () => {
        mkdirSync(path("apps/node_modules/x"), { recursive: true });
        writeFileSync(path("apps/node_modules/x/ghost.holon"), JSON.stringify({ ...JSON.parse(base), id: "ghost" }));
      }],
      ["seam turns readOnly", () => editJson(path("apps/support-tool/support-tool.holon"), (json) => {
        (json.seams as Record<string, unknown>[])[0]!.readOnly = true;
      })],
      ["new confirmation", () => writeFileSync(
        path(".holons/confirmations/sign-in/2026-11-01-I-maria.json"),
        JSON.stringify({ ...JSON.parse(confirmation), at: "2026-11-01", result: "refuted" }),
      )],
      ["confirmation folder removed", () => rmSync(path(".holons/confirmations/sign-in"), { recursive: true })],
      ["confirmation folder restored", () => {
        mkdirSync(join(outside.dir, "sign-in"));
        writeFileSync(join(outside.dir, "sign-in/2026-10-20-I-maria.json"), confirmation);
        renameSync(join(outside.dir, "sign-in"), path(".holons/confirmations/sign-in"));
      }],
      ["invalid JSON", () => writeFileSync(path("apps/mail/mail.holon"), "{ nope")],
    ];
    for (const [label, step] of steps) {
      step();
      await sameAsFreshModel(label);
    }
  });

  it("rescans fully on an explicit check", async () => {
    const { stats } = await service.open(copy.dir, at, "full");
    expect(stats.scanned).toBeGreaterThan(20);
  });
});
