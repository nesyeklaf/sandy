import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNodeEsmEntry,
  copyDirectory,
  pruneUnreferencedChunks,
} from "../../../scripts/build-utils.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const hostPackageRoot = resolve(packageRoot, "host-package");
const hostDaemonSource = resolve(workspaceRoot, "apps", "host-daemon", "dist");
const hostDaemonTarget = resolve(hostPackageRoot, "host-daemon", "dist");
const dependencyNames = [
  "@parcel/watcher",
  "fs-native-extensions",
  "node-pty",
  "pino",
  "pino-opentelemetry-transport",
  "pino-pretty",
  "pino-roll",
];
const hostDaemonFiles = [
  "sandy-parcel-watcher-child.mjs",
  "sandy-plugin-host-worker.mjs",
  "sandy-provider-bridge-worker.mjs",
  "daemon-bundle.mjs",
];

const sourcePackageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const dependencies = Object.fromEntries(
  dependencyNames.map((name) => {
    const version = sourcePackageJson.dependencies?.[name];
    if (typeof version !== "string") {
      throw new Error(`Missing sandy host dependency ${name}`);
    }
    return [name, version];
  }),
);

await rm(hostPackageRoot, { force: true, recursive: true });
await buildNodeEsmEntry({
  cleanDist: true,
  entryPoint: resolve(packageRoot, "src", "bin", "sandy-app.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "sandy-app.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "sandy.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "sandy.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "sandy-host-daemon.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "sandy-host-daemon.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});

await mkdir(hostDaemonTarget, { recursive: true });
await copyFile(
  resolve(hostDaemonSource, "sandy"),
  resolve(hostDaemonTarget, "sandy"),
);
await chmod(resolve(hostDaemonTarget, "sandy"), 0o755);
await copyFile(
  resolve(hostDaemonSource, "sandy.cmd"),
  resolve(hostDaemonTarget, "sandy.cmd"),
);
await copyDirectory({
  from: resolve(hostDaemonSource, "sandy-chunks"),
  to: resolve(hostDaemonTarget, "sandy-chunks"),
});
await pruneUnreferencedChunks({
  chunkDir: resolve(hostDaemonTarget, "sandy-chunks"),
  entry: resolve(hostDaemonTarget, "sandy"),
});
for (const fileName of hostDaemonFiles) {
  await copyFile(
    resolve(hostDaemonSource, fileName),
    resolve(hostDaemonTarget, fileName),
  );
}

await copyFile(
  resolve(packageRoot, "README.md"),
  resolve(hostPackageRoot, "README.md"),
);
await writeFile(
  resolve(hostPackageRoot, "package.json"),
  `${JSON.stringify(
    {
      name: sourcePackageJson.name,
      version: sourcePackageJson.version,
      description: "sandy enrolled host runtime",
      type: "module",
      os: [...new Set([...sourcePackageJson.os, "win32"])],
      bin: {
        sandy: "dist/sandy.js",
        "sandy-app": "dist/sandy-app.js",
        "sandy-host-daemon": "dist/sandy-host-daemon.js",
      },
      files: ["dist", "host-daemon", "README.md"],
      engines: sourcePackageJson.engines,
      dependencies,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write("sandy-app: built enrolled host package\n");
