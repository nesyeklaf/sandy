#!/usr/bin/env node
// One-shot migration of an existing bb installation to Sandy.
//
//   node scripts/migrate-from-bb.mjs [--home DIR] [--apply] [--no-backup]
//
// Default is a dry run that prints the plan. With --apply it
//   1. refuses to run while a bb server of that data dir is alive,
//   2. copies the database to backup-pre-sandy-<timestamp>/ (skip: --no-backup),
//   3. renames ~/.bb -> ~/.sandy, ~/.bb-dev -> ~/.sandy-dev,
//      ~/.bb-machines -> ~/.sandy-machines,
//   4. inside each machine dir: bb.db* -> sandy.db*, bb-app-runtime.json ->
//      sandy-app-runtime.json, bin/bb -> bin/sandy, bb-* plugin dirs -> sandy-*,
//   5. rewrites BB_* keys in config.json and env.json to SANDY_*,
//   6. updates the database: plugin ids (bb-x -> sandy-x), data-dir paths, the
//      machine-auth system user. Thread history (events, prompts, titles) stays as it was.
// The systemd unit is not touched: the script prints the new unit text and the commands.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const OLD_USER_ID = "bb-machine-auth-system-user";
const NEW_USER_ID = "sandy-machine-auth-system-user";
const OLD_EMAIL = "machine-auth@bb.internal";
const NEW_EMAIL = "machine-auth@sandy.internal";
// Tables that hold history text; scanning them for exact ids is slow and pointless.
const HISTORY_TABLES = new Set([
  "events",
  "retained_event_outputs",
  "prompt_history_entries",
  "thread_search_segments",
  "thread_search_segments_fts",
  "thread_search_segments_fts_content",
  "thread_conversation_outlines",
]);
// Columns that hold absolute paths below a data dir or plugin dir.
const PATH_COLUMNS = [
  ["environments", "path"],
  ["environments", "status_message"],
  ["environment_hook_operations", "path"],
  ["host_daemon_sessions", "data_dir"],
  ["provider_model_catalogs", "scope_key"],
  ["terminal_sessions", "initial_cwd"],
  ["plugins", "root_dir"],
  ["plugins", "source_path"],
  ["plugin_artifacts", "path"],
  ["plugin_artifacts", "git_checkout_root"],
  ["plugin_state_snapshots", "snapshot_path"],
  ["plugin_state_snapshots", "database_path"],
  ["plugin_state_snapshots", "state_path"],
  ["plugin_state_snapshots", "registration_path"],
  ["plugin_marketplaces", "manifest_url"],
];

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backup = !args.includes("--no-backup");
const homeIndex = args.indexOf("--home");
const home = homeIndex >= 0 ? args[homeIndex + 1] : homedir();
const repoIndex = args.indexOf("--repo");
const repo = repoIndex >= 0 ? args[repoIndex + 1] : join(home, "projects", "sandy");
const log = (message) => console.log(`${apply ? "" : "[dry] "}${message}`);

// Where a plugin that was installed from a path lives after the move into the repo.
export function newPluginSourcePath(path, repoRoot) {
  const unit = /\/plugins\/bb\/([^/]+)$/.exec(path);
  if (unit) {
    return `${repoRoot}/extensions/sandy/${unit[1].startsWith("bb-") ? `sandy-${unit[1].slice(3)}` : unit[1]}`;
  }
  if (/\/plugins-wt\/work\/bb\/work$/.test(path))
    return `${repoRoot}/extensions/sandy/work`;
  return null;
}

export function newPluginId(id) {
  return id.startsWith("bb-") ? `sandy-${id.slice(3)}` : id;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function move(from, to) {
  if (!existsSync(from)) return;
  if (existsSync(to)) throw new Error(`${to} exists already; resolve by hand`);
  log(`mv ${from} -> ${to}`);
  if (apply) renameSync(from, to);
}

function rewriteKeys(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const next = text.replace(/"BB_/g, '"SANDY_');
  if (next === text) return;
  log(`rewrite BB_* keys in ${file}`);
  if (apply) writeFileSync(file, next);
}

function textColumns(db, table) {
  return db
    .prepare(`pragma table_info("${table}")`)
    .all()
    .filter((c) => ["TEXT", ""].includes((c.type ?? "").toUpperCase()))
    .map((c) => c.name);
}

// The plugin SDK keeps applied storage migrations in a table named after the product.
// Without this rename the new SDK would find no record and run every migration again.
export function migratePluginDatabase(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: !apply });
  try {
    const has = db
      .prepare("select name from sqlite_master where type = 'table' and name = '_bb_migrations'")
      .get();
    if (!has) return false;
    log(`rename _bb_migrations in ${dbFile}`);
    if (apply) {
      db.exec("alter table _bb_migrations rename to _sandy_migrations");
      // statement hashes are re-adopted from the current plugin code on its first start
      db.exec("update _sandy_migrations set statement_hash = null");
    }
    return true;
  } finally {
    db.close();
  }
}

function migrateDatabase(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: !apply });
  const tables = db
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%'",
    )
    .all()
    .map((t) => t.name);
  const counts = [];
  const dryCount = (table, where, params) =>
    Number(
      db
        .prepare(`select count(*) as n from "${table}" where ${where}`)
        .get(...params).n,
    );
  const update = (label, table, set, where, params) => {
    if (!tables.includes(table)) return;
    const count = apply
      ? Number(
          db
            .prepare(`update "${table}" set ${set} where ${where}`)
            .run(...params).changes,
        )
      : dryCount(table, where, params.slice(-countPlaceholders(where)));
    if (count > 0) counts.push(`${label}: ${count}`);
  };
  const countPlaceholders = (where) => (where.match(/\?/g) ?? []).length;

  if (apply) db.exec("pragma foreign_keys = off; begin");
  // 1. plugin ids in every column that names one
  for (const table of tables) {
    for (const column of textColumns(db, table)) {
      if (
        !/plugin_id$/i.test(column) &&
        !(table === "plugins" && column === "id")
      )
        continue;
      update(
        `${table}.${column}`,
        table,
        `"${column}" = 'sandy-' || substr("${column}", 4)`,
        `"${column}" like 'bb-%'`,
        [],
      );
    }
  }
  update(
    "plugins.catalog_marketplace_name",
    "plugins",
    `catalog_marketplace_name = 'sandy-' || substr(catalog_marketplace_name, 4)`,
    `catalog_marketplace_name like 'bb-%'`,
    [],
  );
  update(
    "plugin_marketplaces.name",
    "plugin_marketplaces",
    `name = 'sandy-' || substr(name, 4)`,
    `name like 'bb-%'`,
    [],
  );
  update(
    "plugins.source builtin",
    "plugins",
    `source = 'builtin:sandy-' || substr(source, 12), source_builtin_name = 'sandy-' || substr(source_builtin_name, 4)`,
    `source like 'builtin:bb-%'`,
    [],
  );
  update(
    "app_settings_values.key",
    "app_settings_values",
    `key = 'pluginProviders:sandy-' || substr(key, 20)`,
    `key like 'pluginProviders:bb-%'`,
    [],
  );
  update(
    "thread_tabs.tabs_json",
    "thread_tabs",
    `tabs_json = replace(tabs_json, 'plugin-fixed:bb-', 'plugin-fixed:sandy-')`,
    `tabs_json like '%plugin-fixed:bb-%'`,
    [],
  );
  // 2. data-dir paths
  for (const [table, column] of PATH_COLUMNS) {
    if (!tables.includes(table) || !textColumns(db, table).includes(column))
      continue;
    update(
      `${table}.${column}`,
      table,
      `"${column}" = replace(replace(replace("${column}", '/.bb-machines/', '/.sandy-machines/'), '/plugins/bb-', '/plugins/sandy-'), '/snapshots/bb-', '/snapshots/sandy-')`,
      `"${column}" like '%/.bb-machines/%'`,
      [],
    );
  }
  // 2b. plugins installed from a path now live in the repo's extensions/
  if (tables.includes("plugins") && textColumns(db, "plugins").includes("source_path")) {
    const rows = db
      .prepare("select id, source_path from plugins where source_kind = 'path'")
      .all();
    for (const row of rows) {
      const next = newPluginSourcePath(row.source_path ?? "", repo);
      if (!next) continue;
      counts.push(`plugins path ${row.id}: ${row.source_path} -> ${next}`);
      if (apply)
        db.prepare(
          "update plugins set source = ?, source_path = ?, root_dir = ? where id = ?",
        ).run(`path:${next}`, next, next, row.id);
    }
  }
  // 3. machine-auth system user, wherever its id appears as a whole value
  for (const table of tables) {
    if (HISTORY_TABLES.has(table)) continue;
    for (const column of textColumns(db, table)) {
      update(
        `${table}.${column} user id`,
        table,
        `"${column}" = ?`,
        `"${column}" = ?`,
        [NEW_USER_ID, OLD_USER_ID],
      );
    }
  }
  update("user.email", "user", `email = ?`, `email = ?`, [
    NEW_EMAIL,
    OLD_EMAIL,
  ]);
  if (apply) db.exec("commit");
  db.close();
  return counts;
}

function migrateMachine(machinesOld, machinesNew, host) {
  const dir = join(machinesOld, host);
  const runtimeFile = join(dir, "bb-app-runtime.json");
  if (existsSync(runtimeFile)) {
    const { pid } = JSON.parse(readFileSync(runtimeFile, "utf8"));
    if (typeof pid === "number" && isAlive(pid)) {
      throw new Error(
        `bb server for ${host} is still running (pid ${pid}); stop it first`,
      );
    }
  }
  const dbOld = join(dir, "bb.db");
  if (backup && existsSync(dbOld)) {
    const target = join(
      dir,
      `backup-pre-sandy-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
    );
    log(`backup bb.db* -> ${target}`);
    if (apply) {
      mkdirSync(target);
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(dbOld + suffix))
          copyFileSync(dbOld + suffix, join(target, `bb.db${suffix}`));
      }
      if (existsSync(join(dir, "config.json")))
        copyFileSync(join(dir, "config.json"), join(target, "config.json"));
    }
  }
  for (const suffix of ["", "-wal", "-shm"])
    move(dbOld + suffix, join(dir, `sandy.db${suffix}`));
  move(runtimeFile, join(dir, "sandy-app-runtime.json"));
  move(join(dir, "bin", "bb"), join(dir, "bin", "sandy"));
  // the cached plugin build toolchain: without the renamed marker it is re-downloaded onto a non-empty dir and fails
  for (const entry of existsSync(join(dir, "plugins")) ? readdirSync(join(dir, "plugins")) : []) {
    if (entry.startsWith("toolchain-")) {
      move(join(dir, "plugins", entry, ".bb-toolchain.json"), join(dir, "plugins", entry, ".sandy-toolchain.json"));
    }
  }
  for (const base of [
    join(dir, "plugins"),
    join(dir, "plugins", "snapshots"),
    join(dir, "plugin-host-artifacts"),
  ]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name.startsWith("bb-"))
        move(join(base, name), join(base, newPluginId(name)));
    }
  }
  const pluginsDir = join(dir, "plugins");
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      const file = join(pluginsDir, name, "data.db");
      if (existsSync(file)) migratePluginDatabase(file);
    }
  }
  rewriteKeys(join(dir, "config.json"));
  rewriteKeys(join(dir, "env.json"));
  // the directory itself moves last, so every path above is still valid
  const dbFile = join(dir, "sandy.db");
  const dbFileDry = existsSync(dbFile) ? dbFile : dbOld;
  if (existsSync(dbFileDry)) {
    const counts = migrateDatabase(dbFileDry);
    for (const line of counts) log(`db ${line}`);
  }
  move(dir, join(machinesNew, host));
}

const machinesOld = join(home, ".bb-machines");
const machinesNew = join(home, ".sandy-machines");
if (existsSync(machinesOld)) {
  if (apply) mkdirSync(machinesNew, { recursive: true });
  for (const host of readdirSync(machinesOld)) {
    if (statSync(join(machinesOld, host)).isDirectory())
      migrateMachine(machinesOld, machinesNew, host);
  }
  if (apply && readdirSync(machinesOld).length === 0)
    renameSync(machinesOld, `${machinesOld}.migrated`);
}
move(join(home, ".bb"), join(home, ".sandy"));
move(join(home, ".bb-dev"), join(home, ".sandy-dev"));
log(
  "systemd: write a unit with ExecStart '.../.sandy-machines/<host>/npm/bin/sandy-app start --data-dir .../.sandy-machines/<host> ...' and Environment SANDY_APP_NPM_PREFIX / SANDY_DATA_DIR, then 'systemctl --user disable --now <old unit>' and 'enable --now <new unit>'.",
);
