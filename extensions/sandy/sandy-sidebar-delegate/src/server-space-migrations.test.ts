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
  `CREATE TABLE IF NOT EXISTS space_managed_members (
     thread_id  TEXT PRIMARY KEY,
     space_id   TEXT NOT NULL,
     set_at     INTEGER NOT NULL
   )`,
  `DROP TABLE IF EXISTS space_member_modes`,
  `CREATE TABLE IF NOT EXISTS space_started_sessions (
     thread_id          TEXT PRIMARY KEY,
     space_id           TEXT NOT NULL,
     starter_thread_id  TEXT NOT NULL,
     started_at         INTEGER NOT NULL
   )`,
  `ALTER TABLE space_started_sessions ADD COLUMN descendant INTEGER NOT NULL DEFAULT 0`,
];

const SHIPPED_BEFORE_MANAGED_MEMBERS = SHIPPED_SPACE_MIGRATIONS.slice(0, 11);

function tableNames(db: { prepare(sql: string): { all(): unknown[] } }): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe("space coordination migrations", () => {
  it("upgrades a database that already ran the shipped statements", () => {
    const { sandy } = createFakePluginHost({ pluginId: "sandy-sidebar", sdk: {} });
    const db = sandy.storage.database();
    sandy.storage.migrate(db, [...SHIPPED_LEGACY_ROLE_MIGRATIONS, ...SHIPPED_BEFORE_MANAGED_MEMBERS]);
    expect(tableNames(db)).toContain("space_member_modes");
    expect(() =>
      sandy.storage.migrate(db, [...LEGACY_ROLE_MIGRATIONS, ...SPACE_COORDINATION_MIGRATIONS]),
    ).not.toThrow();
    const tables = tableNames(db);
    expect(tables).toContain("space_managed_members");
    expect(tables).not.toContain("space_member_modes");
  });

  it("maps a Space with wake-ups off to check-ins and fallback off, and keeps defaults elsewhere", () => {
    const { sandy } = createFakePluginHost({ pluginId: "sandy-sidebar", sdk: {} });
    const db = sandy.storage.database();
    sandy.storage.migrate(db, [...SHIPPED_LEGACY_ROLE_MIGRATIONS, ...SHIPPED_SPACE_MIGRATIONS]);
    db.prepare("INSERT INTO space_settings (space_id, wake_enabled) VALUES ('quiet', 0), ('loud', 1)").run();
    sandy.storage.migrate(db, [...LEGACY_ROLE_MIGRATIONS, ...SPACE_COORDINATION_MIGRATIONS]);
    const rows = db.prepare("SELECT * FROM space_settings ORDER BY space_id").all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { space_id: "loud", self_reports: 1, check_in_minutes: 10, failure_fallback: 1 },
      { space_id: "quiet", self_reports: 1, check_in_minutes: 0, failure_fallback: 0 },
    ]);
    expect(tableNames(db)).toContain("space_member_reports");
  });

  it("keeps every shipped statement at its index", () => {
    const shipped = [...SHIPPED_LEGACY_ROLE_MIGRATIONS, ...SHIPPED_SPACE_MIGRATIONS];
    const current = [...LEGACY_ROLE_MIGRATIONS, ...SPACE_COORDINATION_MIGRATIONS];
    expect(current.slice(0, shipped.length - 0).filter((statement, index) => statement !== shipped[index])).toEqual([]);
  });
});
