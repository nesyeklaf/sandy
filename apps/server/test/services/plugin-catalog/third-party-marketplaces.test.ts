import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  getInstalledPlugin,
  getPluginMarketplace,
  getPluginMarketplaceIcon,
  upsertInstalledPlugin,
  type DbConnection,
} from "@sandy/db";
import { createMigratedConnection } from "@sandy/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";

const run = promisify(execFile);

const BETA_URL = "https://beta.test/marketplace.json";
const ACME_URL = "https://acme.test/marketplace.json";

const VALID_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>',
);
const OTHER_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>',
);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "notes",
    displayName: "Acme Notes",
    description: "Notes beside a thread.",
    icon: "Zap",
    tags: ["git-tools"],
    author: { name: "Acme", github: "acme" },
    source: {
      git: { url: "https://github.com/acme/plugins.git", ref: "v1.0.0" },
    },
    ...overrides,
  };
}

function manifest(
  name: string,
  plugins: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    name,
    displayName: name === "acme-plugins" ? "Acme Plugins" : name,
    plugins,
    ...overrides,
  };
}

const SHA = "1234567890abcdef1234567890abcdef12345678";

function notesSource(ref: string) {
  return { git: { url: "https://github.com/acme/notes.git", ref } };
}

describe("third-party marketplaces", () => {
  let db: DbConnection;
  let dataDir: string;
  let installedCatalogEntries: unknown[];
  const cleanup: string[] = [];
  const restoreEnv: (() => void)[] = [];

  beforeEach(async () => {
    db = createMigratedConnection();
    installedCatalogEntries = [];
    dataDir = await mkdtemp(join(tmpdir(), "sandy-marketplace-data-"));
    cleanup.push(dataDir);
  });

  afterEach(async () => {
    db.$client.close();
    for (const restore of restoreEnv.splice(0)) restore();
    await Promise.all(
      cleanup
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  function service(options?: {
    documents?: Record<string, unknown>;
    icons?: Record<string, Record<string, Buffer>>;
    warn?: (message: string) => void;
    beforeInstall?: () => Promise<void>;
  }) {
    const catalog = createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      dataDir,
      bundledPlugins: [],
      plugins: {
        installOfficialPlugin: async () => {
          throw new Error("unexpected bundled install");
        },
        installCatalogPlugin: async (args: unknown) => {
          installedCatalogEntries.push(args);
          await options?.beforeInstall?.();
          throw new Error("catalog installation stopped by test");
        },
      },
      ...(options?.warn === undefined ? {} : { warn: options.warn }),
    });
    const published = new Map<string, string>();

    async function publish(url: string): Promise<string> {
      const document = options?.documents?.[url];
      if (document === undefined) throw new Error(`no document for ${url}`);
      let directory = published.get(url);
      if (directory === undefined) {
        directory = await mkdtemp(join(tmpdir(), "sandy-marketplace-doc-"));
        cleanup.push(directory);
        published.set(url, directory);
      }
      await writeFile(
        join(directory, "marketplace.json"),
        JSON.stringify(document),
      );
      for (const [relativePath, bytes] of Object.entries(
        options?.icons?.[url] ?? {},
      )) {
        const target = join(directory, relativePath);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, bytes);
      }
      return directory;
    }

    return {
      ...catalog,
      async addMarketplace(
        input: Parameters<typeof catalog.addMarketplace>[0],
      ) {
        if (options?.documents?.[input.source] === undefined) {
          return catalog.addMarketplace(input);
        }
        return catalog.addMarketplace({
          ...input,
          source: `path:${await publish(input.source)}`,
        });
      },
      async refreshMarketplaces(
        args?: Parameters<typeof catalog.refreshMarketplaces>[0],
      ) {
        for (const url of published.keys()) await publish(url);
        return catalog.refreshMarketplaces(args);
      },
    };
  }

  async function useGitUrlRewrite(url: string, repo: string): Promise<void> {
    const configFile = join(dataDir, "gitconfig");
    await writeFile(
      configFile,
      `[url "${repo.replaceAll("\\", "\\\\")}"]\n\tinsteadOf = ${url}\n`,
      "utf8",
    );
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = configFile;
    restoreEnv.push(() => {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    });
  }

  async function gitMarketplace(args: {
    name: string;
    plugins: unknown[];
    icon?: Buffer;
    subdirectory?: string;
  }): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "sandy-marketplace-repo-"));
    cleanup.push(repo);
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    const catalogDir =
      args.subdirectory === undefined
        ? repo
        : join(repo, ...args.subdirectory.split("/"));
    await mkdir(catalogDir, { recursive: true });
    await writeFile(
      join(catalogDir, "marketplace.json"),
      JSON.stringify(manifest(args.name, args.plugins)),
    );
    if (args.icon !== undefined) {
      await mkdir(join(catalogDir, "icons"), { recursive: true });
      await writeFile(join(catalogDir, "icons", "notes.svg"), args.icon);
    }
    await run("git", ["-c", "core.excludesFile=/dev/null", "add", "."], {
      cwd: repo,
    });
    await run("git", ["commit", "-qm", "catalog"], { cwd: repo });
    return repo;
  }

  describe("git marketplace lifecycle", () => {
    let repo: string;

    beforeEach(async () => {
      repo = await gitMarketplace({
        name: "acme-plugins",
        plugins: [entry({ icon: { url: "./icons/notes.svg" } })],
        icon: VALID_SVG,
      });
    });

    it.each([
      "catalog-next",
      "origin/catalog-next",
      "catalog-release",
      "commit",
    ])("reads the selected catalog commit for ref %s", async (ref) => {
      await run("git", ["checkout", "-qb", "catalog-next"], { cwd: repo });
      await writeFile(
        join(repo, "marketplace.json"),
        JSON.stringify(manifest("acme-plugins", [entry({ id: "next-notes" })])),
      );
      await run("git", ["commit", "-qam", "next catalog"], { cwd: repo });
      await run("git", ["tag", "-am", "catalog release", "catalog-release"], {
        cwd: repo,
      });
      const commit = (
        await run("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout.trim();
      await run("git", ["checkout", "-q", "main"], { cwd: repo });
      const catalog = service();

      const added = await catalog.addMarketplace({
        source: `git:${repo}@${ref === "commit" ? commit : ref}`,
        subdirectory: null,
      });

      expect(added.resolvedCommit).toBe(commit);
      expect(await catalog.search("Acme Notes")).toEqual([
        expect.objectContaining({ entryId: "next-notes" }),
      ]);
      if (ref === "catalog-next") {
        await run("git", ["checkout", "-q", "catalog-next"], { cwd: repo });
        await writeFile(
          join(repo, "marketplace.json"),
          JSON.stringify(
            manifest("acme-plugins", [entry({ id: "refreshed-notes" })]),
          ),
        );
        await run("git", ["commit", "-qam", "refresh catalog"], { cwd: repo });
        const refreshedCommit = (
          await run("git", ["rev-parse", "HEAD"], { cwd: repo })
        ).stdout.trim();
        await run("git", ["checkout", "-q", "main"], { cwd: repo });

        const [refreshed] = await catalog.refreshMarketplaces({
          name: "acme-plugins",
        });

        expect(refreshed).toMatchObject({
          ok: true,
          marketplace: { resolvedCommit: refreshedCommit },
        });
        expect(await catalog.search("Acme Notes")).toEqual([
          expect.objectContaining({ entryId: "refreshed-notes" }),
        ]);
      }
    });

    it("adds, refreshes, and removes a git marketplace read from a real checkout", async () => {
      const catalog = service();

      const added = await catalog.addMarketplace({
        source: `git:${repo}@main`,
        subdirectory: null,
      });
      expect(added).toMatchObject({
        name: "acme-plugins",
        displayName: "Acme Plugins",
        official: false,
        sourceKind: "git",
        source: `git:${repo}@main`,
        entryCount: 1,
      });
      expect(added.resolvedCommit).toMatch(/^[0-9a-f]{40}$/u);
      expect(installedCatalogEntries).toEqual([]);
      expect(
        getPluginMarketplaceIcon(db, "acme-plugins", "notes")?.contentType,
      ).toBe("image/svg+xml");
      expect(
        await rm(join(dataDir, "marketplaces", "staging"), {
          recursive: true,
          force: true,
        }).then(() => true),
      ).toBe(true);

      await writeFile(
        join(repo, "marketplace.json"),
        JSON.stringify(
          manifest("acme-plugins", [
            entry({ icon: { url: "./icons/notes.svg" } }),
            entry({ id: "status", displayName: "Acme Status", icon: "Zap" }),
          ]),
        ),
      );
      await run("git", ["commit", "-qam", "second"], { cwd: repo });
      const [refreshed] = await catalog.refreshMarketplaces({
        name: "acme-plugins",
      });
      expect(refreshed).toMatchObject({ name: "acme-plugins", ok: true });
      expect(refreshed?.marketplace.entryCount).toBe(2);
      expect(refreshed?.marketplace.resolvedCommit).not.toBe(
        added.resolvedCommit,
      );

      const removed = await catalog.removeMarketplace("acme-plugins");
      expect(removed.convertedPluginIds).toEqual([]);
      expect(getPluginMarketplace(db, "acme-plugins")).toBeUndefined();
      expect(
        getPluginMarketplaceIcon(db, "acme-plugins", "notes"),
      ).toBeUndefined();
      expect(catalog.listMarketplaces().map((row) => row.name)).toEqual([
        "sandy-official",
      ]);

      const readded = await catalog.addMarketplace({
        source: `git:${repo}@main`,
        subdirectory: null,
      });
      expect(readded).toMatchObject({
        name: "acme-plugins",
        entryCount: 2,
        resolvedCommit: refreshed?.marketplace.resolvedCommit,
      });
      expect(
        getPluginMarketplaceIcon(db, "acme-plugins", "notes")?.contentType,
      ).toBe("image/svg+xml");
    });
  });

  describe("git marketplace in a subdirectory", () => {
    let repo: string;

    beforeEach(async () => {
      repo = await gitMarketplace({
        name: "acme-plugins",
        plugins: [entry({ icon: { url: "./icons/notes.svg" } })],
        icon: VALID_SVG,
        subdirectory: "tools/sandy",
      });
      await writeFile(
        join(repo, "marketplace.json"),
        JSON.stringify(manifest("root-plugins", [entry({ id: "root" })])),
      );
      await run("git", ["add", "marketplace.json"], { cwd: repo });
      await run("git", ["commit", "-qm", "root catalog"], { cwd: repo });
    });

    async function stagedCheckouts(): Promise<string[]> {
      return readdir(join(dataDir, "marketplaces", "staging")).catch(() => []);
    }

    it("reads the catalog and its icons from the subdirectory on add and on refresh", async () => {
      const catalog = service();

      const added = await catalog.addMarketplace({
        source: `git:${repo}@main`,
        subdirectory: "./tools/sandy",
      });

      expect(added).toMatchObject({
        name: "acme-plugins",
        sourceKind: "git",
        source: `git:${repo}@main`,
        subdirectory: "tools/sandy",
        entryCount: 1,
      });
      expect(
        getPluginMarketplaceIcon(db, "acme-plugins", "notes")?.contentType,
      ).toBe("image/svg+xml");
      expect(await stagedCheckouts()).toEqual([]);

      await writeFile(
        join(repo, "tools", "sandy", "marketplace.json"),
        JSON.stringify(
          manifest("acme-plugins", [
            entry({ icon: { url: "./icons/notes.svg" } }),
            entry({ id: "status", displayName: "Acme Status", icon: "Zap" }),
          ]),
        ),
      );
      await run("git", ["commit", "-qam", "second"], { cwd: repo });
      const [refreshed] = await catalog.refreshMarketplaces({
        name: "acme-plugins",
      });

      expect(refreshed).toMatchObject({
        name: "acme-plugins",
        ok: true,
        marketplace: { subdirectory: "tools/sandy", entryCount: 2 },
      });
      expect(getPluginMarketplace(db, "acme-plugins")).toMatchObject({
        sourceGitRef: "main",
        sourceGitSubdirectory: "tools/sandy",
      });
      expect(
        catalog
          .listMarketplaces()
          .map((marketplace) => [marketplace.name, marketplace.subdirectory]),
      ).toEqual([
        ["sandy-official", null],
        ["acme-plugins", "tools/sandy"],
      ]);
    });

    it("keeps reading the repository root when no subdirectory is given", async () => {
      const catalog = service();

      const added = await catalog.addMarketplace({
        source: `git:${repo}@main`,
        subdirectory: null,
      });

      expect(added).toMatchObject({ name: "root-plugins", subdirectory: null });
    });

    it.each([
      ["../outside", /invalid marketplace subdirectory/u],
      ["/etc", /invalid marketplace subdirectory/u],
      ["tools/../..", /invalid marketplace subdirectory/u],
      [".git", /invalid marketplace subdirectory/u],
      ["tools\\sandy", /invalid marketplace subdirectory/u],
      [
        "tools/missing",
        /"tools\/missing" is not a directory in the repository/u,
      ],
      [
        "tools/sandy/marketplace.json",
        /"tools\/sandy\/marketplace.json" is not a directory in the repository/u,
      ],
    ])("refuses the subdirectory %s", async (subdirectory, message) => {
      const catalog = service();

      await expect(
        catalog.addMarketplace({ source: `git:${repo}@main`, subdirectory }),
      ).rejects.toThrow(message);

      expect(getPluginMarketplace(db, "acme-plugins")).toBeUndefined();
      expect(await stagedCheckouts()).toEqual([]);
    });

    it.skipIf(process.platform === "win32")(
      "refuses a subdirectory that is a symlink out of the checkout",
      async () => {
        const outside = await mkdtemp(join(tmpdir(), "sandy-marketplace-out-"));
        cleanup.push(outside);
        await writeFile(
          join(outside, "marketplace.json"),
          JSON.stringify(manifest("acme-plugins", [entry()])),
        );
        await symlink(outside, join(repo, "escape"));
        await run("git", ["add", "escape"], { cwd: repo });
        await run("git", ["commit", "-qm", "escape"], { cwd: repo });
        const catalog = service();

        await expect(
          catalog.addMarketplace({
            source: `git:${repo}@main`,
            subdirectory: "escape",
          }),
        ).rejects.toThrow(
          /marketplace subdirectory resolves outside its root/u,
        );

        expect(getPluginMarketplace(db, "acme-plugins")).toBeUndefined();
        expect(await stagedCheckouts()).toEqual([]);
      },
    );

    it.each([ACME_URL, "path:/work/acme-marketplace"])(
      "refuses a subdirectory for the source %s",
      async (source) => {
        const catalog = service({
          documents: {
            [ACME_URL]: manifest("acme-plugins", [entry()]),
          },
        });

        await expect(
          catalog.addMarketplace({ source, subdirectory: "sandy" }),
        ).rejects.toThrow(/a subdirectory applies to git: sources only/u);
      },
    );
  });

  it("removes a checkout left by a prior process crash", async () => {
    const repo = await gitMarketplace({
      name: "acme-plugins",
      plugins: [entry()],
    });
    const staleCheckout = join(
      dataDir,
      "marketplaces",
      "staging",
      "stale-checkout",
    );
    await mkdir(staleCheckout, { recursive: true });
    await writeFile(join(staleCheckout, "marketplace.json"), "stale");

    const catalog = service();
    await catalog.addMarketplace({
      source: `git:${repo}@main`,
      subdirectory: null,
    });

    expect(await stat(staleCheckout).catch(() => null)).toBeNull();
  });

  it("reads a path marketplace and its icons in place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandy-marketplace-dir-"));
    cleanup.push(directory);
    await mkdir(join(directory, "icons"), { recursive: true });
    await writeFile(join(directory, "icons", "notes.svg"), VALID_SVG);
    await writeFile(
      join(directory, "marketplace.json"),
      JSON.stringify(
        manifest("acme-plugins", [
          entry({ icon: { url: "./icons/notes.svg" } }),
        ]),
      ),
    );
    const catalog = service();

    const added = await catalog.addMarketplace({
      source: `path:${directory}`,
      subdirectory: null,
    });
    expect(added).toMatchObject({
      name: "acme-plugins",
      sourceKind: "path",
      source: `path:${directory}`,
      resolvedCommit: null,
      entryCount: 1,
    });
    expect(getPluginMarketplaceIcon(db, "acme-plugins", "notes")).toBeDefined();
  });

  it("rejects a bundled source from a fetched marketplace", async () => {
    const bundledUrl = "https://acme.test/bundled-marketplace.json";
    const catalog = service({
      documents: {
        [bundledUrl]: {
          schemaVersion: 2,
          name: "acme-bundled",
          displayName: "Acme Bundled",
          plugins: [entry({ source: { bundled: { plugin: "docs" } } })],
        },
      },
    });

    await expect(
      catalog.addMarketplace({ source: bundledUrl, subdirectory: null }),
    ).rejects.toThrow(/not allowed in fetched or third-party documents/u);
  });

  it("refuses name collisions and reserved marketplace names", async () => {
    const catalog = service({
      documents: {
        [ACME_URL]: manifest("acme-plugins", [entry()]),
        "https://official-impostor.test/marketplace.json": manifest(
          "sandy-official",
          [entry()],
        ),
        "https://other.test/marketplace.json": manifest("acme-plugins", [
          entry({ id: "other" }),
        ]),
      },
    });

    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });
    await expect(
      catalog.addMarketplace({
        source: "https://other.test/marketplace.json",
        subdirectory: null,
      }),
    ).rejects.toThrow('marketplace "acme-plugins" is already added');
    await expect(
      catalog.addMarketplace({
        source: "https://official-impostor.test/marketplace.json",
        subdirectory: null,
      }),
    ).rejects.toThrow(/"sandy-official" is reserved/);
    await expect(catalog.removeMarketplace("sandy-official")).rejects.toThrow(
      /cannot be removed/,
    );
    expect(catalog.listMarketplaces().map((row) => row.name)).toEqual([
      "sandy-official",
      "acme-plugins",
    ]);
  });

  it("refuses an ambiguous bare install and installs the qualified one", async () => {
    const catalog = service({
      documents: {
        [BETA_URL]: manifest("beta-plugins", [
          entry({
            id: "notes",
            displayName: "Beta Notes",
            source: notesSource(SHA),
          }),
        ]),
        [ACME_URL]: manifest("acme-plugins", [
          entry({ source: notesSource(SHA) }),
        ]),
      },
    });
    await catalog.addMarketplace({ source: BETA_URL, subdirectory: null });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });

    await expect(catalog.install({ entryId: "notes" })).rejects.toThrow(
      "notes@acme-plugins, notes@beta-plugins",
    );
    expect(installedCatalogEntries).toEqual([]);

    await expect(
      catalog.install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: {
          kind: "git",
          url: "https://github.com/acme/notes.git",
          ref: SHA,
          resolvedCommit: SHA,
        },
      }),
    ).rejects.toThrow("catalog installation stopped by test");
    expect(installedCatalogEntries).toEqual([
      {
        marketplace: "acme-plugins",
        entryId: "notes",
        pluginId: "notes",
        source: `git:https://github.com/acme/notes.git@${SHA}`,
        selection: { kind: "root" },
        expectedGitCommit: SHA,
      },
    ]);
  });

  it("names a bundled official plugin with <id>@sandy-official", async () => {
    const catalog = createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      dataDir,
      plugins: {
        installOfficialPlugin: async (name: string) => {
          installedCatalogEntries.push({ bundled: name });
          throw new Error("bundled installation stopped by test");
        },
        installCatalogPlugin: async () => {
          throw new Error("unexpected catalog install");
        },
      },
    });

    await expect(
      catalog.install({ entryId: "docs", marketplace: "sandy-official" }),
    ).rejects.toThrow(/bundled installation stopped by test/u);
    await expect(
      catalog.install({ entryId: "docs", marketplace: "acme-plugins" }),
    ).rejects.toThrow('unknown marketplace "acme-plugins"');
  });

  it("installs a single marketplace match from a bare entry id", async () => {
    const catalog = service({
      documents: {
        [ACME_URL]: manifest("acme-plugins", [
          entry({ source: notesSource(SHA) }),
        ]),
      },
    });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });

    await expect(
      catalog.install({
        entryId: "notes",
        confirmedSource: {
          kind: "git",
          url: "https://github.com/acme/notes.git",
          ref: SHA,
          resolvedCommit: SHA,
        },
      }),
    ).rejects.toThrow("catalog installation stopped by test");
    expect(installedCatalogEntries).toHaveLength(1);
    await expect(catalog.install({ entryId: "missing" })).rejects.toThrow(
      'unknown plugin catalog entry "missing"',
    );
  });

  it("refuses a third-party source that changed after confirmation", async () => {
    const documents: Record<string, unknown> = {
      [ACME_URL]: manifest("acme-plugins", [
        entry({ source: notesSource(SHA) }),
      ]),
    };
    const catalog = service({ documents });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });
    const plan = await catalog.installPlan({
      entryId: "notes",
      marketplace: "acme-plugins",
    });
    if (plan.kind !== "marketplace") throw new Error("expected a listing");

    documents[ACME_URL] = manifest("acme-plugins", [
      entry({
        source: notesSource("abcdef1234567890abcdef1234567890abcdef12"),
      }),
    ]);
    await catalog.refreshMarketplaces({ name: "acme-plugins" });

    await expect(
      catalog.install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: plan.resolvedSource,
      }),
    ).rejects.toThrow(/source changed after confirmation/u);
    expect(installedCatalogEntries).toEqual([]);
  });

  it("keeps installed plugins updatable after their marketplace is removed", async () => {
    const catalog = service({
      documents: {
        [ACME_URL]: manifest("acme-plugins", [entry()]),
      },
    });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });
    upsertInstalledPlugin(db, {
      id: "notes",
      source: "git:https://github.com/acme/plugins.git@semver:^1.0.0",
      provenance: {
        kind: "catalog",
        marketplace: "acme-plugins",
        entryId: "notes",
      },
      sourceIntent: {
        kind: "git",
        url: "https://github.com/acme/plugins.git",
        subdirectory: "plugins/notes",
        selector: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "notes/",
          resolvedTag: "notes/v1.0.0",
        },
      },
      exactResolution: { kind: "git", commit: "a".repeat(40) },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/plugins/notes",
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });

    const removed = await catalog.removeMarketplace("acme-plugins");
    expect(removed.convertedPluginIds).toEqual(["notes"]);

    const row = getInstalledPlugin(db, "notes");
    expect(row).toMatchObject({
      provenance: "direct",
      catalogEntryId: null,
      catalogMarketplaceName: null,
      sourceKind: "git",
      sourceGitUrl: "https://github.com/acme/plugins.git",
      sourceGitSubdirectory: "plugins/notes",
      sourceGitRange: "^1.0.0",
      sourceGitTagPrefix: "notes/",
      sourceGitResolvedTag: "notes/v1.0.0",
      gitResolvedCommit: "a".repeat(40),
      enabled: true,
      removedAt: null,
    });
  });

  it("keeps icons and catalogs isolated between marketplaces", async () => {
    const catalog = service({
      documents: {
        [BETA_URL]: manifest("beta-plugins", [
          entry({ id: "beta-notes", icon: { url: "./icons/a.svg" } }),
        ]),
        [ACME_URL]: manifest("acme-plugins", [
          entry({ icon: { url: "./icons/b.svg" } }),
        ]),
      },
      icons: {
        [BETA_URL]: { "icons/a.svg": VALID_SVG },
        [ACME_URL]: { "icons/b.svg": OTHER_SVG },
      },
    });
    await catalog.addMarketplace({ source: BETA_URL, subdirectory: null });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });

    const beta = getPluginMarketplaceIcon(db, "beta-plugins", "beta-notes");
    const acme = getPluginMarketplaceIcon(db, "acme-plugins", "notes");
    expect(beta?.contentHash).not.toBe(acme?.contentHash);
    expect(
      getPluginMarketplaceIcon(db, "beta-plugins", "notes"),
    ).toBeUndefined();
    expect(
      getPluginMarketplaceIcon(db, "acme-plugins", "beta-notes"),
    ).toBeUndefined();

    await catalog.removeMarketplace("acme-plugins");
    expect(
      getPluginMarketplaceIcon(db, "beta-plugins", "beta-notes"),
    ).toBeDefined();
    expect(
      getPluginMarketplaceIcon(db, "acme-plugins", "notes"),
    ).toBeUndefined();
  });

  it("keeps serving a marketplace when its refresh fails", async () => {
    const warnings: string[] = [];
    const documents: Record<string, unknown> = {
      [ACME_URL]: manifest("acme-plugins", [entry()]),
      [BETA_URL]: manifest("beta-plugins", [entry({ id: "beta-notes" })]),
    };
    const catalog = service({
      warn: (message) => warnings.push(message),
      documents,
    });
    await catalog.addMarketplace({ source: BETA_URL, subdirectory: null });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });
    documents[ACME_URL] = { schemaVersion: 1 };

    const results = await catalog.refreshMarketplaces({ attemptedAt: 2_000 });
    expect(results).toMatchObject([
      { name: "sandy-official", ok: true },
      { name: "acme-plugins", ok: false },
      { name: "beta-plugins", ok: true },
    ]);
    expect(results[1]?.error).toBeTruthy();

    const marketplaces = catalog.listMarketplaces();
    expect(marketplaces[1]).toMatchObject({
      name: "acme-plugins",
      entryCount: 1,
      lastAttemptAt: 2_000,
    });
    expect(marketplaces[2]).toMatchObject({
      name: "beta-plugins",
      lastRefreshAt: 2_000,
      lastError: null,
    });
    const searched = await catalog.search("");
    expect(searched.map((result) => result.entryId).sort()).toEqual([
      "beta-notes",
      "notes",
    ]);
  });

  it("groups search results by marketplace", async () => {
    const catalog = service({
      documents: {
        [BETA_URL]: manifest("beta-plugins", [
          entry({ id: "beta-notes", tags: ["interface"] }),
        ]),
        [ACME_URL]: manifest("acme-plugins", [
          entry({ tags: ["git-tools"] }),
          entry({ id: "zebra", displayName: "Zebra", tags: ["git-tools"] }),
        ]),
      },
    });
    await catalog.addMarketplace({ source: BETA_URL, subdirectory: null });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });

    const results = await catalog.search("");
    expect(
      results.map((result) => [
        result.marketplace,
        result.category,
        result.entryId,
      ]),
    ).toEqual([
      ["acme-plugins", "Git Tools", "notes"],
      ["acme-plugins", "Git Tools", "zebra"],
      ["beta-plugins", "Interface", "beta-notes"],
    ]);
    expect(results[0]).toMatchObject({
      official: false,
      marketplaceDisplayName: "Acme Plugins",
      author: { name: "Acme", url: "https://github.com/acme" },
    });
  });

  describe("install plans", () => {
    it("resolves a third-party git range to its current tag and commit", async () => {
      const repo = await mkdtemp(join(tmpdir(), "sandy-plugin-repo-"));
      cleanup.push(repo);
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      });
      await run("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "one");
      await run("git", ["add", "."], { cwd: repo });
      await run("git", ["commit", "-qm", "one"], { cwd: repo });
      await run("git", ["tag", "notes/v1.0.0"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "two");
      await run("git", ["commit", "-qam", "two"], { cwd: repo });
      await run("git", ["tag", "notes/v1.2.0"], { cwd: repo });
      await run("git", ["tag", "notes/v2.0.0"], { cwd: repo });
      const expected = (
        await run("git", ["rev-parse", "notes/v1.2.0"], { cwd: repo })
      ).stdout.trim();
      const listedUrl = "https://acme.test/sandy-plugins.git";
      await useGitUrlRewrite(listedUrl, repo);

      const catalog = service({
        documents: {
          [ACME_URL]: manifest("acme-plugins", [
            entry({
              source: {
                git: {
                  url: listedUrl,
                  subdir: "plugins/notes",
                  range: "^1.0.0",
                  tagPrefix: "notes/",
                },
              },
            }),
          ]),
        },
      });
      await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });

      const plan = await catalog.installPlan({
        entryId: "notes",
        marketplace: "acme-plugins",
      });
      expect(plan).toMatchObject({
        kind: "marketplace",
        entryId: "notes",
        marketplace: "acme-plugins",
        official: false,
        author: { name: "Acme", url: "https://github.com/acme" },
        source: `git:${listedUrl}@semver:notes/:^1.0.0`,
        resolvedSource: {
          kind: "git",
          url: listedUrl,
          subdir: "plugins/notes",
          range: "^1.0.0",
          tagPrefix: "notes/",
          resolvedTag: "notes/v1.2.0",
          resolvedCommit: expected,
        },
        compatible: true,
      });
    });

    it("reports an unresolvable git source instead of failing the plan", async () => {
      const catalog = service({
        documents: {
          [ACME_URL]: manifest("acme-plugins", [
            entry({
              source: {
                git: {
                  url: "https://acme.invalid/missing.git",
                  ref: "v9.9.9",
                },
              },
            }),
          ]),
        },
      });
      await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });

      const plan = await catalog.installPlan({
        entryId: "notes",
        marketplace: "acme-plugins",
      });
      expect(plan).toMatchObject({ kind: "marketplace" });
      if (plan.kind !== "marketplace") throw new Error("expected a listing");
      expect(plan.resolvedSource).toMatchObject({
        kind: "git",
        ref: "v9.9.9",
      });
      expect(
        plan.resolvedSource.kind === "git"
          ? plan.resolvedSource.unresolvedReason
          : undefined,
      ).toBeDefined();
    });
  });

  it("adds a local manifest larger than 1 MiB", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandy-marketplace-big-"));
    cleanup.push(directory);
    const padded = manifest("acme-plugins", [
      entry({ description: "x".repeat(1_100_000) }),
    ]);
    await writeFile(
      join(directory, "marketplace.json"),
      JSON.stringify(padded),
    );
    const catalog = service();

    await catalog.addMarketplace({
      source: `path:${directory}`,
      subdirectory: null,
    });
    expect(getPluginMarketplace(db, "acme-plugins")?.lastError).toBeNull();
    expect(await catalog.search("Acme Notes")).toEqual([
      expect.objectContaining({ entryId: "notes" }),
    ]);
  });

  it("holds the marketplace lock across an install", async () => {
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const catalog = service({
      documents: {
        [ACME_URL]: manifest("acme-plugins", [
          entry({ source: notesSource(SHA) }),
        ]),
      },
      beforeInstall: () => gate,
    });
    await catalog.addMarketplace({ source: ACME_URL, subdirectory: null });
    const plan = await catalog.installPlan({
      entryId: "notes",
      marketplace: "acme-plugins",
    });
    if (plan.kind !== "marketplace") throw new Error("expected a marketplace");

    const install = catalog
      .install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: plan.resolvedSource,
      })
      .catch((error: unknown) => {
        order.push("install");
        throw error;
      });
    const removal = catalog.removeMarketplace("acme-plugins").then((result) => {
      order.push("removal");
      return result;
    });
    release();

    await expect(install).rejects.toThrow(
      "catalog installation stopped by test",
    );
    await expect(removal).resolves.toMatchObject({ convertedPluginIds: [] });
    expect(order).toEqual(["install", "removal"]);
    expect(installedCatalogEntries).toEqual([
      expect.objectContaining({ marketplace: "acme-plugins" }),
    ]);
    expect(getPluginMarketplace(db, "acme-plugins")).toBeUndefined();
  });

  it("refuses a manifest name that later routes cannot address", async () => {
    const catalog = service({
      documents: {
        [ACME_URL]: manifest("a".repeat(65), [entry()]),
      },
    });

    await expect(
      catalog.addMarketplace({ source: ACME_URL, subdirectory: null }),
    ).rejects.toThrow(/invalid marketplace manifest/u);
    expect(getPluginMarketplace(db, "a".repeat(65))).toBeUndefined();
  });

  it("refuses a marketplace source sandy cannot interpret", async () => {
    const catalog = service();
    await expect(
      catalog.addMarketplace({
        source: "acme/marketplace",
        subdirectory: null,
      }),
    ).rejects.toThrow(/invalid marketplace source/u);
    await expect(
      catalog.addMarketplace({
        source: "https://acme.test/marketplace.json",
        subdirectory: null,
      }),
    ).rejects.toThrow(/invalid marketplace source/u);
    await expect(
      catalog.addMarketplace({
        source: "git:https://acme.test/repo.git@^1.0.0",
        subdirectory: null,
      }),
    ).rejects.toThrow(/names one branch, tag, or commit/u);
  });
});
