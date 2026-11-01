import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reservePort, wait } from "./cdp.mjs";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const refuseProductionDataDir = (dataDir) => {
  const resolved = resolve(dataDir);
  const forbidden = [join(homedir(), ".sandy"), join(homedir(), ".sandy-machines")];
  if (
    forbidden.some(
      (path) => resolved === path || resolved.startsWith(path + "/"),
    )
  ) {
    throw new Error(
      "Refusing to run perf captures against " +
        resolved +
        ". Use an isolated --data-dir seeded with pnpm seed:perf.",
    );
  }
};

const waitForHttp = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(
    "Server did not become ready at " +
      url +
      ": " +
      (lastError?.message ?? "timeout"),
  );
};

export const startAppServer = async ({
  dataDir,
  serverPort,
  daemonPort,
  logPath,
  perfDiagnostics = false,
  timeoutMs = 180_000,
  repoRoot = REPO_ROOT,
  env = {},
}) => {
  refuseProductionDataDir(dataDir);
  if (!existsSync(join(dataDir, "sandy.db"))) {
    throw new Error(
      "No database in " +
        dataDir +
        ". Run: pnpm seed:perf -- --reset --events 400000 --data-dir " +
        dataDir,
    );
  }
  const port = serverPort ?? (await reservePort());
  const hostPort = daemonPort ?? (await reservePort());
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const args = [
    "--conditions=source",
    "--import",
    "tsx",
    join(repoRoot, "scripts/start-sandy.mjs"),
    "--data-dir",
    dataDir,
    "--server-port",
    String(port),
    "--host-daemon-port",
    String(hostPort),
  ];
  if (perfDiagnostics) args.push("--perf-diagnostics");
  const proc = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      ...env,
      NODE_ENV: "production",
      SANDY_SKIP_ONBOARDING: "1",
    },
  });
  const url = "http://127.0.0.1:" + port;
  await waitForHttp(url + "/api/v1/sidebar-bootstrap", timeoutMs);
  return {
    url,
    pid: proc.pid,
    async stop() {
      try {
        process.kill(-proc.pid, "SIGINT");
      } catch {}
      await wait(3000);
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    },
  };
};

export const attachToServer = async (url) => {
  const base = url.replace(/\/$/, "");
  await waitForHttp(base + "/api/v1/sidebar-bootstrap", 15_000);
  return { url: base, pid: null, async stop() {} };
};
