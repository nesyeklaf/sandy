import { execFile } from "node:child_process";

// The sandy CLI of the merged SANDY plugin (sandy/work): every part's commands sit under `sandy work <part>`.
export type WorkCliPart = "delegate" | "track" | "workflows-plus";

export function workCliArgs(part: WorkCliPart, ...args: string[]): string[] {
  return ["work", part, ...args];
}

/** Runs `sandy <args>`; resolves its stdout, rejects with its stderr (an aborted call rejects with the AbortError). */
export type RunSandy = (args: string[], signal?: AbortSignal) => Promise<string>;

// The program and leading arguments that run the sandy CLI (SANDY_CLI overrides `sandy`). On Windows SANDY_CLI is the
// extensionless node script of SANDY's host daemon (a shebang file, which CreateProcess cannot run) and execFile cannot
// start a .cmd wrapper without a shell, so anything that is not an .exe runs under the node that runs pi.
export function sandyCommand(env: Record<string, string | undefined>, platform: string, nodePath: string): { file: string; leadingArgs: string[] } {
  const cli = env.SANDY_CLI;
  if (platform === "win32" && cli && !/\.(exe|com|cmd|bat)$/i.test(cli)) return { file: nodePath, leadingArgs: [cli] };
  return { file: cli || "sandy", leadingArgs: [] };
}

// On Windows with Node 24 the sandy CLI up to 0.48.1 prints a plugin command's complete answer, then aborts in its
// process.exit with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c" (exit
// 0xC0000409; nodejs/node#56645). That process did its work: its answer counts when it is complete JSON (the work
// commands answer JSON on stdout, their failures go to stderr). Anything else stays a failure.
const LIBUV_TEARDOWN_ABORT = "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)";

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The one runner of the sandy CLI for the pi extensions. A failure rejects with "sandy <command>: <first stderr line>". */
export function sandyCli(options: { env?: Record<string, string | undefined>; timeoutMs?: number; maxBuffer?: number } = {}): RunSandy {
  const env = options.env ?? process.env;
  return (args, signal) =>
    new Promise((resolve, reject) => {
      const { file, leadingArgs } = sandyCommand(env, process.platform, process.execPath);
      const execOptions = { signal, timeout: options.timeoutMs ?? 15_000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, windowsHide: true };
      execFile(file, [...leadingArgs, ...args], execOptions, (error, stdout, stderr) => {
        const out = String(stdout);
        if (!error || (String(stderr).includes(LIBUV_TEARDOWN_ABORT) && isJson(out))) return resolve(out);
        if (error.name === "AbortError") return reject(error);
        const detail = String(stderr).trim().split("\n")[0]!.trim() || error.message;
        reject(new Error(`sandy ${args.slice(0, 3).join(" ")}: ${detail}`));
      });
    });
}
