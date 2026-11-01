import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPluginApp,
  buildPluginHost,
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "../packages/plugin-build/src/index.ts";
import { OFFICIAL_PLUGINS } from "../apps/server/src/services/plugins/builtin-registry.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
// Derived from the registry, so a new store-only plugin needs no edit here.
const officialNames = OFFICIAL_PLUGINS.map((plugin) => plugin.name);

const requested = process.argv.slice(2);
const selected =
  requested.length === 0 || requested.includes("all")
    ? officialNames
    : requested;

// Resolves from this repo's own devDependencies; no download here.
const toolchain = await resolvePluginBuildToolchain(
  resolve(repositoryRoot, "node_modules/.sandy-toolchain"),
);

for (const plugin of selected) {
  if (!officialNames.includes(plugin)) {
    throw new Error(
      `unknown official plugin ${JSON.stringify(plugin)}; expected ${officialNames.join(", ")}, or all`,
    );
  }
}

const sandyPackage = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "packages/sandy-app/package.json"),
    "utf8",
  ),
);
if (typeof sandyPackage.version !== "string") {
  throw new Error("packages/sandy-app/package.json is missing a version");
}

for (const plugin of selected) {
  const rootDirectory = resolve(repositoryRoot, "plugins", plugin);
  await rm(resolve(rootDirectory, "dist"), { recursive: true, force: true });
  const manifest = JSON.parse(
    await readFile(resolve(rootDirectory, "package.json"), "utf8"),
  );

  const server = await buildPluginServer(
    rootDirectory,
    sandyPackage.version,
    toolchain,
  );
  const app = manifest.sandy?.app
    ? await buildPluginApp(rootDirectory, sandyPackage.version, toolchain)
    : null;
  const host = manifest.sandy?.host
    ? await buildPluginHost(rootDirectory, sandyPackage.version, toolchain)
    : null;
  const outputs = [server.jsPath, server.metaPath];
  if (app !== null) {
    outputs.push(app.jsPath, app.cssPath, app.metaPath);
  }
  if (host !== null) outputs.push(host.jsPath, host.mapPath, host.metaPath);
  console.log(`${plugin}: built ${outputs.join(", ")}`);
}
