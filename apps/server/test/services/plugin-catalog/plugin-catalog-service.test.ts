import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getInstalledPlugin,
  getPluginMarketplace,
  markInstalledPluginRemoved,
  upsertPluginMarketplace,
  upsertInstalledPlugin,
  type DbConnection,
  type PluginSourceIntent,
} from "@sandy/db";
import { createMigratedConnection } from "@sandy/db/testing";
import { PLUGIN_CATALOG_CATEGORIES } from "@sandy/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";
import {
  SERVER_MOVE_FROZEN_RETRY_MS,
  setServerMoveFrozen,
} from "../../../src/services/server-move/freeze-state.js";
import { loadBundledMarketplace } from "../../../src/services/plugin-catalog/bundled-marketplace.js";
import {
  BUILTIN_PLUGINS,
  BUNDLED_PLUGINS,
  OFFICIAL_PLUGINS,
  listBundledPluginRegistrations,
} from "../../../src/services/plugins/builtin-registry.js";

const OFFICIAL_ORDER =
  loadBundledMarketplace(listBundledPluginRegistrations()).catalog
    .collections?.[0]?.pluginIds ?? [];

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

const VALID_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>',
);

function remoteEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "widgets",
    displayName: "Acme Widgets",
    description: "Widgets for threads.",
    icon: { url: "./icons/widgets.svg" },
    tags: ["interface", "widgets"],
    author: { name: "Acme", github: "acme" },
    source: {
      git: {
        url: "https://github.com/acme/plugins.git",
        subdir: "plugins/widgets",
        ref: "v1.0.0",
      },
    },
    ...overrides,
  };
}

function manifest(plugins: unknown[]): unknown {
  return {
    schemaVersion: 1,
    name: "acme-plugins",
    displayName: "Acme Plugins",
    plugins,
  };
}

function manifestV2(
  plugins: unknown[],
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    schemaVersion: 2,
    name: "acme-plugins",
    displayName: "Acme Plugins",
    plugins,
    ...overrides,
  };
}

describe("plugin catalog service", () => {
  let db: DbConnection;
  let installedNames: string[];
  let installedCatalogEntries: unknown[];

  let dataDir: string;

  beforeEach(async () => {
    db = createMigratedConnection();
    installedNames = [];
    installedCatalogEntries = [];
    dataDir = await mkdtemp(join(tmpdir(), "sandy-catalog-data-"));
  });

  afterEach(async () => {
    db.$client.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function service(options?: {
    bundledPlugins?: Parameters<
      typeof createPluginCatalogService
    >[0]["bundledPlugins"];
    warn?: (message: string) => void;
  }) {
    return createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      dataDir,
      plugins: {
        installOfficialPlugin: async (name: string) => {
          installedNames.push(name);
          throw new Error("installation stopped by test");
        },
        installCatalogPlugin: async (args: unknown) => {
          installedCatalogEntries.push(args);
          throw new Error("catalog installation stopped by test");
        },
      },
      ...(options?.bundledPlugins === undefined
        ? {}
        : { bundledPlugins: options.bundledPlugins }),
      ...(options?.warn === undefined ? {} : { warn: options.warn }),
    });
  }

  function registerInstalledOfficial(args: {
    pluginId: string;
    name: string;
  }): void {
    upsertInstalledPlugin(db, {
      id: args.pluginId,
      source: `builtin:${args.name}`,
      provenance: {
        kind: "catalog",
        marketplace: "sandy-official",
        entryId: args.name,
      },
      sourceIntent: { kind: "builtin", name: args.name },
      exactResolution: { kind: "builtin" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: `/bundled/${args.name}`,
      version: "0.0.1",
      enabled: true,
      enabledFollowsDefault: false,
    });
  }

  async function addDirectoryMarketplace(
    catalog: ReturnType<typeof service>,
    marketplaceManifest: unknown,
    files: Record<string, Buffer> = {},
  ): Promise<void> {
    const directory = await mkdtemp(join(dataDir, "marketplace-"));
    await writeFile(
      join(directory, "marketplace.json"),
      JSON.stringify(marketplaceManifest),
    );
    for (const [relativePath, bytes] of Object.entries(files)) {
      const target = join(directory, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    await catalog.addMarketplace({
      source: `path:${directory}`,
      subdirectory: null,
    });
  }

  it("lists the bundled catalog", async () => {
    const catalog = service();
    expect(catalog.status()).toEqual({
      pluginCount: BUNDLED_PLUGINS.length,
      includedPluginCount: BUILTIN_PLUGINS.length,
      optionalPluginCount: OFFICIAL_PLUGINS.length,
    });

    const results = await catalog.search("");
    expect(results.map((entry) => entry.entryId).sort()).toEqual(
      BUNDLED_PLUGINS.map((plugin) => plugin.name).sort(),
    );
    const docs = results.find((entry) => entry.entryId === "docs");
    expect(docs).toMatchObject({
      pluginId: "simple-notes",
      displayName: "Docs",
      icon: "FileText",
      iconUrl: null,
      category: "File Viewers & Editors",
      screenshots: [],
      collections: [
        { id: "sandy-official", rank: OFFICIAL_ORDER.indexOf("simple-notes") },
      ],
      source: "builtin:docs",
      marketplace: "sandy-official",
      marketplaceDisplayName: "SANDY Official",
      publisherKey: "sandy-official",
      publisherLabel: "SANDY Official",
      author: { name: "SANDY", url: null },
      installed: false,
      installedByDefault: false,
      compatible: true,
    });
    expect(
      Object.fromEntries(
        results.map((entry) => [entry.entryId, entry.installedByDefault]),
      ),
    ).toEqual(
      Object.fromEntries(
        BUNDLED_PLUGINS.map((plugin) => [plugin.name, plugin.autoInstall]),
      ),
    );
    expect(catalog.collections()).toEqual([
      {
        id: "sandy-official",
        displayName: "SANDY Official",
        pluginIds: OFFICIAL_ORDER,
      },
    ]);
    for (const category of PLUGIN_CATALOG_CATEGORIES) {
      const categoryNames = results
        .filter((entry) => entry.category === category.displayName)
        .map((entry) => entry.displayName);
      expect(categoryNames).toEqual(
        [...categoryNames].sort((a, b) => a.localeCompare(b)),
      );
    }
  });

  it("matches queries against entry id, plugin id, manifest text, and tags", async () => {
    const catalog = service();
    expect(
      (await catalog.search("docs")).map((entry) => entry.entryId),
    ).toContain("docs");
    expect(
      (await catalog.search("simple-notes")).map((entry) => entry.entryId),
    ).toEqual(["docs"]);
    expect(await catalog.search("no-such-plugin")).toEqual([]);
  });

  it("reflects install and remove in the installed flag", async () => {
    const catalog = service();
    registerInstalledOfficial({ pluginId: "simple-notes", name: "docs" });
    expect((await catalog.search("docs"))[0]?.installed).toBe(true);

    markInstalledPluginRemoved(db, "simple-notes");
    expect((await catalog.search("docs"))[0]?.installed).toBe(false);
  });

  it("delegates install to the plugin service by bundled name", async () => {
    const catalog = service();
    await expect(catalog.install({ entryId: "docs" })).rejects.toThrow(
      "installation stopped by test",
    );
    expect(installedNames).toEqual(["docs"]);
  });

  it("drops entries whose bundled manifest is unreadable", async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), "sandy-missing-plugin-"));
    await rm(missingRoot, { recursive: true, force: true });
    const warnings: string[] = [];
    const registrations = listBundledPluginRegistrations();
    const github = registrations.find((plugin) => plugin.name === "github");
    const workflows = registrations.find(
      (plugin) => plugin.name === "workflows",
    );
    if (github === undefined || workflows === undefined) {
      throw new Error("bundled registration missing");
    }
    const catalog = service({
      bundledPlugins: [
        {
          ...github,
          rootDir: missingRoot,
        },
        workflows,
      ],
      warn: (message) => warnings.push(message),
    });
    const results = await catalog.search("");
    expect(results.map((entry) => entry.entryId)).not.toContain("github");
    expect(results.map((entry) => entry.entryId)).toContain("workflows");
    expect(warnings.some((warning) => warning.includes("github"))).toBe(true);
  });

  it("serves a bundled entry's own compact icon from the catalog route", async () => {
    const registrations = listBundledPluginRegistrations();
    const withSvg = registrations.find(
      (plugin) => plugin.name === "provider-acp",
    );
    const withGlyph = registrations.find(
      (plugin) => plugin.name === "workflows",
    );
    if (withSvg === undefined || withGlyph === undefined) {
      throw new Error("expected bundled registrations");
    }
    const catalog = service({ bundledPlugins: [withSvg, withGlyph] });

    const results = await catalog.search("");
    const svgEntry = results.find((entry) => entry.entryId === withSvg.name);
    const glyphEntry = results.find(
      (entry) => entry.entryId === withGlyph.name,
    );
    expect(svgEntry?.icon?.startsWith("./")).toBe(true);
    const icon = await catalog.icon("sandy-official", withSvg.name);
    expect(icon?.contentType).toBe("image/svg+xml");
    expect(svgEntry?.iconUrl).toBe(
      `/api/v1/plugin-catalog/icons/sandy-official/${withSvg.name}?h=${icon?.hash}`,
    );
    expect(new TextDecoder().decode(icon?.bytes)).toContain("<svg");
    expect(svgEntry?.iconTinted).toBe(true);

    expect(glyphEntry?.iconUrl).toBeNull();
    expect(glyphEntry?.iconTinted).toBe(false);
    expect(await catalog.icon("sandy-official", withGlyph.name)).toBeUndefined();
  });

  describe("marketplace rows", () => {
    it("ignores collections from a third-party marketplace", async () => {
      const catalog = service();
      upsertPluginMarketplace(db, {
        name: "acme",
        sourceKind: "path",
        manifestUrl: dataDir,
        sourceGitRef: null,
        sourceGitSubdirectory: null,
        sourceGitCommit: null,
        manifestJson: JSON.stringify(
          manifestV2([remoteEntry({ icon: "Zap" })], {
            name: "acme",
            displayName: "Acme",
            collections: [
              {
                id: "featured",
                displayName: "Featured",
                pluginIds: ["widgets"],
              },
            ],
          }),
        ),
        lastSuccessfulRefreshAt: 1_000,
        lastAttemptedRefreshAt: 1_000,
        lastError: null,
      });

      expect((await catalog.search("widgets"))[0]?.collections).toEqual([]);
      expect(catalog.collections()).toEqual([
        {
          id: "sandy-official",
          displayName: "SANDY Official",
          pluginIds: OFFICIAL_ORDER,
        },
      ]);
    });

    it("tints a catalog SVG but keeps a raster icon's own colors", async () => {
      const catalog = service();
      await addDirectoryMarketplace(
        catalog,
        manifest([
          remoteEntry({ id: "raster", icon: { url: "./icons/raster.png" } }),
          remoteEntry({ id: "glyph", icon: { url: "./icons/glyph.svg" } }),
        ]),
        { "icons/raster.png": VALID_PNG, "icons/glyph.svg": VALID_SVG },
      );

      const tinted = Object.fromEntries(
        (await catalog.search("")).map((entry) => [
          entry.entryId,
          { iconUrl: entry.iconUrl !== null, iconTinted: entry.iconTinted },
        ]),
      );
      expect(tinted).toMatchObject({
        raster: { iconUrl: true, iconTinted: false },
        glyph: { iconUrl: true, iconTinted: true },
      });
    });

    it("keeps an entry whose icon fails validation and warns", async () => {
      const warnings: string[] = [];
      const catalog = service({ warn: (message) => warnings.push(message) });
      await addDirectoryMarketplace(
        catalog,
        manifest([remoteEntry({ icon: { url: "./icons/widgets.svg" } })]),
        { "icons/widgets.svg": Buffer.from("not an svg") },
      );

      const [entry] = await catalog.search("widgets");
      expect(entry).toMatchObject({ entryId: "widgets", iconUrl: null });
      expect(warnings.some((warning) => warning.includes("icon"))).toBe(true);
    });

    it("rejects an icon declared as a remote URL", async () => {
      const warnings: string[] = [];
      const catalog = service({ warn: (message) => warnings.push(message) });
      await addDirectoryMarketplace(
        catalog,
        manifest([
          remoteEntry({ icon: { url: "https://cdn.example/widgets.svg" } }),
        ]),
      );

      const [entry] = await catalog.search("widgets");
      expect(entry?.iconUrl).toBeNull();
      expect(
        warnings.some((warning) => warning.includes("inside the marketplace")),
      ).toBe(true);
    });

    it("drops a cached icon the refreshed manifest no longer lists", async () => {
      const catalog = service();
      await addDirectoryMarketplace(
        catalog,
        manifest([remoteEntry({ icon: { url: "./icons/widgets.svg" } })]),
        { "icons/widgets.svg": VALID_SVG },
      );
      expect(await catalog.icon("acme-plugins", "widgets")).toBeDefined();
      const row = getPluginMarketplace(db, "acme-plugins");
      await rm(row?.manifestUrl ?? "", { recursive: true, force: true });
      await mkdir(row?.manifestUrl ?? "", { recursive: true });
      await writeFile(
        join(row?.manifestUrl ?? "", "marketplace.json"),
        JSON.stringify(manifest([remoteEntry({ icon: "Zap" })])),
      );

      await catalog.refreshMarketplaces({
        name: "acme-plugins",
        attemptedAt: 2_000,
      });
      expect(await catalog.icon("acme-plugins", "widgets")).toBeUndefined();
    });

    it("converts plugins from a leftover remote marketplace to direct installs and deletes its row", () => {
      upsertPluginMarketplace(db, {
        name: "sandy-community",
        sourceKind: "https",
        manifestUrl: "https://marketplace.test/marketplace.json",
        sourceGitRef: null,
        sourceGitSubdirectory: null,
        sourceGitCommit: null,
        manifestJson: JSON.stringify(manifest([])),
        lastSuccessfulRefreshAt: 1_000,
        lastAttemptedRefreshAt: 1_000,
        lastError: null,
      });
      upsertInstalledPlugin(db, {
        id: "thread-hover-cards",
        source: "git:https://github.com/brsbl/sandy-plugins.git@main",
        provenance: {
          kind: "catalog",
          marketplace: "sandy-community",
          entryId: "thread-hover-cards",
        },
        sourceIntent: {
          kind: "git",
          url: "https://github.com/brsbl/sandy-plugins.git",
          subdirectory: null,
          selector: { kind: "ref", ref: "main", refKind: "branch" },
        },
        exactResolution: { kind: "git", commit: "0".repeat(40) },
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        rootDir: "/managed/thread-hover-cards",
        version: "0.1.0",
        enabled: true,
        enabledFollowsDefault: false,
      });

      service();

      expect(getPluginMarketplace(db, "sandy-community")).toBeUndefined();
      expect(getInstalledPlugin(db, "thread-hover-cards")).toMatchObject({
        provenance: "direct",
        catalogMarketplaceName: null,
        enabled: true,
      });
    });
  });

  describe("catalog installs", () => {
    async function refreshedCatalog(entry: Record<string, unknown>) {
      const catalog = service();
      await addDirectoryMarketplace(catalog, manifest([entry]), {
        "icons/widgets.svg": VALID_SVG,
      });
      return catalog;
    }

    const hoverCardsEntry = remoteEntry({
      id: "thread-hover-cards",
      icon: "ZoomIn",
      source: {
        git: {
          url: "https://github.com/brsbl/sandy-plugins.git",
          ref: "30f91fd977ba1ce60532af27a68534464fb62516",
        },
      },
    });

    it("reads the installed flag from catalog provenance", async () => {
      const catalog = await refreshedCatalog(hoverCardsEntry);
      upsertInstalledPlugin(db, {
        id: "hover-cards",
        source:
          "git:https://github.com/brsbl/sandy-plugins.git@30f91fd977ba1ce60532af27a68534464fb62516",
        provenance: {
          kind: "catalog",
          marketplace: "acme-plugins",
          entryId: "thread-hover-cards",
        },
        sourceIntent: {
          kind: "git",
          url: "https://github.com/brsbl/sandy-plugins.git",
          subdirectory: null,
          selector: {
            kind: "ref",
            ref: "30f91fd977ba1ce60532af27a68534464fb62516",
            refKind: "commit",
          },
        },
        exactResolution: {
          kind: "git",
          commit: "30f91fd977ba1ce60532af27a68534464fb62516",
        },
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        rootDir: "/managed/thread-hover-cards",
        version: "0.1.0",
        enabled: true,
        enabledFollowsDefault: false,
      });
      expect((await catalog.search("thread-hover-cards"))[0]?.installed).toBe(
        true,
      );
    });

    it.each([
      {
        name: "a local checkout",
        source: "path:/Users/me/git/thread-hover-cards",
        sourceIntent: {
          kind: "path",
          canonicalPath: "/Users/me/git/thread-hover-cards",
        },
        installed: false,
      },
      {
        name: "a different git repository",
        source: "git:https://github.com/someone-else/hover-cards.git@main",
        sourceIntent: {
          kind: "git",
          url: "https://github.com/someone-else/hover-cards.git",
          subdirectory: null,
          selector: { kind: "ref", ref: "main", refKind: "branch" },
        },
        installed: false,
      },
      {
        name: "the entry's git repository",
        source: "git:https://github.com/brsbl/sandy-plugins@main",
        sourceIntent: {
          kind: "git",
          url: "https://github.com/brsbl/sandy-plugins",
          subdirectory: null,
          selector: { kind: "ref", ref: "main", refKind: "branch" },
        },
        installed: true,
      },
    ] satisfies {
      name: string;
      source: string;
      sourceIntent: PluginSourceIntent;
      installed: boolean;
    }[])(
      "reports a direct install from $name with the same id as installed: $installed",
      async ({ source, sourceIntent, installed }) => {
        const catalog = await refreshedCatalog(hoverCardsEntry);
        upsertInstalledPlugin(db, {
          id: "thread-hover-cards",
          source,
          provenance: { kind: "direct" },
          sourceIntent,
          exactResolution:
            sourceIntent.kind === "git"
              ? { kind: "git", commit: "0".repeat(40) }
              : { kind: "path" },
          updateState: {
            lastCheckAt: null,
            availableCompatibleVersion: null,
            newestIncompatibleVersion: null,
            statusDetail: null,
          },
          activeArtifactId: null,
          rootDir: "/Users/me/git/thread-hover-cards",
          version: "0.1.0",
          enabled: true,
          enabledFollowsDefault: false,
        });
        expect((await catalog.search("thread-hover-cards"))[0]).toMatchObject({
          installed,
          conflictingInstallSource: installed ? null : source,
        });
      },
    );
  });

  it("defers the periodic marketplace refresh while the server is moving", async () => {
    const catalog = service();
    await addDirectoryMarketplace(catalog, manifest([]));
    const before = getPluginMarketplace(
      db,
      "acme-plugins",
    )?.lastAttemptedRefreshAt;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setServerMoveFrozen(db, true);
    try {
      catalog.startPeriodicRefresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        getPluginMarketplace(db, "acme-plugins")?.lastAttemptedRefreshAt,
      ).toBe(before);

      setServerMoveFrozen(db, false);
      await vi.advanceTimersByTimeAsync(SERVER_MOVE_FROZEN_RETRY_MS);
      await vi.waitFor(() => {
        expect(
          getPluginMarketplace(db, "acme-plugins")?.lastAttemptedRefreshAt,
        ).not.toBe(before);
      });
    } finally {
      catalog.stopPeriodicRefresh();
      setServerMoveFrozen(db, false);
      vi.useRealTimers();
    }
  });
});
