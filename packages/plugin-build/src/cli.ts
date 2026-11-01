import { resolve } from "node:path";
import sandyApp from "../../sandy-app/package.json" with { type: "json" };
import { preparePluginRuntime } from "./prepare-plugin-runtime.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";

if (process.argv.length !== 3 || process.argv[2] !== "prepare-bundled") {
  throw new Error(
    "Usage: sandy-plugin-build prepare-bundled (from a plugin directory)",
  );
}
const sourceRoot = process.cwd();
await preparePluginRuntime({
  sourceRoot,
  targetDir: resolve(sourceRoot, ".bundled-runtime"),
  sandyVersion: sandyApp.version,
  toolchain: await resolvePluginBuildToolchain(
    resolve(import.meta.dirname, "../node_modules/.sandy-toolchain"),
  ),
});
