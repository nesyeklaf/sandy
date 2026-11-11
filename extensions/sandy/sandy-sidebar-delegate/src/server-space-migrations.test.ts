import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { LEGACY_ROLE_MIGRATIONS, SPACE_COORDINATION_MIGRATIONS } from "./server-space-migrations";

const SHIPPED_LEGACY_ROLE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS thread_ideas (
     thread_id  TEXT PRIMARY KEY,
     marked_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS thread_orchestrators (
     thread_id  TEXT PRIMARY KEY,
     marked_at  INTEGER NOT NULL
   )`,
];

const SHIPPED_SPACE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS space_orchestrators (
     thread_id    TEXT PRIMARY KEY,
     space_id     TEXT NOT NULL,
     assigned_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS space_orchestrators_space ON space_orchestrators (space_id)`,
  `CREATE TABLE IF NOT EXISTS space_settings (
     space_id      TEXT PRIMARY KEY,
     wake_enabled  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS space_member_modes (
     thread_id  TEXT PRIMARY KEY,
     mode       TEXT NOT NULL CHECK (mode IN ('managed')),
     set_at     INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS space_ideas (
     id                TEXT PRIMARY KEY,
     space_id          TEXT NOT NULL,
     title             TEXT NOT NULL,
     body              TEXT NOT NULL,
     status            TEXT NOT NULL,
     author_kind       TEXT NOT NULL,
     author_thread_id  TEXT,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS space_ideas_space ON space_ideas (space_id)`,
  `CREATE TABLE IF NOT EXISTS space_idea_links (
     idea_id    TEXT NOT NULL,
     thread_id  TEXT NOT NULL,
     PRIMARY KEY (idea_id, thread_id)
   )`,
  `CREATE TABLE IF NOT EXISTS space_scratchpads (
     space_id             TEXT PRIMARY KEY,
     body                 TEXT NOT NULL,
     revision             INTEGER NOT NULL,
     updated_by_kind      TEXT NOT NULL,
     updated_by_thread_id TEXT,
     updated_at           INTEGER NOT NULL
   )`,
  `DROP TABLE IF EXISTS thread_orchestrators`,
  `DROP TABLE IF EXISTS thread_ideas`,
];

function tableNames(db: { prepare(sql: string): { all(): unknown[] } }): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe("space coordination migrations", () => {
  it("upgrades a database that already ran the shipped statements", () => {
    const { sandy } = createFakePluginHost({ pluginId: "sandy-sidebar", sdk: {} });
    const db = sandy.storage.database();
    sandy.storage.migrate(db, [...SHIPPED_LEGACY_ROLE_MIGRATIONS, ...SHIPPED_SPACE_MIGRATIONS]);
    expect(tableNames(db)).toContain("space_member_modes");
    expect(() =>
      sandy.storage.migrate(db, [...LEGACY_ROLE_MIGRATIONS, ...SPACE_COORDINATION_MIGRATIONS]),
    ).not.toThrow();
    const tables = tableNames(db);
    expect(tables).toContain("space_managed_members");
    expect(tables).not.toContain("space_member_modes");
  });

  it("keeps every shipped statement at its index", () => {
    const shipped = [...SHIPPED_LEGACY_ROLE_MIGRATIONS, ...SHIPPED_SPACE_MIGRATIONS];
    const current = [...LEGACY_ROLE_MIGRATIONS, ...SPACE_COORDINATION_MIGRATIONS];
    expect(current.slice(0, shipped.length - 0).filter((statement, index) => statement !== shipped[index])).toEqual([]);
  });
});
