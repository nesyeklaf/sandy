import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbConnection } from "@sandy/db";
import { createMigratedConnection } from "@sandy/db/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPluginCatalogRoutes } from "../../../src/routes/plugin-catalog.js";
import { createPluginInstallJobs } from "../../../src/services/plugins/plugin-install-jobs.js";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";
import {
  BUILTIN_PLUGINS,
  BUNDLED_PLUGINS,
  OFFICIAL_PLUGINS,
} from "../../../src/services/plugins/builtin-registry.js";

const VALID_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16H0z"/></svg>',
);

describe("plugin catalog routes", () => {
  let db: DbConnection;

  let dataDir: string;

  beforeEach(async () => {
    db = createMigratedConnection();
    dataDir = await mkdtemp(join(tmpdir(), "sandy-catalog-routes-"));
  });

  afterEach(async () => {
    db.$client.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeMarketplace(
    manifest: unknown,
    files: Record<string, Buffer> = {},
  ): Promise<string> {
    const directory = await mkdtemp(join(dataDir, "marketplace-"));
    await writeFile(
      join(directory, "marketplace.json"),
      JSON.stringify(manifest),
    );
    for (const [relativePath, bytes] of Object.entries(files)) {
      const target = join(directory, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    return `path:${directory}`;
  }

  function catalogApp() {
    const catalog = createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      dataDir,
      plugins: {
        installOfficialPlugin: async () => {
          throw new Error("unexpected install");
        },
        installCatalogPlugin: async () => {
          throw new Error("unexpected catalog install");
        },
      },
    });
    const app = new Hono();
    registerPluginCatalogRoutes(
      app,
      catalog,
      createPluginInstallJobs({ notifyChanged: () => {} }),
    );
    return { app, catalog };
  }

  it("serves status/search and validates install requests", async () => {
    const { app } = catalogApp();

    const status = await app.request("/plugin-catalog");
    await expect(status.json()).resolves.toMatchObject({
      catalog: {
        pluginCount: BUNDLED_PLUGINS.length,
        includedPluginCount: BUILTIN_PLUGINS.length,
        optionalPluginCount: OFFICIAL_PLUGINS.length,
      },
    });
    const search = await app.request(
      "/plugin-catalog/search?q=durable%20memory",
    );
    await expect(search.json()).resolves.toMatchObject({
      results: [{ entryId: "memory", installed: false }],
      collections: [{ id: "sandy-official", displayName: "SANDY Official" }],
    });

    const refresh = await app.request("/plugin-catalog/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(refresh.status).toBe(404);

    const install = await app.request("/plugin-catalog/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "memory" }),
    });
    expect(install.status).toBe(422);
    await expect(install.json()).resolves.toMatchObject({
      error: expect.stringContaining("unexpected install"),
    });

    const versionOverride = await app.request("/plugin-catalog/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "memory", version: "0.2.0" }),
    });
    expect(versionOverride.status).toBe(422);
  });

  it("identifies background installs with the same entry ID as catalog search", async () => {
    const { app } = catalogApp();
    const search = await app.request("/plugin-catalog/search?q=docs");
    await expect(search.json()).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ entryId: "docs" }),
      ]),
    });
    for (const entryId of ["docs", "simple-notes"]) {
      const install = await app.request("/plugin-catalog/install", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer: "respond-async",
        },
        body: JSON.stringify({ entryId, marketplace: "sandy-official" }),
      });
      expect(install.status).toBe(202);
      await expect(install.json()).resolves.toMatchObject({
        job: {
          target: {
            kind: "catalog",
            entryId: "docs",
            marketplace: "sandy-official",
          },
        },
      });
    }
  });

  it("serves a cached icon with hash-gated caching and refuses unknown ones", async () => {
    const { app } = catalogApp();
    const source = await writeMarketplace(
      {
        schemaVersion: 1,
        name: "acme-plugins",
        displayName: "Acme Plugins",
        plugins: [
          {
            id: "widgets",
            displayName: "Acme Widgets",
            description: "Widgets for threads.",
            icon: { url: "./icons/widgets.svg" },
            author: { name: "Acme" },
            source: {
              git: {
                url: "https://github.com/acme/plugins.git",
                ref: "v1.0.0",
              },
            },
          },
        ],
      },
      { "icons/widgets.svg": VALID_SVG },
    );
    const added = await app.request("/marketplaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    expect(added.status).toBe(200);
    const listed = await app.request("/plugin-catalog/search?q=widgets");
    const { results } = (await listed.json()) as {
      results: Array<{ entryId: string; iconUrl: string | null }>;
    };
    const iconUrl = results.find(
      (entry) => entry.entryId === "widgets",
    )?.iconUrl;
    expect(iconUrl).toContain("/plugin-catalog/icons/acme-plugins/widgets?h=");
    const iconPath = (iconUrl ?? "").replace("/api/v1", "");

    const hashed = await app.request(iconPath);
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get("content-type")).toBe("image/svg+xml");
    expect(hashed.headers.get("cache-control")).toContain("immutable");
    expect(await hashed.text()).toBe(VALID_SVG.toString());

    const stale = await app.request(
      "/plugin-catalog/icons/acme-plugins/widgets?h=stale",
    );
    expect(stale.headers.get("cache-control")).toBe("no-store");

    const missing = await app.request(
      "/plugin-catalog/icons/acme-plugins/nothing",
    );
    expect(missing.status).toBe(404);
  });

  describe("marketplace routes", () => {
    function acmeCatalog(): unknown {
      return {
        schemaVersion: 1,
        name: "acme-plugins",
        displayName: "Acme Plugins",
        plugins: [
          {
            id: "notes",
            displayName: "Acme Notes",
            description: "Notes beside a thread.",
            icon: "Zap",
            author: { name: "Acme" },
            source: {
              git: {
                url: "https://example.com/acme/notes.git",
                ref: "1234567890abcdef1234567890abcdef12345678",
              },
            },
          },
        ],
      };
    }

    async function acmeApp() {
      return { ...catalogApp(), source: await writeMarketplace(acmeCatalog()) };
    }

    async function postJson(
      app: ReturnType<typeof catalogApp>["app"],
      path: string,
      body: unknown,
    ): Promise<Response> {
      return app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("adds, lists, refreshes, and removes through the routes", async () => {
      const { app, source: ACME_URL } = await acmeApp();

      const added = await postJson(app, "/marketplaces", { source: ACME_URL });
      expect(added.status).toBe(200);
      await expect(added.json()).resolves.toMatchObject({
        ok: true,
        marketplace: { name: "acme-plugins", official: false, entryCount: 1 },
      });

      const listed = await app.request("/marketplaces");
      await expect(listed.json()).resolves.toMatchObject({
        marketplaces: [
          { name: "sandy-official", official: true, sourceKind: "path" },
          { name: "acme-plugins" },
        ],
      });

      const refreshed = await postJson(app, "/marketplaces/refresh", {
        name: "acme-plugins",
      });
      await expect(refreshed.json()).resolves.toMatchObject({
        results: [{ name: "acme-plugins", ok: true, error: null }],
      });

      const removed = await app.request("/marketplaces/acme-plugins", {
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
      await expect(removed.json()).resolves.toEqual({
        ok: true,
        convertedPluginIds: [],
      });
    });

    it("validates request bodies and marketplace names at the boundary", async () => {
      const { app, source: ACME_URL } = await acmeApp();

      const badBody = await postJson(app, "/marketplaces", { url: ACME_URL });
      expect(badBody.status).toBe(422);

      const emptySubdirectory = await postJson(app, "/marketplaces", {
        source: ACME_URL,
        subdirectory: "",
      });
      expect(emptySubdirectory.status).toBe(422);

      const misplacedSubdirectory = await postJson(app, "/marketplaces", {
        source: ACME_URL,
        subdirectory: "sandy",
      });
      expect(misplacedSubdirectory.status).toBe(422);
      await expect(misplacedSubdirectory.json()).resolves.toMatchObject({
        error: expect.stringContaining(
          "a subdirectory applies to git: sources only",
        ),
      });

      const badName = await app.request("/marketplaces/Not%20A%20Name", {
        method: "DELETE",
      });
      expect(badName.status).toBe(422);

      const badRefresh = await postJson(app, "/marketplaces/refresh", {
        name: "Not A Name",
      });
      expect(badRefresh.status).toBe(422);

      const longName = "a".repeat(65);
      const longRemoval = await app.request(`/marketplaces/${longName}`, {
        method: "DELETE",
      });
      expect(longRemoval.status).toBe(422);

      const longPlan = await app.request(
        `/plugin-catalog/install-plan?entryId=notes&marketplace=${longName}`,
      );
      expect(longPlan.status).toBe(422);

      const reserved = await app.request("/marketplaces/sandy-official", {
        method: "DELETE",
      });
      expect(reserved.status).toBe(422);
      await expect(reserved.json()).resolves.toMatchObject({
        error: expect.stringContaining("cannot be removed"),
      });
    });

    it("serves an install plan and refuses an unknown selector", async () => {
      const { app, source: ACME_URL } = await acmeApp();
      await postJson(app, "/marketplaces", { source: ACME_URL });

      const plan = await app.request(
        "/plugin-catalog/install-plan?entryId=notes&marketplace=acme-plugins",
      );
      expect(plan.status).toBe(200);
      await expect(plan.json()).resolves.toMatchObject({
        plan: {
          kind: "marketplace",
          marketplace: "acme-plugins",
          official: false,
          source:
            "git:https://example.com/acme/notes.git@1234567890abcdef1234567890abcdef12345678",
          resolvedSource: {
            kind: "git",
            url: "https://example.com/acme/notes.git",
            ref: "1234567890abcdef1234567890abcdef12345678",
            resolvedCommit: "1234567890abcdef1234567890abcdef12345678",
          },
        },
      });

      const missingEntry = await app.request(
        "/plugin-catalog/install-plan?entryId=nope",
      );
      expect(missingEntry.status).toBe(422);

      const missingArgs = await app.request("/plugin-catalog/install-plan");
      expect(missingArgs.status).toBe(422);
    });

    it("routes an install to the named marketplace", async () => {
      const { app, source: ACME_URL } = await acmeApp();
      await postJson(app, "/marketplaces", { source: ACME_URL });

      const install = await postJson(app, "/plugin-catalog/install", {
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: {
          kind: "git",
          url: "https://example.com/acme/notes.git",
          ref: "1234567890abcdef1234567890abcdef12345678",
          resolvedCommit: "abcdef1234567890abcdef1234567890abcdef12",
        },
      });
      expect(install.status).toBe(422);
      await expect(install.json()).resolves.toMatchObject({
        error: expect.stringContaining("source changed after confirmation"),
      });

      const unknownMarketplace = await postJson(
        app,
        "/plugin-catalog/install",
        { entryId: "notes", marketplace: "nope" },
      );
      expect(unknownMarketplace.status).toBe(422);
      await expect(unknownMarketplace.json()).resolves.toMatchObject({
        error: expect.stringContaining('unknown marketplace "nope"'),
      });
    });
  });
});
