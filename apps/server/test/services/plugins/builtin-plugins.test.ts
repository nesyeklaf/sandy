import { EventEmitter } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAiServiceSelections,
  getInstalledPluginRegistration,
  getPluginSettingsValues,
  listPluginKvKeys,
  listPluginSchedules,
  setAiServiceSelection,
  setPluginKvValue,
  setPluginSettingsValues,
  upsertPluginSchedule,
  type DbConnection,
} from "@sandy/db";
import { createMigratedConnection } from "@sandy/db/testing";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@sandy/domain";
import type { Logger } from "@sandy/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  dispatchPluginSourceWatchChange,
  superviseBuiltinPluginSourceWatcher,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  accountPoolDefaultEnabled,
  BUILTIN_PLUGINS,
  OFFICIAL_PLUGINS,
  resolveBuiltinPluginRootPath,
} from "../../../src/services/plugins/builtin-registry.js";
import { copyPluginRuntime } from "@sandy/plugin-build";
import { testLogger } from "../../helpers/test-app.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const logger = testLogger as unknown as Logger;
const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(
  testDir,
  "..",
  "..",
  "fixtures",
  "plugins",
  "sandy-plugin-builtin-fixture",
);
const globals = globalThis as Record<string, unknown>;

function loadCount(): number {
  return (globals.__builtinFixtureLoads as number | undefined) ?? 0;
}

function packagedLoadCount(): number {
  return (globals.__packagedBuiltinLoads as number | undefined) ?? 0;
}

async function writePackagedBuiltinSource(
  workDir: string,
  names: readonly string[],
): Promise<{
  sourceModuleDir: string;
}> {
  const sourceModuleDir = join(workDir, "source-module");
  for (const name of names) {
    const sourceRoot = join(sourceModuleDir, "builtin-plugins", name);
    const usesPluginOwnedIcon = name === "automations";
    const usesDeclaredIcons = name === "provider-acp";
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await mkdir(join(sourceRoot, "skills", name), { recursive: true });
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await writeFile(
      join(sourceRoot, "package.json"),
      JSON.stringify(
        {
          name: `sandy-plugin-${name}`,
          version: "0.1.0",
          type: "module",
          sandy: {
            name,
            description: `${name} builtin plugin fixture.`,
            branding: {
              ...(usesPluginOwnedIcon
                ? { icon: "./assets/icon.svg" }
                : { icon: "Zap" }),
              ...(usesDeclaredIcons
                ? { experimental_icons: { cursor: "./icons/cursor.svg" } }
                : {}),
            },
            server: "./src/server.ts",
            app: "./app.tsx",
            skills: ["skills"],
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(sourceRoot, "src", "server.ts"),
      `throw new Error("packaged builtin should not load source");\n`,
    );
    await writeFile(
      join(sourceRoot, "app.tsx"),
      `throw new Error("packaged builtin should not build app source");\n`,
    );
    if (usesPluginOwnedIcon) {
      await mkdir(join(sourceRoot, "assets"), { recursive: true });
      await writeFile(join(sourceRoot, "assets", "icon.svg"), "<svg/>\n");
    }
    if (usesDeclaredIcons) {
      await mkdir(join(sourceRoot, "icons"), { recursive: true });
      await writeFile(join(sourceRoot, "icons", "cursor.svg"), "<svg/>\n");
    }
    await writeFile(
      join(sourceRoot, "dist", "server.js"),
      `export default function plugin() {
  globalThis.__packagedBuiltinLoads = (globalThis.__packagedBuiltinLoads ?? 0) + 1;
}
`,
    );
    await writeFile(
      join(sourceRoot, "dist", "server.meta.json"),
      `${JSON.stringify(
        { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: PLUGIN_SDK_VERSION },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(sourceRoot, "dist", "app.js"), `export default {};\n`);
    await writeFile(join(sourceRoot, "dist", "app.css"), `/* built */\n`);
    await writeFile(
      join(sourceRoot, "dist", "app.meta.json"),
      `${JSON.stringify(
        { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: PLUGIN_SDK_VERSION },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(sourceRoot, "skills", name, "SKILL.md"),
      `---\nname: ${name}\n---\n`,
    );
  }
  return { sourceModuleDir };
}

async function copyPackagedBuiltinRuntime(
  workDir: string,
  names: readonly string[],
): Promise<{ targetRoot: string }> {
  const { sourceModuleDir } = await writePackagedBuiltinSource(workDir, names);
  const targetRoot = join(workDir, "builtin-plugins");
  for (const name of names) {
    await copyPluginRuntime({
      sourceRoot: join(sourceModuleDir, "builtin-plugins", name),
      targetDir: join(targetRoot, name),
    });
  }
  return { targetRoot };
}

function createService(args: {
  dataDir: string;
  db: DbConnection;
  builtinName?: string;
  autoInstall?: boolean;
  defaultEnabled?: boolean;
  includeBuiltin?: boolean;
  pluginId?: string;
  rootDir?: string;
  watchBuiltinPluginSources?: boolean;
}): PluginService {
  return createPluginService({
    aiServices: createAiServiceRegistry(),
    db: args.db,
    hub: {
      getDaemonSessionIdForHost: () => null,
      notifyPluginChanged: () => {},
      onWatchedTargets: () => () => {},
      notifyPluginSignal: () => 0,
      notifySystem: () => {},
    },
    logger,
    dataDir: args.dataDir,
    appVersion: "0.9.0",
    bundledPlugins:
      args.includeBuiltin === false
        ? []
        : [
            {
              name: args.builtinName ?? "fixture",
              pluginId: args.pluginId ?? args.builtinName ?? "fixture",
              autoInstall: args.autoInstall ?? true,
              rootDir: args.rootDir ?? fixtureRoot,
              defaultEnabled: args.defaultEnabled ?? true,
            },
          ],
    watchBuiltinPluginSources: args.watchBuiltinPluginSources,
    loadTimeoutMs: 2000,
  });
}

describe("builtin plugin reconciliation", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService | undefined;

  it("reloads when the source watcher omits the changed filename", () => {
    const changes: string[] = [];

    dispatchPluginSourceWatchChange((path) => changes.push(path), null);

    expect(changes).toEqual(["."]);
  });

  it("reports and closes a builtin source watcher that fails instead of throwing", () => {
    class FakeSourceWatcher extends EventEmitter {
      close(): void {
        this.emit("close");
      }
    }
    const watcher = new FakeSourceWatcher();
    const errors: string[] = [];
    let loopDisposals = 0;
    superviseBuiltinPluginSourceWatcher({
      watcher,
      onClose: () => {
        loopDisposals += 1;
      },
      onError: (error) => errors.push(error.message),
    });

    const failure = Object.assign(
      new Error(
        "ENOSPC: System limit for number of file watchers reached, watch '/plugin/src'",
      ),
      { code: "ENOSPC" },
    );
    expect(() => watcher.emit("error", failure)).not.toThrow();

    expect(errors).toEqual([failure.message]);
    expect(loopDisposals).toBe(1);
  });

  beforeEach(async () => {
    delete globals.__builtinFixtureLoads;
    delete globals.__packagedBuiltinLoads;
    delete globals.__hotBuiltinServerVersion;
    db = createMigratedConnection();
    workDir = await mkdtemp(join(tmpdir(), "sandy-builtin-plugins-"));
  });

  it("keeps official plugins bundled but out of the auto-install builtins", () => {
    const optionalNames = OFFICIAL_PLUGINS.map((plugin) => plugin.name);
    expect(optionalNames).toEqual([
      "browser-automation",
      "github",
      "docs",
      "memory",
      "tasks",
      "theme-preview",
    ]);
    for (const name of optionalNames) {
      expect(BUILTIN_PLUGINS.map((plugin) => plugin.name)).not.toContain(name);
    }
    expect(OFFICIAL_PLUGINS.every((plugin) => !plugin.autoInstall)).toBe(true);
  });

  it("enables the account pooler only when a parent sandy server pool is present", () => {
    expect(accountPoolDefaultEnabled({})).toBe(false);
    expect(accountPoolDefaultEnabled({ SANDY_ACCOUNT_POOL_PARENT_URL: "" })).toBe(
      false,
    );
    expect(
      accountPoolDefaultEnabled({
        SANDY_ACCOUNT_POOL_PARENT_URL:
          "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
      }),
    ).toBe(true);
  });

  afterEach(async () => {
    await service?.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("installs and loads a declared builtin on a fresh database", async () => {
    service = createService({ db, dataDir: join(workDir, "data") });

    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "builtin-fixture",
        source: "builtin:fixture",
        version: "0.1.0",
        provenance: "builtin",
        isOrphanedBuiltin: false,
        sourceDisplay: "builtin · builtin-fixture",
        updateState: {},
        icon: "EditFile",
        enabled: true,
        status: "running",
      },
    ]);
    expect(loadCount()).toBe(1);
    expect(getInstalledPluginRegistration(db, "builtin-fixture")).toMatchObject(
      {
        provenance: "builtin",
        sourceKind: "builtin",
        sourceBuiltinName: "fixture",
        normalizationVersion: 1,
      },
    );
  });

  it("removes a builtin and its data once sandy no longer bundles it", async () => {
    const dataDir = join(workDir, "data");
    const secretsDir = join(dataDir, "plugins", "builtin-fixture", "secrets");
    service = createService({ db, dataDir });
    await service.start();
    expect(service.list()[0]?.isOrphanedBuiltin).toBe(false);
    await service.stop();
    setPluginSettingsValues(db, "builtin-fixture", { mode: "on" });
    upsertPluginSchedule(db, {
      pluginId: "builtin-fixture",
      name: "tick",
      cron: "* * * * *",
      nextRunAt: 0,
    });
    await mkdir(secretsDir, { recursive: true });
    await writeFile(join(secretsDir, "token"), "secret");

    service = createService({ db, dataDir, includeBuiltin: false });
    await service.start();

    expect(service.list()).toEqual([]);
    expect(
      getInstalledPluginRegistration(db, "builtin-fixture"),
    ).toBeUndefined();
    expect(getPluginSettingsValues(db, "builtin-fixture")).toEqual({});
    expect(listPluginSchedules(db, "builtin-fixture")).toEqual([]);
    await expect(stat(secretsDir)).rejects.toThrow();
    await service.stop();

    service = createService({ db, dataDir });
    await service.start();

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", enabled: true, isOrphanedBuiltin: false },
    ]);
  });

  it("retries orphaned builtin cleanup after secret removal fails", async () => {
    const dataDir = join(workDir, "data");
    const secretsDir = join(dataDir, "plugins", "builtin-fixture", "secrets");
    service = createService({ db, dataDir });
    await service.start();
    await service.stop();
    await mkdir(secretsDir, { recursive: true });
    await writeFile(join(secretsDir, "token"), "secret");

    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let failed = false;
    vi.mocked(rm).mockImplementation(async (...args) => {
      if (!failed && args[0] === secretsDir) {
        failed = true;
        throw new Error("secret removal failed");
      }
      return actual.rm(...args);
    });
    try {
      service = createService({ db, dataDir, includeBuiltin: false });
      await expect(service.start()).rejects.toThrow("secret removal failed");
      expect(
        getInstalledPluginRegistration(db, "builtin-fixture"),
      ).toBeDefined();
      expect(await readFile(join(secretsDir, "token"), "utf8")).toBe("secret");

      service = createService({ db, dataDir, includeBuiltin: false });
      await service.start();
      expect(
        getInstalledPluginRegistration(db, "builtin-fixture"),
      ).toBeUndefined();
      await expect(stat(secretsDir)).rejects.toThrow();
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm);
    }
  });

  it("backfills every legacy source form once while preserving registration state", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const legacyRoot = join(workDir, "missing-legacy-root");
    const legacyRows = [
      ["legacy-path", `path:${fixtureRoot}`, 1, 101],
      ["legacy-builtin", "builtin:fixture", 0, 102],
      ["legacy-git", `git:github.com/acme/sandy-plugin-legacy@${sha}`, 0, 104],
    ] as const;
    const insert = db.$client.prepare(
      `INSERT INTO plugins
       (id, source, root_dir, version, enabled, removed_at, installed_at, updated_at)
       VALUES (?, ?, ?, '0.1.0', ?, ?, 10, 20)`,
    );
    for (const [id, source, enabled, removedAt] of legacyRows) {
      insert.run(id, source, legacyRoot, enabled, removedAt);
    }

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(getInstalledPluginRegistration(db, "legacy-path")).toMatchObject({
      enabled: true,
      removedAt: 101,
      provenance: "direct",
      sourceKind: "path",
      sourcePath: fixtureRoot,
      normalizationVersion: 1,
    });
    expect(getInstalledPluginRegistration(db, "legacy-builtin")).toMatchObject({
      enabled: false,
      removedAt: 102,
      provenance: "builtin",
      sourceKind: "builtin",
      sourceBuiltinName: "fixture",
    });
    expect(getInstalledPluginRegistration(db, "legacy-git")).toMatchObject({
      enabled: false,
      removedAt: 104,
      sourceKind: "git",
      sourceGitUrl: "https://github.com/acme/sandy-plugin-legacy",
      sourceGitRequestedRef: sha,
      gitResolvedCommit: sha,
    });

    const once = legacyRows.map(([id]) =>
      getInstalledPluginRegistration(db, id),
    );
    await service.stop();
    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();
    expect(
      legacyRows.map(([id]) => getInstalledPluginRegistration(db, id)),
    ).toEqual(once);
  });

  it("removes retired connection state once on upgrade and leaves local plugins intact", async () => {
    const legacyRoot = join(workDir, "missing-legacy-root");
    db.$client
      .prepare(
        `INSERT INTO plugins
         (id, source, root_dir, version, enabled, installed_at, updated_at)
         VALUES ('local-tool', ?, ?, '0.1.0', 1, 10, 20)`,
      )
      .run(`path:${fixtureRoot}`, legacyRoot);
    setAiServiceSelection(db, "thread-title", {
      mode: "service",
      pluginId: "sandy-ai",
      serviceId: "cloud",
    });
    setAiServiceSelection(db, "commit-message", {
      mode: "service",
      pluginId: "provider-claude-code",
      serviceId: "claude",
    });
    setAiServiceSelection(db, "voice", { mode: "off" });
    setPluginKvValue(db, "push-notifications", "subscription:a", "{}");
    setPluginKvValue(db, "push-notifications", "subscription:b", "{}");
    setPluginKvValue(db, "push-notifications", "last-send-outcome", "{}");
    setPluginKvValue(db, "sandy-account", "credential", "{}");
    setPluginKvValue(db, "sandy-account", "profile", "{}");
    setPluginKvValue(db, "sandy-account", "revision", "3");
    setPluginSettingsValues(db, "sandy-account", { server: "x" });
    setPluginKvValue(db, "connect", "machine-credential", "{}");
    setPluginSettingsValues(db, "connect", { enabled: "true" });
    setPluginKvValue(db, "sandy--connect-next", "gate", "{}");
    setPluginSettingsValues(db, "sandy--connect-next", { enabled: "true" });
    setPluginKvValue(db, "sandy-ai", "state", "{}");
    setPluginSettingsValues(db, "sandy-ai", { enabled: "true" });
    setPluginKvValue(db, "environment-modal-sandbox", "state", "{}");
    setPluginSettingsValues(db, "environment-modal-sandbox", { token: "x" });
    setPluginKvValue(db, "local-tool", "keep", "1");

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(getAiServiceSelections(db)).toEqual({
      "thread-title": { mode: "automatic" },
      "commit-message": {
        mode: "service",
        pluginId: "provider-claude-code",
        serviceId: "claude",
      },
      voice: { mode: "off" },
    });
    expect(listPluginKvKeys(db, "push-notifications")).toEqual([
      "last-send-outcome",
    ]);
    expect(listPluginKvKeys(db, "sandy-account")).toEqual([]);
    expect(getPluginSettingsValues(db, "sandy-account")).toEqual({});
    expect(listPluginKvKeys(db, "connect")).toEqual([]);
    expect(getPluginSettingsValues(db, "connect")).toEqual({});
    expect(listPluginKvKeys(db, "sandy--connect-next")).toEqual([]);
    expect(getPluginSettingsValues(db, "sandy--connect-next")).toEqual({});
    expect(listPluginKvKeys(db, "sandy-ai")).toEqual([]);
    expect(getPluginSettingsValues(db, "sandy-ai")).toEqual({});
    expect(listPluginKvKeys(db, "environment-modal-sandbox")).toEqual([]);
    expect(getPluginSettingsValues(db, "environment-modal-sandbox")).toEqual(
      {},
    );
    expect(getInstalledPluginRegistration(db, "local-tool")).toMatchObject({
      sourceKind: "path",
      enabled: true,
    });
    expect(listPluginKvKeys(db, "local-tool")).toEqual(["keep"]);

    setPluginKvValue(db, "sandy-account", "credential", '{"again":true}');
    await service.stop();
    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();
    expect(listPluginKvKeys(db, "sandy-account")).toEqual(["credential"]);
  });

  it("removes installed plugins that came from an npm source and keeps the others", async () => {
    const legacyRoot = join(workDir, "missing-legacy-root");
    db.$client
      .prepare(
        `INSERT INTO plugins
         (id, source, root_dir, version, enabled, installed_at, updated_at)
         VALUES (?, ?, ?, '1.0.0', 1, 10, 20)`,
      )
      .run("from-npm", "npm:sandy-plugin-from-npm@1.0.0", legacyRoot);
    db.$client
      .prepare(
        `INSERT INTO plugins
         (id, source, root_dir, version, enabled, installed_at, updated_at)
         VALUES (?, ?, ?, '1.0.0', 1, 10, 20)`,
      )
      .run("from-path", `path:${fixtureRoot}`, legacyRoot);
    db.$client
      .prepare(
        `INSERT INTO plugins
         (id, source, root_dir, version, enabled, installed_at, updated_at, removed_at)
         VALUES (?, ?, ?, '1.0.0', 0, 10, 20, 30)`,
      )
      .run("removed-npm", "npm:sandy-plugin-removed@1.0.0", legacyRoot);
    setPluginKvValue(db, "removed-npm", "state", "1");
    setPluginKvValue(db, "from-npm", "state", "1");
    setPluginSettingsValues(db, "from-npm", { mode: "fast" });

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(getInstalledPluginRegistration(db, "from-npm")).toBeUndefined();
    expect(listPluginKvKeys(db, "from-npm")).toEqual([]);
    expect(getPluginSettingsValues(db, "from-npm")).toEqual({});
    expect(getInstalledPluginRegistration(db, "from-path")).toMatchObject({
      sourceKind: "path",
    });
    expect(
      db.$client.prepare("SELECT id FROM plugins WHERE id = 'removed-npm'").all(),
    ).toEqual([]);
    expect(listPluginKvKeys(db, "removed-npm")).toEqual([]);
  });

  it("keeps an offline legacy git ref unclassified", async () => {
    const missingRepo = join(workDir, "missing-remote");
    db.$client
      .prepare(
        `INSERT INTO plugins
         (id, source, root_dir, version, enabled, installed_at, updated_at)
         VALUES (?, ?, ?, '1.0.0', 0, 10, 20)`,
      )
      .run(
        "legacy-offline-tag",
        `git:${missingRepo}@v1.0.0`,
        join(workDir, "missing-plugin-root"),
      );

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(
      getInstalledPluginRegistration(db, "legacy-offline-tag"),
    ).toMatchObject({
      normalizationVersion: 1,
      sourceGitRequestedRef: "v1.0.0",
      sourceGitRefKind: null,
    });
  });

  it("installs a default-disabled builtin without loading it", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: false,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "builtin-fixture",
        source: "builtin:fixture",
        enabled: false,
        status: "disabled",
      },
    ]);
    expect(loadCount()).toBe(0);

    await service.setEnabled("builtin-fixture", true);
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", enabled: true, status: "running" },
    ]);
    expect(loadCount()).toBe(1);

    await service.stop();
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: false,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", enabled: true, status: "running" },
    ]);
  });

  it.each([false, true])(
    "follows a changed default for a builtin the user never toggled (initial default: %s)",
    async (initialDefault) => {
      service = createService({
        db,
        dataDir: join(workDir, "data"),
        defaultEnabled: initialDefault,
      });
      await service.start();
      expect(service.list()).toMatchObject([
        {
          id: "builtin-fixture",
          enabled: initialDefault,
          status: initialDefault ? "running" : "disabled",
        },
      ]);
      expect(loadCount()).toBe(initialDefault ? 1 : 0);
      await service.stop();

      service = createService({
        db,
        dataDir: join(workDir, "data"),
        defaultEnabled: !initialDefault,
      });
      await service.start();

      expect(service.list()).toMatchObject([
        {
          id: "builtin-fixture",
          enabled: !initialDefault,
          status: initialDefault ? "disabled" : "running",
        },
      ]);
      expect(loadCount()).toBe(1);
    },
  );

  it("keeps a builtin the user turned off disabled when its default turns on", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: false,
    });
    await service.start();
    await service.setEnabled("builtin-fixture", true);
    await service.setEnabled("builtin-fixture", false);
    await service.stop();

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: true,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", enabled: false, status: "disabled" },
    ]);
  });

  it("ships each product builtin with its deliberate default", () => {
    expect(
      Object.fromEntries(
        BUILTIN_PLUGINS.map((builtin) => [
          builtin.name,
          builtin.defaultEnabled,
        ]),
      ),
    ).toMatchObject({
      "prompt-library": false,
      mcp: false,
      "plugin-api-tester": false,
      "monaco-editor": false,
      "plugin-api-docs": false,
      workflows: false,
      "provider-usage": true,
      "concurrency-limit": true,
      "scheduled-send": true,
      drafts: true,
      "provider-retry": true,
      "push-notifications": true,
    });
  });

  it.each([
    ["provider-usage", "sandy--provider-usage"],
    ["provider-retry", "provider-retry"],
  ])(
    "runs the real %s builtin on a fresh database",
    async (builtinName, pluginId) => {
      service = createService({
        db,
        dataDir: join(workDir, "data"),
        builtinName,
        pluginId,
        rootDir: resolveBuiltinPluginRootPath(builtinName),
      });
      await service.start();

      expect(service.list()).toMatchObject([
        {
          id: pluginId,
          source: `builtin:${builtinName}`,
          enabled: true,
          status: "running",
        },
      ]);
    },
  );

  it("loads the real side-chat builtin source", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "side-chat",
      pluginId: "side-chat",
      rootDir: resolveBuiltinPluginRootPath("side-chat"),
    });

    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "side-chat",
        source: "builtin:side-chat",
        enabled: true,
        status: "running",
        icon: "SideChat",
      },
    ]);
  });

  it("keeps a builtin tombstoned after remove and restart", async () => {
    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    await expect(service.remove("builtin-fixture")).resolves.toBe(true);
    expect(service.list()).toEqual([]);
    await service.stop();

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(service.list()).toEqual([]);
    expect(loadCount()).toBe(1);
  });

  it("refreshes the builtin row when the bundled package version changes", async () => {
    const mutableRoot = join(workDir, "sandy-plugin-builtin-fixture");
    await cp(fixtureRoot, mutableRoot, { recursive: true });
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      rootDir: mutableRoot,
    });
    await service.start();
    await service.stop();

    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "sandy-plugin-builtin-fixture",
        version: "0.2.0",
        type: "module",
        sandy: {
          name: "Builtin fixture",
          description: "Builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      rootDir: mutableRoot,
    });
    await service.start();

    const entry = service
      .list()
      .find((plugin) => plugin.id === "builtin-fixture");
    expect(entry?.source).toBe("builtin:fixture");
    expect(entry?.version).toBe("0.2.0");
    expect(entry?.status).toBe("running");
    expect(loadCount()).toBe(2);
  });

  it("lists and runs a builtin plugin's CLI contribution", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
    });

    await service.start();

    expect(service.listCliContributions()).toMatchObject([
      {
        pluginId: "builtin-fixture",
        name: "builtin-fixture",
        summary: "Builtin fixture command",
      },
    ]);
    await expect(
      service.runCliCommand("builtin-fixture", [], {}),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "builtin builtin-fixture",
    });
  });

  it("hot-reloads a source-layout builtin server instead of a compatible dist artifact", async () => {
    const mutableRoot = join(workDir, "sandy-plugin-hot-server-builtin");
    await mkdir(join(mutableRoot, "dist"), { recursive: true });
    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "sandy-plugin-hot-server-builtin",
        version: "0.1.0",
        type: "module",
        sandy: {
          name: "Hot server builtin",
          description: "Hot server builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(mutableRoot, "server.ts"),
      'export default function plugin() { globalThis.__hotBuiltinServerVersion = "before"; }\n',
    );
    await writeFile(
      join(mutableRoot, "dist", "server.js"),
      'export default function plugin() { globalThis.__hotBuiltinServerVersion = "stale-dist"; }\n',
    );
    await writeFile(
      join(mutableRoot, "dist", "server.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "hot-server",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();
    expect(globals.__hotBuiltinServerVersion).toBe("before");

    await writeFile(
      join(mutableRoot, "server.ts"),
      'export default function plugin() { globalThis.__hotBuiltinServerVersion = "after"; }\n',
    );
    let deadline = Date.now() + 40_000;
    while (
      globals.__hotBuiltinServerVersion !== "after" &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    expect(globals.__hotBuiltinServerVersion).toBe("after");
  }, 50_000);

  it("rebuilds a source-layout builtin app changed while the server was stopped", async () => {
    const mutableRoot = join(workDir, "sandy-plugin-stale-app-builtin");
    await mkdir(mutableRoot, { recursive: true });
    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "sandy-plugin-stale-app-builtin",
        version: "0.1.0",
        type: "module",
        sandy: {
          name: "Stale app builtin",
          description: "Stale app builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
          app: "./app.tsx",
        },
      }),
    );
    await writeFile(
      join(mutableRoot, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(mutableRoot, "app.tsx"),
      'import { label } from "./label.js";\nexport default function App() { return <div>{label}</div>; }\n',
    );
    const labelPath = join(mutableRoot, "label.ts");
    await writeFile(labelPath, 'export const label = "before";\n');
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "stale-app",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();
    const beforeHash = service.list()[0]?.app.bundle?.hash;
    expect(beforeHash).toBeTruthy();
    await expect(
      readFile(join(mutableRoot, "dist", "app.js"), "utf8"),
    ).resolves.toContain("before");
    await service.stop();

    await writeFile(labelPath, 'export const label = "after";\n');
    const oldArtifactTime = new Date(1_000);
    await utimes(
      join(mutableRoot, "dist", "app.js"),
      oldArtifactTime,
      oldArtifactTime,
    );
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "stale-app",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();

    expect(service.list()[0]?.app.bundle?.hash).not.toBe(beforeHash);
    await expect(
      readFile(join(mutableRoot, "dist", "app.js"), "utf8"),
    ).resolves.toContain("after");
  }, 30_000);

  it("surfaces builtin app build failures in status until the next successful build", async () => {
    const mutableRoot = join(workDir, "sandy-plugin-hot-app-builtin");
    await mkdir(mutableRoot, { recursive: true });
    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "sandy-plugin-hot-app-builtin",
        version: "0.1.0",
        type: "module",
        sandy: {
          name: "Hot app builtin",
          description: "Hot app builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
          app: "./app.tsx",
        },
      }),
    );
    await writeFile(
      join(mutableRoot, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(mutableRoot, "app.tsx"),
      "export default function App() { return <div>before</div>; }\n",
    );
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "hot-app",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();
    const before = service.list()[0]?.app.bundle;
    expect(before).not.toBeNull();

    await writeFile(
      join(mutableRoot, "app.tsx"),
      "export default function App( {\n",
    );
    let deadline = Date.now() + 20_000;
    let failed = service.list()[0];
    while (
      !failed?.statusDetail?.includes("frontend bundle build failed") &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      failed = service.list()[0];
    }
    expect(failed?.status).toBe("running");
    expect(failed?.statusDetail).toContain("frontend bundle build failed");
    expect(failed?.app.bundle?.hash).toBe(before?.hash);

    await writeFile(
      join(mutableRoot, "app.tsx"),
      "export default function App() { return <div>after</div>; }\n",
    );
    deadline = Date.now() + 20_000;
    let after = service.list()[0];
    while (
      (after?.statusDetail !== null ||
        after.app.bundle?.hash === before?.hash) &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      after = service.list()[0];
    }
    expect(after?.statusDetail).toBeNull();
    expect(after?.app.bundle?.hash).not.toBe(before?.hash);
    await expect(
      readFile(join(mutableRoot, "dist", "app.js"), "utf8"),
    ).resolves.toContain("after");
  }, 90_000);

  it("rejects unknown builtin install sources clearly", async () => {
    service = createService({ db, dataDir: join(workDir, "data") });

    await expect(
      service.install("builtin:missing", { kind: "root" }),
    ).rejects.toThrow('unknown builtin plugin "missing"');
  });

  it("installs and loads a packaged builtin whose source files are omitted", async () => {
    const { targetRoot } = await copyPackagedBuiltinRuntime(workDir, [
      "automations",
    ]);
    const copiedRoot = join(targetRoot, "automations");

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "automations",
      rootDir: copiedRoot,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "automations",
        source: "builtin:automations",
        version: "0.1.0",
        enabled: true,
        status: "running",
        app: {
          hasApp: true,
          bundle: {
            compatible: true,
          },
        },
      },
    ]);
    expect(packagedLoadCount()).toBe(1);
  });

  it("registers but does not load a packaged builtin with stale backend metadata", async () => {
    const { targetRoot } = await copyPackagedBuiltinRuntime(workDir, [
      "automations",
    ]);
    const incompatibleMajor = PLUGIN_SDK_MAJOR + 1;
    const copiedRoot = join(targetRoot, "automations");
    await writeFile(
      join(copiedRoot, "dist", "server.meta.json"),
      JSON.stringify({
        sdkMajor: incompatibleMajor,
        sdkVersion: `${incompatibleMajor}.0.0`,
      }),
    );
    const before = packagedLoadCount();

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "automations",
      rootDir: copiedRoot,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "automations",
        source: "builtin:automations",
        version: "0.1.0",
        enabled: true,
        status: "incompatible",
        statusDetail: `server artifact for plugin "automations" was built for SDK major ${incompatibleMajor}, running SDK major is ${PLUGIN_SDK_MAJOR}; rebuild the server artifact with this sandy version`,
      },
    ]);
    expect(packagedLoadCount()).toBe(before);
  });

  it("explicitly installs a packaged builtin without rebuilding its app bundle", async () => {
    const { targetRoot } = await copyPackagedBuiltinRuntime(workDir, [
      "automations",
    ]);
    const copiedRoot = join(targetRoot, "automations");

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "automations",
      rootDir: copiedRoot,
    });

    await expect(
      service.install("builtin:automations", { kind: "root" }),
    ).resolves.toMatchObject({
      id: "automations",
      status: "running",
    });
    await expect(
      readFile(join(copiedRoot, "dist", "app.css"), "utf8"),
    ).resolves.toBe("/* built */\n");
  });
});

describe("builtin plugin packaging", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sandy-builtin-plugin-copy-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("copies only the runtime layout for packaged builtins", async () => {
    const { targetRoot } = await copyPackagedBuiltinRuntime(workDir, [
      "automations",
      "provider-acp",
      "connect",
    ]);

    const copiedRoot = join(targetRoot, "automations");
    const packageJson = JSON.parse(
      await readFile(join(copiedRoot, "package.json"), "utf8"),
    );
    expect(packageJson).toMatchObject({
      sandy: {
        server: "./dist/server.js",
        app: "./dist/app.js",
        skills: ["skills"],
      },
    });
    await expect(stat(join(copiedRoot, "package.json"))).resolves.toBeTruthy();
    await expect(
      stat(join(copiedRoot, "dist", "server.js")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(copiedRoot, "dist", "app.js")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(copiedRoot, "dist", "app.css")),
    ).resolves.toBeTruthy();
    await expect(stat(join(copiedRoot, "skills"))).resolves.toBeTruthy();
    await expect(
      readFile(join(copiedRoot, "assets", "icon.svg"), "utf8"),
    ).resolves.toBe("<svg/>\n");
    await expect(stat(join(copiedRoot, "src"))).rejects.toThrow();
    await expect(stat(join(copiedRoot, "app.tsx"))).rejects.toThrow();
    await expect(stat(join(copiedRoot, "node_modules"))).rejects.toThrow();

    await expect(
      readFile(join(targetRoot, "provider-acp", "icons", "cursor.svg"), "utf8"),
    ).resolves.toBe("<svg/>\n");

    const connectRoot = join(targetRoot, "connect");
    await expect(stat(join(connectRoot, "package.json"))).resolves.toBeTruthy();
    await expect(
      stat(join(connectRoot, "dist", "server.js")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(connectRoot, "dist", "app.js")),
    ).resolves.toBeTruthy();
    await expect(stat(join(connectRoot, "src"))).rejects.toThrow();
    await expect(stat(join(connectRoot, "node_modules"))).rejects.toThrow();

    await expect(stat(join(targetRoot, "memory"))).rejects.toThrow();
  });
});
