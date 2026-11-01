import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const script = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "migrate-from-bb.mjs",
);
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function createLegacyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sandy-migrate-"));
  homes.push(home);
  const dir = join(home, ".bb-machines", "host.example");
  mkdirSync(join(dir, "plugins", "bb-recap"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(home, ".bb", "logs"), { recursive: true });
  writeFileSync(join(dir, "bin", "bb"), "");
  mkdirSync(join(dir, "plugins", "genui"), { recursive: true });
  const plugin = new DatabaseSync(join(dir, "plugins", "genui", "data.db"));
  plugin.exec(
    "create table _bb_migrations(id integer primary key, applied_at integer, statement_hash text); insert into _bb_migrations values(0, 1, 'abc')",
  );
  plugin.close();
  writeFileSync(join(dir, "config.json"), '{"config":{"BB_APP_URL":"x"}}');
  writeFileSync(join(dir, "bb-app-runtime.json"), '{"pid":999999999}');
  const db = new DatabaseSync(join(dir, "bb.db"));
  db.exec(`
    create table plugins(id text primary key, root_dir text, source text, source_builtin_name text, catalog_marketplace_name text, source_kind text, source_path text);
    create table plugin_kv(plugin_id text, key text, value text);
    create table user(id text, email text);
    create table apikey(id text, referenceId text);
    create table events(id integer, data text);
    create table thread_tabs(id text, tabs_json text);
    create table app_settings_values(key text, value text);
    insert into plugins values('bb-recap','${home}/.bb-machines/host.example/plugins/bb-recap','git:x',null,'bb-official',null,null),('genui',null,'x',null,null,null,null);
    insert into plugins values('sidebar-path','/h/projects/plugins/bb/bb-sidebar-delegate','path:/h/projects/plugins/bb/bb-sidebar-delegate',null,null,'path','/h/projects/plugins/bb/bb-sidebar-delegate');
    insert into plugin_kv values('bb-recap','k','bb stays'),('genui','k','v');
    insert into user values('bb-machine-auth-system-user','machine-auth@bb.internal');
    insert into apikey values('a','bb-machine-auth-system-user');
    insert into events values(1,'bb history bb-recap untouched');
    insert into thread_tabs values('t','["plugin-fixed:bb--git:diff"]');
    insert into app_settings_values values('pluginProviders:bb-recap','bb/');
  `);
  db.close();
  return home;
}

describe("migrate-from-bb", () => {
  it("changes nothing on a dry run", () => {
    const home = createLegacyHome();
    execFileSync("node", [script, "--home", home]);
    expect(
      readFileSync(
        join(home, ".bb-machines", "host.example", "config.json"),
        "utf8",
      ),
    ).toContain("BB_APP_URL");
  });

  it("moves files, rewrites ids and paths, and leaves history alone", () => {
    const home = createLegacyHome();
    execFileSync("node", [script, "--home", home, "--repo", "/r", "--apply"]);
    const dir = join(home, ".sandy-machines", "host.example");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain(
      "SANDY_APP_URL",
    );
    const db = new DatabaseSync(join(dir, "sandy.db"));
    const rows = (table: string) =>
      JSON.stringify(db.prepare(`select * from ${table}`).all());
    expect(rows("plugins")).toContain('"id":"sandy-recap"');
    expect(rows("plugins")).toContain(
      `${home}/.sandy-machines/host.example/plugins/sandy-recap`,
    );
    expect(rows("plugins")).toContain(
      '"catalog_marketplace_name":"sandy-official"',
    );
    expect(rows("plugin_kv")).toContain('"plugin_id":"sandy-recap"');
    expect(rows("plugins")).toContain(
      '"source_path":"/r/extensions/sandy/sandy-sidebar-delegate"',
    );
    const pluginDb = new DatabaseSync(
      join(dir, "plugins", "genui", "data.db"),
    );
    expect(
      pluginDb.prepare("select * from _sandy_migrations").all(),
    ).toEqual([{ id: 0, applied_at: 1, statement_hash: null }]);
    pluginDb.close();
    expect(rows("user")).toContain("sandy-machine-auth-system-user");
    expect(rows("apikey")).toContain("sandy-machine-auth-system-user");
    expect(rows("thread_tabs")).toContain("plugin-fixed:sandy--git:diff");
    expect(rows("app_settings_values")).toContain(
      "pluginProviders:sandy-recap",
    );
    expect(rows("events")).toContain("bb history bb-recap untouched");
    db.close();
  });

  it("refuses while the old server is alive", () => {
    const home = createLegacyHome();
    writeFileSync(
      join(home, ".bb-machines", "host.example", "bb-app-runtime.json"),
      JSON.stringify({ pid: process.pid }),
    );
    expect(() =>
      execFileSync("node", [script, "--home", home, "--apply"], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
