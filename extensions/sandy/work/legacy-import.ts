// One-time import from the four plugins sandy/work replaces (delegate, workflows-plus, goals, track).
// Only the agent catalog (agents, agent_snapshots of delegate's database) and settings the owner changed
// come over; run history stays behind. The old plugins' files are opened read-only and never changed.
// A kv marker makes it run once; a failure is logged and retried at the next load.
import type { SandyPluginApi, JsonValue } from "@sandy-sdk/plugin-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

type Db = ReturnType<SandyPluginApi["storage"]["database"]>;

export const LEGACY_PLUGIN_IDS = ["delegate", "workflows-plus", "goals", "track"] as const;
export const LEGACY_IMPORT_KEY = "legacy-import-v1";

export interface AgentRow { name: string; version: number; entry_json: string; entry_hash: string; created_at: number; updated_at: number }
export interface SnapshotRow { snapshot_hash: string; agent_name: string; agent_version: number; entry_json: string; created_at: number }
export interface LegacyCatalog { agents: AgentRow[]; snapshots: SnapshotRow[] }
export interface SettingsResponse { schema: Record<string, { default?: unknown }>; values: Record<string, JsonValue> }

/** Copies the old catalog: snapshots by hash, an agent when it is missing or the old version is higher. */
export function importAgents(db: Db, old: LegacyCatalog): { agents: string[]; snapshots: number } {
  const agents: string[] = [];
  let snapshots = 0;
  db.transaction(() => {
    const insertSnapshot = db.prepare(
      "INSERT OR IGNORE INTO agent_snapshots (snapshot_hash, agent_name, agent_version, entry_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of old.snapshots) {
      snapshots += insertSnapshot.run(row.snapshot_hash, row.agent_name, row.agent_version, row.entry_json, row.created_at).changes;
    }
    for (const row of old.agents) {
      const current = db.prepare("SELECT version FROM agents WHERE name = ?").get(row.name) as { version: number } | undefined;
      if (current !== undefined && current.version >= row.version) continue;
      db.prepare(
        "INSERT INTO agents (name, version, entry_json, entry_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET version = excluded.version, entry_json = excluded.entry_json, entry_hash = excluded.entry_hash, updated_at = excluded.updated_at",
      ).run(row.name, row.version, row.entry_json, row.entry_hash, row.created_at, row.updated_at);
      agents.push(row.name);
    }
  })();
  return { agents, snapshots };
}

/** Values the owner changed in the old plugins (differ from that plugin's default) for keys sandy/work has. */
export function changedSettings(old: SettingsResponse[], ownKeys: ReadonlySet<string>): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const response of old) {
    for (const [key, value] of Object.entries(response.values)) {
      if (!ownKeys.has(key) || value === null || value === undefined) continue;
      if (JSON.stringify(value) === JSON.stringify(response.schema[key]?.default)) continue;
      values[key] = value;
    }
  }
  return values;
}

/** Reads delegate's old catalog read-only; null when that plugin never stored one here. */
export function readLegacyCatalog(db: Db, dataDir: string): LegacyCatalog | null {
  const path = join(dataDir, "plugins", "delegate", "data.db");
  if (!existsSync(path)) return null;
  const Database = db.constructor as new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => Db;
  const old = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set((old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    if (!tables.has("agents") || !tables.has("agent_snapshots")) return null;
    return {
      agents: old.prepare("SELECT name, version, entry_json, entry_hash, created_at, updated_at FROM agents").all() as AgentRow[],
      snapshots: old.prepare("SELECT snapshot_hash, agent_name, agent_version, entry_json, created_at FROM agent_snapshots").all() as SnapshotRow[],
    };
  } finally {
    old.close();
  }
}

export async function importLegacy(sandy: SandyPluginApi, db: Db): Promise<void> {
  if ((await sandy.storage.kv.get(LEGACY_IMPORT_KEY)) !== undefined) return;
  const catalog = readLegacyCatalog(db, sandy.server.experimental_dataDir);
  const imported = catalog === null ? { agents: [], snapshots: 0 } : importAgents(db, catalog);
  const old: SettingsResponse[] = [];
  for (const pluginId of LEGACY_PLUGIN_IDS) {
    try {
      old.push((await sandy.sdk.plugins.getSettings({ pluginId })) as SettingsResponse);
    } catch {
      // not installed here: nothing to take over
    }
  }
  const own = (await sandy.sdk.plugins.getSettings({ pluginId: sandy.pluginId })) as SettingsResponse;
  const values = changedSettings(old, new Set(Object.keys(own.schema)));
  if (Object.keys(values).length > 0) await sandy.sdk.plugins.updateSettings({ pluginId: sandy.pluginId, values });
  await sandy.storage.kv.set(LEGACY_IMPORT_KEY, { at: Date.now(), agents: imported.agents, snapshots: imported.snapshots, settings: Object.keys(values) });
  sandy.log.info(`legacy import: agents [${imported.agents.join(", ")}], ${imported.snapshots} snapshots, settings [${Object.keys(values).join(", ")}]`);
}
