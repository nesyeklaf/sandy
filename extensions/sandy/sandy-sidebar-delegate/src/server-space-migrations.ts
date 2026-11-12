export const LEGACY_ROLE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS thread_ideas (
     thread_id  TEXT PRIMARY KEY,
     marked_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS thread_orchestrators (
     thread_id  TEXT PRIMARY KEY,
     marked_at  INTEGER NOT NULL
   )`,
];

export const SPACE_COORDINATION_MIGRATIONS = [
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
  `ALTER TABLE space_settings ADD COLUMN self_reports INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE space_settings ADD COLUMN check_in_minutes INTEGER NOT NULL DEFAULT 10`,
  `ALTER TABLE space_settings ADD COLUMN failure_fallback INTEGER NOT NULL DEFAULT 1`,
  `UPDATE space_settings SET check_in_minutes = 0, failure_fallback = 0 WHERE wake_enabled = 0`,
  `ALTER TABLE space_settings DROP COLUMN wake_enabled`,
  `CREATE TABLE IF NOT EXISTS space_member_reports (
     thread_id    TEXT PRIMARY KEY,
     space_id     TEXT NOT NULL,
     outcome      TEXT NOT NULL CHECK (outcome IN ('done', 'blocked', 'question', 'progress')),
     summary      TEXT NOT NULL,
     reported_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS space_member_reports_space ON space_member_reports (space_id)`,
];
