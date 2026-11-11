import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VENDORED_FILES = ["holon-editor.js", "holon-editor.css", "routing-worker.js", "elk-worker.min.js", "libavoid.wasm"];

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "holon-ui");

function fail(message) {
  console.error(`sync:holon-ui: ${message}`);
  process.exit(1);
}

const argument = process.argv[2];
if (argument === undefined) fail("usage: pnpm sync:holon-ui <holons checkout>");
const holons = resolve(argument);
const ui = join(holons, "holon-ui");
if (!existsSync(join(ui, "vite.lib.config.ts"))) fail(`${ui} has no vite.lib.config.ts; pass a holons checkout with the embeddable editor`);

execFileSync("pnpm", ["build:lib"], { cwd: ui, stdio: "inherit" });

const git = (...args) => execFileSync("git", ["-C", holons, ...args], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--", "holon-ui") !== "";

mkdirSync(target, { recursive: true });
for (const file of VENDORED_FILES) {
  const built = join(ui, "dist-lib", file);
  if (!existsSync(built)) fail(`pnpm build:lib wrote no ${file}`);
  rmSync(join(target, file), { force: true });
  copyFileSync(built, join(target, file));
}
writeFileSync(join(target, "VERSION"), `holons ${commit}${dirty ? " dirty" : ""}\n`);
console.log(`sync:holon-ui: ${VENDORED_FILES.length} files from holons ${commit}${dirty ? " (dirty holon-ui)" : ""} into ${target}`);
