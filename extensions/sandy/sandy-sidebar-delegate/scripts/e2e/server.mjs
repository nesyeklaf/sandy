import { spawn } from "node:child_process";
import { constants, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createIsolationGuard } from "./isolation.mjs";
import { createScratchKeychain } from "./keychain.mjs";

export async function startScratchServer() {
  const args = process.argv.slice(2);
  const appIndex = args.indexOf("--app-dir");
  const sourceAppDir = resolve(appIndex < 0 ? "node_modules/sandy-app" : args[appIndex + 1]);
  const inheritedUrl = process.env.SANDY_SERVER_URL;
  if (inheritedUrl && Number(new URL(inheritedUrl).port || 80) === 38886) {
    throw new Error("Refusing SANDY_SERVER_URL on the developer's port 38886. Strip inherited SANDY_* variables.");
  }
  const scratch = mkdtempSync("/tmp/sandy-sidebar-smoke-");
  if (!scratch.startsWith("/tmp/")) throw new Error("Scratch data must be under /tmp");
  const children = new Set();
  let cleaning;
  const toolEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key === "PATH" || key === "HOME" || /^npm_/i.test(key)),
  );
  const home = join(scratch, "home");
  const env = {
    ...toolEnv,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    TMPDIR: join(scratch, "tmp"),
  };
  for (const path of Object.values(env).filter((value) => value.startsWith(scratch))) {
    mkdirSync(path, { recursive: true });
  }
  const logPath = resolve("e2e-artifacts/isolation.jsonl");
  mkdirSync(resolve("e2e-artifacts"), { recursive: true });
  writeFileSync(logPath, "");
  let checkIsolation;
  let monitoring;
  let stopMonitoring = false;
  let isolationFailure;
  let marketplace;
  const freePort = () =>
    new Promise((accept, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => accept(port));
      });
    });

  function start(command, argv, options = {}) {
    const child = spawn(command, argv, { env, detached: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const done = new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => accept({ code, stdout, stderr }));
    });
    return { child, done, output: () => ({ stdout, stderr }) };
  }

  async function run(command, argv, { allowFailure = false, timeoutMs = 120_000, stream = false, ...options } = {}) {
    if (isolationFailure) throw isolationFailure;
    const task = start(command, argv, options);
    if (stream) {
      task.child.stdout.pipe(process.stdout);
      task.child.stderr.pipe(process.stderr);
    }
    let timeout;
    const result = await Promise.race([
      task.done,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out: ${command} ${argv.join(" ")}`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (result.code !== 0 && !allowFailure)
      throw new Error(`${command} ${argv.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  }

  function signal(child, name) {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  function cleanup() {
    cleaning ??= (async () => {
      stopMonitoring = true;
      await monitoring;
      for (const child of children) signal(child, "SIGTERM");
      await delay(1500);
      for (const child of children) signal(child, "SIGKILL");
      marketplace?.closeAllConnections();
      if (marketplace) await new Promise((accept) => marketplace.close(accept));
      rmSync(scratch, { recursive: true, force: true });
      console.log("CLEANUP: process groups stopped; scratch data removed (including scratch TMPDIR)");
      if (isolationFailure) throw isolationFailure;
    })();
    return cleaning;
  }

  for (const name of ["SIGINT", "SIGTERM"]) {
    process.once(name, () => {
      void cleanup().then(() => process.exit(130));
    });
  }

  try {
    try {
      const codex = await run("codex", ["--version"], { timeoutMs: 10_000 });
      console.log(`FIXTURE PROVIDER: ${codex.stdout.trim()}`);
    } catch (cause) {
      throw new Error("Browser fixtures require Codex on PATH. Install @openai/codex@0.162.1 before running e2e.", {
        cause,
      });
    }
    await createScratchKeychain({ ...env, SANDY_DATA_DIR: scratch });
    const runtimeModules = join(scratch, "runtime/node_modules");
    cpSync(resolve("node_modules"), runtimeModules, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const appDir =
      sourceAppDir === resolve("node_modules/sandy-app")
        ? join(runtimeModules, "sandy-app")
        : join(scratch, "runtime/sandy-app");
    if (appDir !== join(runtimeModules, "sandy-app")) {
      cpSync(sourceAppDir, appDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
    const port = await freePort();
    let hostPort = await freePort();
    while (hostPort === port) hostPort = await freePort();
    if (port === 38886 || hostPort === 38886) throw new Error("Refusing the developer's port");
    const url = `http://127.0.0.1:${port}`;
    // The fresh host otherwise refreshes the community catalog over HTTPS.
    marketplace = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ schemaVersion: 2, name: "sandy-community", displayName: "Scratch catalog", plugins: [] }),
      );
    });
    await new Promise((accept, reject) => {
      marketplace.once("error", reject);
      marketplace.listen(0, "127.0.0.1", accept);
    });
    const marketplacePort = marketplace.address().port;
    if (marketplacePort === 38886) throw new Error("Refusing the developer's port");
    Object.assign(env, {
      SANDY_DATA_DIR: scratch,
      SANDY_SERVER_URL: url,
      SANDY_SERVER_PORT: String(port),
      SANDY_HOST_DAEMON_PORT: String(hostPort),
      SANDY_TELEMETRY: "false",
      SANDY_MARKETPLACE_URL: `http://127.0.0.1:${marketplacePort}/marketplace.json`,
    });
    writeFileSync(
      join(env.CODEX_HOME, "config.toml"),
      `
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
trace_exporter = "none"
`,
    );
    const version = JSON.parse(readFileSync(join(appDir, "package.json"))).version;
    console.log(`ISOLATION: sandy-app ${version}; ${url}; data ${scratch}; host port ${hostPort}`);
    const app = start(
      process.execPath,
      [
        join(appDir, "dist/sandy-app.js"),
        "--bundled",
        "--data-dir",
        scratch,
        "--server-port",
        String(port),
        "--host-daemon-port",
        String(hostPort),
      ],
      { cwd: scratch },
    );
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        ready = (await fetch(url)).status === 200;
      } catch {
        /* Not listening yet. */
      }
      if (ready) break;
      if (app.child.exitCode !== null) throw new Error(JSON.stringify(app.output()));
      await delay(500);
    }
    if (!ready) throw new Error(`Server never became ready: ${JSON.stringify(app.output())}`);
    const sandy = join(appDir, "host-daemon/dist/sandy");
    console.log("READY: GET / returned 200");
    checkIsolation = createIsolationGuard(app.child.pid, scratch, env, logPath, toolEnv.HOME);
    await checkIsolation("ready");
    monitoring = (async () => {
      while (!stopMonitoring) {
        await delay(1000);
        if (stopMonitoring) break;
        try {
          await checkIsolation("monitor");
        } catch (error) {
          isolationFailure = error;
          for (const child of children) signal(child, "SIGTERM");
          break;
        }
      }
    })();
    await run("npm", ["run", "build"], { env: { ...toolEnv, SANDY_DATA_DIR: scratch, SANDY_SERVER_URL: url } });
    console.log("BUILD: passed");
    // Pi model discovery overwrites its process title/environment display on macOS.
    // These fixtures use Codex; disable Pi in scratch before the UI requests models.
    await run(sandy, ["provider", "disable", "pi"]);
    const pluginDir = join(scratch, "plugin");
    cpSync(process.cwd(), pluginDir, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) =>
        ![".git", "node_modules", "test-results", "playwright-report", "e2e-artifacts"].some(
          (name) => path === resolve(name) || path.startsWith(`${resolve(name)}/`),
        ),
    });
    symlinkSync(runtimeModules, join(pluginDir, "node_modules"));
    await run(sandy, ["plugin", "install", `path:${pluginDir}`, "--yes"]);
    await run(sandy, ["settings", "ui", "set", "sidebar.threadListProvider", "sandy-sidebar/inbox"]);
    await run(sandy, ["settings", "general", "onboardingCompletedAt", new Date().toISOString()]);
    const repo = join(scratch, "repo");
    await run("git", ["init", "--initial-branch=main", repo]);
    await run("git", [
      "-C",
      repo,
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Scratch smoke fixture",
    ]);
    const projectResult = await run(sandy, ["project", "create", "--name", "Sidebar smoke", "--root", repo, "--json"]);
    const project = JSON.parse(projectResult.stdout);
    const projectId = project.id ?? project.project?.id;
    if (!projectId) throw new Error(`No project id: ${projectResult.stdout}`);

    async function cli(argv, options) {
      return run(sandy, argv, options);
    }
    async function diagnostics() {
      try {
        writeFileSync(resolve("e2e-artifacts/server.log"), JSON.stringify(app.output(), null, 2));
        const listing = await cli(["thread", "list", "--json"], { timeoutMs: 10_000 });
        const data = JSON.parse(listing.stdout);
        for (const thread of Array.isArray(data) ? data : (data.threads ?? [])) {
          for (const command of ["get", "log"]) {
            const result = await cli(["thread", command, thread.id, "--json"], {
              allowFailure: true,
              timeoutMs: 10_000,
            });
            writeFileSync(resolve(`e2e-artifacts/${thread.id}-${command}.json`), result.stdout || result.stderr);
          }
        }
      } catch (error) {
        console.error("Could not collect scratch thread diagnostics:", error.message);
      }
    }
    async function seed(title, { idle = false } = {}) {
      const result = await cli([
        "thread",
        "spawn",
        "--project",
        projectId,
        "--title",
        title,
        "--prompt",
        idle ? "" : "Scratch scheduled e2e fixture",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        ...(idle ? ["--environment", repo] : ["--send-at", "7d"]),
        "--json",
      ]);
      const data = JSON.parse(result.stdout);
      const id = data.id ?? data.thread?.id;
      if (!id) throw new Error("Scratch thread returned no id");
      if (idle) {
        await cli(["thread", "stop", id, "--json"]);
        await cli(["thread", "wait", id, "--status", "idle", "--timeout", "30s", "--json"]);
        const { thread } = JSON.parse((await cli(["thread", "get", id, "--json"])).stdout);
        if (!thread.environmentId || thread.queuedMessageCount) throw new Error("Idle fixture is not initialized");
        const events = JSON.parse((await cli(["thread", "log", id, "--json"])).stdout);
        const unexpected = events.filter((event) => {
          if (event.type.startsWith("item/")) return true;
          if (!event.type.startsWith("provider/")) return false;
          return (
            event.type !== "provider/warning" &&
            !(event.type === "provider/unhandled" && event.data.rawType === "account/updated")
          );
        });
        if (unexpected.length) {
          throw new Error(
            `Fixture unexpectedly produced agent output or provider errors: ${unexpected.map((event) => event.type).join(", ")}`,
          );
        }
      }
      return { id, title };
    }
    return { url, scratch, env, toolEnv, cli, seed, run, cleanup, diagnostics, checkIsolation, projectId, sandy };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
