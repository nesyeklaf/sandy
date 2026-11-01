import { HOST_TAILWIND_VERSION } from "@sandy/plugin-build/host-tailwind-version";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { upsertInstalledPlugin } from "@sandy/db";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@sandy/domain";
import { loadHostStylesheet } from "../../../src/host-stylesheet.js";
import { registerPluginRoutes } from "../../../src/routes/plugins.js";
import { createPluginInstallJobs } from "../../../src/services/plugins/plugin-install-jobs.js";
import { createPluginUpdateJobs } from "../../../src/services/plugins/plugin-update-jobs.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";

function npmPersistence(packageName: string, version: string) {
  return {
    provenance: { kind: "direct" } as const,
    sourceIntent: {
      kind: "npm" as const,
      packageName,
      registry: "https://registry.npmjs.org",
      requestedSpec: version,
      specKind: "exact" as const,
    },
    exactResolution: {
      kind: "npm" as const,
      version,
      integrity: "test-integrity",
    },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
  };
}

const SERVER_SOURCE = `export default function plugin(sandy: any) { sandy.log.info("loaded"); }`;
const APP_SOURCE = `export default function App() {\n  return <div className="line-clamp-2">hi</div>;\n}\n`;
const COMPRESSIBLE_APP_SOURCE = `const payload = ${JSON.stringify(
  "compressible plugin bundle payload ".repeat(200),
)};\nexport default function App() {\n  return <div className="line-clamp-2 flex flex-col items-center gap-2 rounded-md border p-4 text-sm font-medium shadow-sm" data-payload={payload}>hi</div>;\n}\n`;

async function writeAppPluginFixture(
  rootDir: string,
  options: {
    name: string;
    app?: boolean;
    appSource?: string;
    serverSource?: string;
  },
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      sandy: {
        name: "App bundle fixture",
        description: "Plugin app bundle fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(options.app === false ? {} : { app: "./app.tsx" }),
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    options.serverSource ?? SERVER_SOURCE,
  );
  if (options.app !== false) {
    await writeFile(join(rootDir, "app.tsx"), options.appSource ?? APP_SOURCE);
  }
}

describe("plugin app bundles (build policy, inventory, asset routes)", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness();
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("builds path installs at install time and serves hash-cached assets", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-appy");
    await writeAppPluginFixture(rootDir, {
      name: "sandy-plugin-appy",
      appSource: COMPRESSIBLE_APP_SOURCE,
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.app.hasApp).toBe(true);
    const bundle = entry.app.bundle;
    expect(bundle).not.toBeNull();
    if (bundle === null) throw new Error("unreachable");
    expect(bundle.compatible).toBe(true);
    expect(bundle.sdkMajor).toBe(PLUGIN_SDK_MAJOR);
    expect(bundle.sdkVersion).toBe(PLUGIN_SDK_VERSION);
    expect(bundle.runtimeSlots).toEqual(["jsxRuntime"]);
    expect(bundle.jsUrl).toBe(
      `/api/v1/plugin-app-assets/${bundle.hash}/app.js`,
    );
    expect(bundle.cssUrl).toBe(
      `/api/v1/plugin-app-assets/${bundle.hash}/app.css`,
    );
    const jsStat = await stat(join(rootDir, "dist", "app.js"));
    await stat(join(rootDir, "dist", "app.meta.json"));
    expect(bundle.jsBytes).toBe(jsStat.size);

    const js = await harness.app.request(`${BASE}${bundle.jsUrl}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const jsText = await js.text();
    expect(jsText).toContain("__sandyPluginRuntime");
    expect(js.headers.get("content-encoding")).toBeNull();
    expect(js.headers.get("content-length")).toBe(
      String(Buffer.byteLength(jsText)),
    );

    const brotliJs = await harness.app.request(`${BASE}${bundle.jsUrl}`, {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(brotliJs.headers.get("content-encoding")).toBe("br");
    expect(
      brotliJs.headers
        .get("vary")
        ?.split(",")
        .map((value) => value.trim()),
    ).toContain("Accept-Encoding");
    expect(brotliJs.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const brotliJsBytes = Buffer.from(await brotliJs.arrayBuffer());
    expect(brotliJsBytes.length).toBeLessThan(Buffer.byteLength(jsText));
    expect(brotliDecompressSync(brotliJsBytes).toString()).toBe(jsText);

    const rejectedCompression = await harness.app.request(
      `${BASE}${bundle.jsUrl}`,
      { headers: { "accept-encoding": "br;q=0, gzip;q=0" } },
    );
    expect(rejectedCompression.headers.get("content-encoding")).toBeNull();
    expect(await rejectedCompression.text()).toBe(jsText);

    const brotliJsHead = await harness.app.request(`${BASE}${bundle.jsUrl}`, {
      method: "HEAD",
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(brotliJsHead.headers.get("content-encoding")).toBe("br");
    expect(brotliJsHead.headers.get("content-length")).toBe(
      String(brotliJsBytes.length),
    );
    expect((await brotliJsHead.arrayBuffer()).byteLength).toBe(0);

    const legacyCss = await harness.app.request(`${BASE}${bundle.cssUrl}`);
    expect(await legacyCss.text()).toBe(
      await readFile(join(rootDir, "dist", "app.css"), "utf8"),
    );

    const css = await harness.app.request(
      `${BASE}${bundle.cssUrl}?host-tailwind=${HOST_TAILWIND_VERSION}`,
    );
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const cssText = await css.text();
    expect(cssText).toContain("line-clamp-2");
    const scope = ":where([data-sandy-plugin=appy])";
    expect(cssText).not.toContain(",[data-sandy-plugin-root]");
    expect(cssText).toContain(
      ":where([data-sandy-plugin-root]:not([data-sandy-plugin]))",
    );
    expect(cssText).toContain(`${scope} .line-clamp-2`);
    expect(cssText).toContain(`${scope}.line-clamp-2`);
    expect(cssText).not.toMatch(/@layer utilities\{\./);
    const builtCss = await readFile(join(rootDir, "dist", "app.css"), "utf8");
    expect(builtCss).toContain("@property --tw-shadow");
    expect(builtCss).toContain(":root,:host{");
    expect(cssText).not.toContain("@property");
    expect(cssText).not.toContain(":root");
    expect(cssText).toContain("var(--tw-shadow)");

    for (const url of [
      `${BASE}${bundle.cssUrl}`,
      `${BASE}/api/v1/plugins/appy/assets/app.css?h=${bundle.hash}`,
    ]) {
      for (const version of [
        HOST_TAILWIND_VERSION,
        null,
        "mismatched-host",
        HOST_TAILWIND_VERSION,
      ]) {
        const requestedUrl =
          version === null
            ? url
            : `${url}${url.includes("?") ? "&" : "?"}host-tailwind=${version}`;
        const response = await harness.app.request(requestedUrl, {
          headers: { "accept-encoding": "br;q=0, gzip;q=1" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-encoding")).toBe("gzip");
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
        const compressed = Buffer.from(await response.arrayBuffer());
        expect(gunzipSync(compressed).toString()).toBe(
          version === HOST_TAILWIND_VERSION ? cssText : builtCss,
        );
      }
    }

    const staleHash = await harness.app.request(
      `${BASE}/api/v1/plugins/appy/assets/app.js?h=deadbeefdeadbeef`,
    );
    expect(staleHash.status).toBe(200);
    expect(staleHash.headers.get("cache-control")).toBe("no-store");
    const noHash = await harness.app.request(
      `${BASE}/api/v1/plugins/appy/assets/app.js`,
    );
    expect(noHash.status).toBe(200);
    expect(noHash.headers.get("cache-control")).toBe("no-store");

    const unknownPlugin = await harness.app.request(
      `${BASE}/api/v1/plugins/nope/assets/app.js`,
    );
    expect(unknownPlugin.status).toBe(404);
    const unknownHash = await harness.app.request(
      `${BASE}/api/v1/plugin-app-assets/0000000000000000/app.js`,
    );
    expect(unknownHash.status).toBe(404);
    const unknownFile = await harness.app.request(
      `${BASE}/api/v1/plugins/appy/assets/evil.js`,
    );
    expect(unknownFile.status).toBe(404);
  }, 60_000);

  it("drops utilities the served host stylesheet already declares only for that stylesheet", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-dup");
    await writeAppPluginFixture(rootDir, {
      name: "sandy-plugin-dup",
      appSource: `export default function App() {\n  return <div className="flex text-center">hi</div>;\n}\n`,
    });
    const staticDir = join(harness.config.dataDir, "static-app");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(
      join(staticDir, "index.html"),
      '<html><head><link fetchpriority="high" rel="stylesheet" crossorigin href="/assets/index-Ab_1.css"></head></html>',
    );
    await writeFile(
      join(staticDir, "assets", "index-Ab_1.css"),
      "@layer utilities{.flex{display:flex}}",
    );
    const hostStylesheet = loadHostStylesheet(staticDir);
    expect(hostStylesheet?.key).toBe("index-Ab_1.css");

    const entry = await harness.pluginService.installPath(rootDir);
    const bundle = entry.app.bundle;
    if (bundle === null || bundle.cssUrl === null)
      throw new Error("plugin built no stylesheet");
    const app = new Hono();
    registerPluginRoutes(
      app,
      { config: { serverPort: 3334 }, db: harness.deps.db, hostStylesheet },
      harness.pluginService,
      createPluginInstallJobs({ notifyChanged: () => {} }),
      createPluginUpdateJobs({ notifyChanged: () => {} }),
    );
    const cssFor = async (hostCss: string | null) => {
      const query = `host-tailwind=${HOST_TAILWIND_VERSION}${hostCss === null ? "" : `&host-css=${hostCss}`}`;
      const response = await app.request(
        `${BASE}${bundle.cssUrl}?${query}`.replace("/api/v1", ""),
      );
      expect(response.status).toBe(200);
      return response.text();
    };

    const withoutHostTailwind = await cssFor(null);
    expect(withoutHostTailwind).toContain(".flex{display:flex}");
    expect(await cssFor("index-Stale.css")).toBe(withoutHostTailwind);
    const deduped = await cssFor("index-Ab_1.css");
    expect(deduped).not.toContain(".flex{");
    expect(deduped).toContain(".text-center{text-align:center}");
    expect(await cssFor(null)).toBe(withoutHostTailwind);
  }, 60_000);

  it("reports hasApp:false for headless plugins and 404s their assets", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "sandy-plugin-headless",
    );
    await writeAppPluginFixture(rootDir, {
      name: "sandy-plugin-headless",
      app: false,
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.app).toEqual({ hasApp: false, bundle: null });

    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/headless/assets/app.js`,
    );
    expect(response.status).toBe(404);
  });

  it("erases a type-only backend RPC contract import from the frontend bundle", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "sandy-plugin-typed-rpc",
    );
    await writeAppPluginFixture(rootDir, {
      name: "sandy-plugin-typed-rpc",
      serverSource: `
        import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
        import { z } from "zod";
        const BACKEND_ONLY_SENTINEL = "backend-contract-must-not-bundle";
        export const rpcContract = defineRpcContract({
          echo: {
            input: z.object({ value: z.string() }),
            output: z.object({ value: z.string() }),
          },
        });
        export default function plugin(sandy: any) {
          void BACKEND_ONLY_SENTINEL;
          sandy.rpc.register(rpcContract, { echo: (input: any) => input });
        }
      `,
      appSource: `
        import { definePluginApp, useRpc } from "@sandy-sdk/plugin-sdk/app";
        import type { rpcContract } from "./server";
        function Panel() {
          const rpc = useRpc<typeof rpcContract>();
          void rpc.call("echo", { value: "typed" });
          return <div>typed rpc</div>;
        }
        export default definePluginApp((app) => {
          app.slots.homepageSection({ id: "typed", title: "Typed", component: Panel });
        });
      `,
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    const bundled = await readFile(join(rootDir, "dist", "app.js"), "utf8");
    expect(bundled).not.toContain("backend-contract-must-not-bundle");
    expect(bundled).not.toContain("defineRpcContract");
    expect(bundled).toContain("typed rpc");
  }, 60_000);

  it("fails the install when the frontend build fails", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-bad");
    await writeAppPluginFixture(rootDir, {
      name: "sandy-plugin-bad",
      appSource: "export default function App( {\n",
    });
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(/frontend bundle build for "bad" failed/);
    expect(harness.pluginService.list()).toHaveLength(0);
  }, 60_000);

  it("rebuilds a path plugin at load when the recorded SDK version is stale", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-aged");
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-aged" });
    await harness.pluginService.installPath(rootDir);

    const metaPath = join(rootDir, "dist", "app.meta.json");
    await writeFile(
      metaPath,
      JSON.stringify({ sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: "0.0.0-stale" }),
    );
    await harness.pluginService.reload("aged");

    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    expect(meta.sdkVersion).toBe(PLUGIN_SDK_VERSION);
    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "aged");
    expect(entry?.app.bundle?.sdkVersion).toBe(PLUGIN_SDK_VERSION);
    expect(entry?.app.bundle?.compatible).toBe(true);
  }, 120_000);

  it("keeps an npm plugin's backend running with compatible:false on a major mismatch (no rebuild)", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-oldie");
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-oldie" });
    const staleMajor = PLUGIN_SDK_MAJOR + 1;
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default {};\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({ sdkMajor: staleMajor, sdkVersion: `${staleMajor}.0.0` }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("sandy-plugin-oldie", "0.1.0"),
      id: "oldie",
      source: "npm:sandy-plugin-oldie@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    await harness.pluginService.reload("oldie");

    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "oldie");
    expect(entry?.status).toBe("running");
    expect(entry?.app.hasApp).toBe(true);
    expect(entry?.app.bundle).toMatchObject({
      sdkMajor: staleMajor,
      sdkVersion: `${staleMajor}.0.0`,
      compatible: false,
      runtimeSlots: expect.arrayContaining(["pierreDiffs", "pierreDiffsReact"]),
    });
    const meta = JSON.parse(
      await readFile(join(rootDir, "dist", "app.meta.json"), "utf8"),
    );
    expect(meta.sdkVersion).toBe(`${staleMajor}.0.0`);
    const js = await harness.app.request(
      `${BASE}${entry?.app.bundle?.jsUrl ?? ""}`,
    );
    expect(js.status).toBe(200);
  });

  it("refreshes the served bundle hash on reload-by-id after dist changes (sandy plugin dev cycle)", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-devy");
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-devy" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("sandy-plugin-devy", "0.1.0"),
      id: "devy",
      source: "npm:sandy-plugin-devy@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    await harness.pluginService.reload("devy");
    const before = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "devy")?.app.bundle;
    expect(before).not.toBeNull();

    await writeFile(join(rootDir, "dist", "app.js"), "export default 2;\n");
    const reload = await harness.app.request(
      `${BASE}/api/v1/plugins/reload?id=devy`,
      { method: "POST" },
    );
    expect(reload.status).toBe(200);

    const after = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "devy")?.app.bundle;
    expect(after).not.toBeNull();
    expect(after?.hash).not.toBe(before?.hash);
    expect(after?.jsUrl).toBe(
      `/api/v1/plugin-app-assets/${after?.hash}/app.js`,
    );
    const js = await harness.app.request(`${BASE}${after?.jsUrl ?? ""}`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("export default 2");
  });

  it("clears the served bundle and sets a status detail when a required rebuild fails", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "sandy-plugin-brittle",
    );
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-brittle" });
    await harness.pluginService.installPath(rootDir);
    const before = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "brittle");
    expect(before?.app.bundle).not.toBeNull();

    await writeFile(
      join(rootDir, "app.tsx"),
      "export default function App( {\n",
    );
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({ sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: "0.0.0-stale" }),
    );
    await harness.pluginService.reload("brittle");

    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "brittle");
    expect(entry?.status).toBe("running");
    expect(entry?.statusDetail).toContain("frontend bundle rebuild failed");
    expect(entry?.app).toEqual({ hasApp: true, bundle: null });
    const js = await harness.app.request(
      `${BASE}/api/v1/plugins/brittle/assets/app.js`,
    );
    expect(js.status).toBe(404);
  }, 120_000);

  it("re-keys the bundle hash when only the meta changes (same js/css)", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-meta");
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-meta" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("sandy-plugin-meta", "0.1.0"),
      id: "meta",
      source: "npm:sandy-plugin-meta@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    await harness.pluginService.reload("meta");
    const before = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "meta")?.app.bundle;
    expect(before?.compatible).toBe(true);

    const staleMajor = PLUGIN_SDK_MAJOR + 1;
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({ sdkMajor: staleMajor, sdkVersion: `${staleMajor}.0.0` }),
    );
    await harness.pluginService.reload("meta");
    const after = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "meta")?.app.bundle;
    expect(after?.compatible).toBe(false);
    expect(after?.hash).not.toBe(before?.hash);
  });

  it("rejects malformed bundle meta (strict parse)", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "sandy-plugin-malformed",
    );
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-malformed" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("sandy-plugin-malformed", "0.1.0"),
      id: "malformed",
      source: "npm:sandy-plugin-malformed@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    const badMetas = [
      { sdkMajor: -1, sdkVersion: "0.0.0" },
      { sdkMajor: 0.5, sdkVersion: "0.5.0" },
      { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: "banana" },
      { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: `${PLUGIN_SDK_MAJOR + 1}.0.0` },
      {
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
        runtimeSlots: "pierreDiffs",
      },
    ];
    for (const badMeta of badMetas) {
      await writeFile(
        join(rootDir, "dist", "app.meta.json"),
        JSON.stringify(badMeta),
      );
      await harness.pluginService.reload("malformed");
      const entry = harness.pluginService
        .list()
        .find((plugin) => plugin.id === "malformed");
      expect(entry?.app, JSON.stringify(badMeta)).toEqual({
        hasApp: true,
        bundle: null,
      });
    }
  });

  it("stops serving assets when the plugin is disabled", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-gated");
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-gated" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("sandy-plugin-gated", "0.1.0"),
      id: "gated",
      source: "npm:sandy-plugin-gated@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    await harness.pluginService.reload("gated");
    const bundle = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "gated")?.app.bundle;
    expect(bundle).not.toBeNull();
    const url = `${BASE}${bundle?.jsUrl ?? ""}`;
    expect((await harness.app.request(url)).status).toBe(200);

    await harness.pluginService.setEnabled("gated", false);
    expect((await harness.app.request(url)).status).toBe(404);

    await harness.pluginService.setEnabled("gated", true);
    expect((await harness.app.request(url)).status).toBe(200);
  });

  it("reports bundle:null when an npm plugin's dist is missing at load", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "sandy-plugin-bare");
    await writeAppPluginFixture(rootDir, { name: "sandy-plugin-bare" });
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("sandy-plugin-bare", "0.1.0"),
      id: "bare",
      source: "npm:sandy-plugin-bare@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    await harness.pluginService.reload("bare");

    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "bare");
    expect(entry?.status).toBe("running");
    expect(entry?.app).toEqual({ hasApp: true, bundle: null });
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/bare/assets/app.js`,
    );
    expect(response.status).toBe(404);
  });
});
