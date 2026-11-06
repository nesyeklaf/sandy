import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPluginApp } from "../../../packages/plugin-build/src/build-plugin-app.ts";
import { resolvePluginBuildToolchain } from "../../../packages/plugin-build/src/toolchain.ts";

const [rootArg, outArg, sandyVersion, minifyArg = "minify"] = process.argv.slice(2);
if (!rootArg || !outArg || !sandyVersion)
  throw new Error("usage: build-genui.ts <plugin root> <out dir> <sandy version>");
const rootDir = resolve(rootArg);
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const toolchain = await resolvePluginBuildToolchain(join(outDir, ".toolchain"));
process.env.RA_REAL_ESBUILD = toolchain.esbuild;
process.env.RA_MAP_OUT = join(outDir, "app.js.map");
const wrapper = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "esbuild-with-maps.mjs"),
).href;
const result = await buildPluginApp(rootDir, sandyVersion, {
  ...toolchain,
  esbuild: wrapper,
}, { minify: minifyArg !== "no-minify" });
copyFileSync(result.jsPath, join(outDir, "app.js"));
copyFileSync(result.cssPath, join(outDir, "app.css"));
copyFileSync(result.metaPath, join(outDir, "app.meta.json"));
console.log(JSON.stringify({ outDir, warnings: result.migrationWarnings.length }));
