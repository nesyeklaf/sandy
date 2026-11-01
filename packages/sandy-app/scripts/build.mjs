import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildNodeEsmEntry,
  copyDirectory,
} from "../../../scripts/build-utils.mjs";

const execFileAsync = promisify(execFile);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

async function assertPathExists(pathToCheck, label) {
  try {
    await access(pathToCheck);
  } catch {
    throw new Error(
      `Missing ${label} at ${pathToCheck}. Build @sandy/app, @sandy/server, and @sandy/host-daemon before packaging sandy-app.`,
    );
  }
}

async function copyBuildOutput({ from, label, to }) {
  await assertPathExists(from, label);
  await copyDirectory({ from, to });
}

async function buildPublicSdkDeclarations() {
  await execFileAsync(
    "node",
    [resolve(scriptsDir, "build-public-sdk-dts.mjs")],
    { cwd: packageRoot },
  );
}

const entrypoints = [
  ["sandy-app", "sandy-app.js"],
  ["sandy", "sandy.js"],
  ["sandy-server", "sandy-server.js"],
  ["sandy-host-daemon", "sandy-host-daemon.js"],
];

for (const [sourceName, outputName] of entrypoints) {
  await buildNodeEsmEntry({
    cleanDist: sourceName === "sandy-app",
    entryPoint: resolve(packageRoot, "src", "bin", `${sourceName}.ts`),
    executable: true,
    outfile: resolve(packageRoot, "dist", outputName),
    packageRoot,
  });
}

await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "public-sdk.ts"),
  outfile: resolve(packageRoot, "dist", "index.js"),
  packageRoot,
});
await buildPublicSdkDeclarations();
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(scriptsDir, "prune-sandy-chunks.mjs"),
  outfile: resolve(packageRoot, "dist", "prune-sandy-chunks.mjs"),
  packageRoot,
});

await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "app", "dist"),
  label: "@sandy/app dist",
  to: resolve(packageRoot, "app", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "server", "dist"),
  label: "@sandy/server dist",
  to: resolve(packageRoot, "server", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "packages", "bundled-plugins", "dist"),
  label: "@sandy/bundled-plugins dist",
  to: resolve(packageRoot, "server", "dist", "builtin-plugins"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "host-daemon", "dist"),
  label: "@sandy/host-daemon dist",
  to: resolve(packageRoot, "host-daemon", "dist"),
});
// The sandy CLI is code-split into host-daemon/dist/sandy-chunks. A turbo cache hit
// restores apps/host-daemon/dist without clearing it first, so the copy can
// carry an earlier build's hashed chunks; ship only the ones `sandy` reaches.
await assertPathExists(
  resolve(packageRoot, "host-daemon", "dist", "sandy-chunks"),
  "bundled sandy CLI chunks",
);
const pruneRun = await execFileAsync(
  "node",
  [resolve(packageRoot, "dist", "prune-sandy-chunks.mjs")],
  { cwd: packageRoot },
);
process.stderr.write(pruneRun.stderr);

process.stdout.write("sandy-app: built package assets\n");
