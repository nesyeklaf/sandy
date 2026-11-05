import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

// Preload that reports every process.exit call on fd 2, so a test sees whether the CLI ended through
// process.exit (the fallback timer) or because its event loop drained.
const EXIT_PROBE = `data:text/javascript,${encodeURIComponent(
  'import { writeSync } from "node:fs"; const exit = process.exit.bind(process); process.exit = (code) => { writeSync(2, "[process.exit " + code + "]\\n"); return exit(code); };',
)}`;
// Preload that holds the event loop open with a ref'd timer, as a leaked handle would.
const HOLD_LOOP = `data:text/javascript,${encodeURIComponent("setInterval(() => {}, 60_000);")}`;

const answer = JSON.stringify({ status: "ok", nonce: "n" });

async function runPluginCommand(
  exitCode: number,
  preloads: string[],
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/plugins/contributions") {
      response.end(
        JSON.stringify({
          cliCommands: [
            { pluginId: "fixture", name: "fixture", summary: "Fixture", commands: [] },
          ],
        }),
      );
    } else if (request.url === "/api/v1/plugins/fixture/cli") {
      request.resume();
      response.end(JSON.stringify({ exitCode, stdout: answer }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing fixture address");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SANDY_SERVER_URL: `http://127.0.0.1:${address.port}`,
    };
    for (const key of ["SANDY_CLI", "SANDY_CLI_REEXEC", "SANDY_PROJECT_ID", "SANDY_THREAD_ID"])
      delete env[key];
    const args = [
      "--conditions=source",
      "--import",
      "tsx",
      ...preloads.flatMap((preload) => ["--import", preload]),
      cliEntry,
      "fixture",
      "list",
    ];
    const started = Date.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("plugin CLI process exit", () => {
  // Windows, Node 24: process.exit right after the plugin request aborted in libuv with
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (exit 0xC0000409) after printing the answer.
  it.each([0, 7])(
    "exit %i: prints the answer and ends when its event loop drains, without process.exit",
    async (exitCode) => {
      const result = await runPluginCommand(exitCode, [EXIT_PROBE]);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(answer);
      expect(result.code).toBe(exitCode);
    },
    35_000,
  );

  it("a handle that holds the event loop open does not hang it: the fallback timer exits with the command's code", async () => {
    const result = await runPluginCommand(7, [EXIT_PROBE, HOLD_LOOP]);
    expect(result.stdout.trim()).toBe(answer);
    expect(result.stderr).toBe("[process.exit 7]\n");
    expect(result.code).toBe(7);
    expect(result.ms).toBeLessThan(25_000);
  }, 35_000);
});
