import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../index/schema.ts";

export function tempCopy(source: string): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "holon-test-"));
  cpSync(source, dir, { recursive: true });
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function tempDir(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "holon-test-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function memoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return db;
}
