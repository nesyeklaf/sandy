import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { getAgent, putAgent, seedBuiltinAgents } from "./delegate/server/catalog.ts";
import { changedSettings, importAgents, importLegacy, LEGACY_IMPORT_KEY, readLegacyCatalog } from "./legacy-import.ts";
import { migrations } from "./migrations.ts";

function workDb(file = ":memory:") {
  const db = new Database(file);
  db.transaction(() => { for (const statement of migrations) db.exec(statement); })();
  return db;
}

const entry = (name: string, version: number, body = "body") => ({
  name, version, description: `${name} agent`, body, model: "anthropic/claude-sonnet-5-5", thinking: "high", tools: ["read"], role: "reader",
});

/** delegate's old database at <dataDir>/plugins/delegate/data.db with the given agents put into it. */
function legacyDataDir(agents: ReturnType<typeof entry>[]) {
  const dataDir = mkdtempSync(join(tmpdir(), "work-legacy-"));
  mkdirSync(join(dataDir, "plugins", "delegate"), { recursive: true });
  const old = workDb(join(dataDir, "plugins", "delegate", "data.db"));
  for (const agent of agents) putAgent(old, agent, 1_000);
  old.prepare("INSERT INTO agent_snapshots (snapshot_hash, agent_name, agent_version, entry_json, created_at) VALUES ('h1', 'mine', 1, '{}', 1)").run();
  old.close();
  return dataDir;
}

test("importAgents takes an agent that is missing or has a higher version, keeps a newer builtin, copies snapshots once", () => {
  const db = workDb();
  seedBuiltinAgents(db);
  const scout = getAgent(db, "scout")!;
  const dataDir = legacyDataDir([entry("mine", 1), { ...entry("oracle", 99, "edited by the owner") }, { ...entry("scout", scout.version - 1 || 0, "old") }].filter((a) => a.version > 0));
  const catalog = readLegacyCatalog(db, dataDir)!;
  const first = importAgents(db, catalog);
  assert.deepEqual(first.agents.sort(), ["mine", "oracle"]);
  assert.equal(first.snapshots, 1);
  assert.equal(getAgent(db, "oracle")?.body, "edited by the owner");
  assert.equal(getAgent(db, "scout")?.version, scout.version, "the newer builtin stays");
  assert.deepEqual(importAgents(db, catalog), { agents: [], snapshots: 0 }, "a second import changes nothing");
});

test("readLegacyCatalog opens the old file read-only and answers null when there is none", () => {
  const db = workDb();
  const dataDir = legacyDataDir([entry("mine", 1)]);
  const file = join(dataDir, "plugins", "delegate", "data.db");
  const before = statSync(file).mtimeMs;
  assert.equal(readLegacyCatalog(db, dataDir)?.agents.length, 1);
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(readLegacyCatalog(db, mkdtempSync(join(tmpdir(), "work-empty-"))), null);
});

test("changedSettings takes only values that differ from the old default and that sandy/work knows", () => {
  const values = changedSettings(
    [
      { schema: { maxConcurrentChildren: { default: 4 }, waitCeilingMs: { default: 600000 } }, values: { maxConcurrentChildren: 6, waitCeilingMs: 600000 } },
      { schema: { maxActiveRuns: { default: 3 }, gone: { default: 1 } }, values: { maxActiveRuns: 5, gone: 2 } },
    ],
    new Set(["maxConcurrentChildren", "waitCeilingMs", "maxActiveRuns"]),
  );
  assert.deepEqual(values, { maxConcurrentChildren: 6, maxActiveRuns: 5 });
});

test("importLegacy runs once: catalog and changed settings, a missing old plugin skipped, a kv marker", async () => {
  const db = workDb();
  const dataDir = legacyDataDir([entry("mine", 1)]);
  const kv = new Map<string, unknown>();
  const updates: unknown[] = [];
  const settings: Record<string, { schema: Record<string, { default?: unknown }>; values: Record<string, unknown> }> = {
    delegate: { schema: { maxConcurrentChildren: { default: 4 } }, values: { maxConcurrentChildren: 2 } },
    "workflows-plus": { schema: { maxActiveRuns: { default: 3 } }, values: { maxActiveRuns: 3 } },
    work: { schema: { maxConcurrentChildren: { default: 4 }, maxActiveRuns: { default: 3 } }, values: {} },
  };
  const sandy = {
    pluginId: "work",
    server: { experimental_dataDir: dataDir },
    log: { info: () => {}, warn: () => {} },
    storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => void kv.set(key, value) } },
    sdk: { plugins: {
      getSettings: async ({ pluginId }: { pluginId: string }) => {
        if (settings[pluginId] === undefined) throw Object.assign(new Error(`HTTP 404: unknown plugin "${pluginId}"`), { status: 404 });
        return { ok: true, ...settings[pluginId] };
      },
      updateSettings: async (args: unknown) => { updates.push(args); return { ok: true }; },
    } },
  };
  await importLegacy(sandy as never, db as never);
  assert.deepEqual(updates, [{ pluginId: "work", values: { maxConcurrentChildren: 2 } }]);
  assert.equal(getAgent(db, "mine")?.version, 1);
  assert.deepEqual((kv.get(LEGACY_IMPORT_KEY) as { settings: string[]; agents: string[] }).settings, ["maxConcurrentChildren"]);
  db.prepare("DELETE FROM agents WHERE name = 'mine'").run();
  await importLegacy(sandy as never, db as never);
  assert.equal(getAgent(db, "mine"), null, "the marker keeps a second load from importing again");
  assert.equal(updates.length, 1);
});
