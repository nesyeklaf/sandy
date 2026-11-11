import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { HolonError } from "./error.ts";

const failureBody = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().nullish() }),
});

const LISTENING = /holon serve: listening on http:\/\/(\S+)\r?\n/;
const STDERR_TAIL_BYTES = 2000;
const KILL_GRACE_MS = 2000;
const UNPROCESSABLE = 422;
const PAYLOAD_TOO_LARGE = 413;
const BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const BODY_LIMIT_MESSAGE = "the body is larger than 64 MB";
const BODY_LIMIT_HINT = "The plugin sends a file as one request of at most 64 MB. Import larger files with the standalone `holon evidence import --file <path>`";

export const START_TIMEOUT_MS = 10_000;
export const IDLE_STOP_MS = 15 * 60_000;
export const REQUEST_TIMEOUT_MS = 120_000;

export interface EngineOptions {
  bin?: string | undefined;
  startTimeoutMs?: number;
  idleStopMs?: number;
  requestTimeoutMs?: number;
}

export interface EngineRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | undefined>;
  contentType?: string;
  body?: string;
}

export interface EngineReply {
  status: number;
  text: string;
}

interface ServeProcess {
  proc: ChildProcess;
  base: string;
  token: string;
  exited: Promise<void>;
  inflight: number;
  idle: NodeJS.Timeout | null;
}

interface Entry {
  token: string;
  started: Promise<ServeProcess>;
}

function notInstalled(bin: string, explicit: boolean): HolonError {
  return new HolonError(
    explicit ? `HOLON_BIN ${bin} cannot be started` : "the holon binary is not installed",
    "holon_not_installed",
    "Install holon from github.com/nesyeklaf/holons (cargo install --path holon-cli) so `holon` is on PATH, or set HOLON_BIN to its absolute path",
  );
}

class NotSent extends Error {}

function timedOut(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "TimeoutError";
}

function connectionRefused(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const detail = cause.cause as { code?: string; errors?: { code?: string }[] } | undefined;
  return detail?.code === "ECONNREFUSED" || (detail?.errors?.some((item) => item.code === "ECONNREFUSED") ?? false);
}

function canonicalRoot(root: string): string {
  const absolute = resolve(root);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function closedError(): HolonError {
  return new HolonError("the holon engine is closed", "closed");
}

export class HolonEngine {
  private readonly options: EngineOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly owned = new Set<ServeProcess>();
  private closed = false;
  private readonly onProcessExit = () => {
    for (const serve of this.owned) serve.proc.kill("SIGKILL");
  };

  constructor(options: EngineOptions = {}) {
    this.options = options;
    process.once("exit", this.onProcessExit);
  }

  private binary(): { bin: string; explicit: boolean } {
    const configured = this.options.bin ?? process.env.HOLON_BIN;
    return configured === undefined || configured === "" ? { bin: "holon", explicit: false } : { bin: configured, explicit: true };
  }

  private launch(root: string, token: string): Promise<ServeProcess> {
    const { bin, explicit } = this.binary();
    const timeoutMs = this.options.startTimeoutMs ?? START_TIMEOUT_MS;
    return new Promise<ServeProcess>((resolve, reject) => {
      const proc = spawn(bin, ["serve", "--root", root, "--host", "127.0.0.1", "--port", "0", "--exit-on-stdin-close"], {
        env: { ...process.env, HOLON_TOKEN: token },
        stdio: ["pipe", "ignore", "pipe"],
      });
      proc.stdin!.on("error", () => {});
      let tail = "";
      let settled = false;
      let markExited!: () => void;
      const exited = new Promise<void>((done) => {
        markExited = done;
      });
      const serve: ServeProcess = { proc, base: "", token, exited, inflight: 0, idle: null };
      this.owned.add(serve);
      const forget = () => {
        if (this.entries.get(root)?.token === token) this.entries.delete(root);
      };
      const fail = (error: HolonError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        forget();
        proc.kill("SIGKILL");
        reject(this.closed ? closedError() : error);
      };
      const timer = setTimeout(
        () => fail(new HolonError(`holon serve did not report its address within ${timeoutMs / 1000} s. stderr: ${tail.trim() || "(empty)"}`, "holon_start_timeout")),
        timeoutMs,
      );
      proc.stderr!.setEncoding("utf8");
      proc.stderr!.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
        if (settled) return;
        const match = LISTENING.exec(tail);
        if (match === null) return;
        settled = true;
        clearTimeout(timer);
        serve.base = `http://${match[1]}`;
        resolve(serve);
      });
      proc.on("error", (error: NodeJS.ErrnoException) => {
        this.owned.delete(serve);
        markExited();
        fail(error.code === "ENOENT" || error.code === "EACCES" ? notInstalled(bin, explicit) : new HolonError(`cannot start ${bin}: ${error.message}`, "holon_start_failed"));
      });
      proc.on("exit", (code, signal) => {
        this.owned.delete(serve);
        markExited();
        if (serve.idle !== null) clearTimeout(serve.idle);
        forget();
        fail(new HolonError(`holon serve exited with ${signal ?? code} before it was ready. stderr: ${tail.trim() || "(empty)"}`, "holon_start_failed"));
      });
    });
  }

  private ensure(root: string): Promise<ServeProcess> {
    if (this.closed) return Promise.reject(closedError());
    let entry = this.entries.get(root);
    if (entry === undefined) {
      const token = randomBytes(24).toString("hex");
      entry = { token, started: this.launch(root, token) };
      this.entries.set(root, entry);
    }
    return entry.started;
  }

  private armIdle(serve: ServeProcess): void {
    if (serve.idle !== null) clearTimeout(serve.idle);
    serve.idle = setTimeout(() => {
      if (serve.inflight === 0) void this.stop(serve);
    }, this.options.idleStopMs ?? IDLE_STOP_MS);
    serve.idle.unref();
  }

  private stop(serve: ServeProcess): Promise<void> {
    if (serve.idle !== null) clearTimeout(serve.idle);
    serve.proc.kill("SIGTERM");
    const force = setTimeout(() => serve.proc.kill("SIGKILL"), KILL_GRACE_MS);
    return serve.exited.finally(() => clearTimeout(force));
  }

  private async attempt(serve: ServeProcess, request: EngineRequest): Promise<EngineReply> {
    const url = new URL(request.path, serve.base);
    for (const [name, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(name, value);
    const headers: Record<string, string> = { Authorization: `Bearer ${serve.token}` };
    if (request.contentType !== undefined) headers["Content-Type"] = request.contentType;
    if (serve.proc.exitCode !== null || serve.proc.signalCode !== null) throw new NotSent("holon serve has exited");
    serve.inflight += 1;
    try {
      const response = await fetch(url, {
        method: request.method,
        headers,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return { status: response.status, text: await response.text() };
    } finally {
      serve.inflight -= 1;
      this.armIdle(serve);
    }
  }

  private timeout(root: string, request: EngineRequest): HolonError {
    const seconds = (this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) / 1000;
    return new HolonError(
      `holon serve for ${root} did not answer ${request.method} ${request.path} within ${seconds} s`,
      "holon_timeout",
      "The server is kept running and may still be working. Try again, or run the standalone holon CLI for a very large model or evidence file",
    );
  }

  private sendFailure(root: string, request: EngineRequest, cause: unknown): HolonError {
    if (request.body !== undefined && Buffer.byteLength(request.body) > BODY_LIMIT_BYTES) return new HolonError(BODY_LIMIT_MESSAGE, "body_too_large", BODY_LIMIT_HINT);
    return new HolonError(`holon serve for ${root} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, "holon_unreachable");
  }

  async request(requested: string, request: EngineRequest): Promise<EngineReply> {
    const root = canonicalRoot(requested);
    const first = await this.ensure(root);
    try {
      return await this.attempt(first, request);
    } catch (cause) {
      if (this.closed) throw closedError();
      if (timedOut(cause)) throw this.timeout(root, request);
      if (request.body !== undefined && !(cause instanceof NotSent) && !connectionRefused(cause)) throw this.sendFailure(root, request, cause);
      await this.stop(first);
      const second = await this.ensure(root);
      try {
        return await this.attempt(second, request);
      } catch (retryCause) {
        if (this.closed) throw closedError();
        if (timedOut(retryCause)) throw this.timeout(root, request);
        throw this.sendFailure(root, request, cause);
      }
    }
  }

  async call(root: string, request: EngineRequest): Promise<EngineReply> {
    const reply = await this.request(root, request);
    if (reply.status < 400) return reply;
    let body: unknown = null;
    try {
      body = JSON.parse(reply.text);
    } catch {
      body = null;
    }
    const failure = failureBody.safeParse(body);
    if (reply.status === PAYLOAD_TOO_LARGE) throw new HolonError(failure.success ? failure.data.error.message : BODY_LIMIT_MESSAGE, "body_too_large", BODY_LIMIT_HINT);
    if (failure.success) {
      const { code, message, hint } = failure.data.error;
      throw new HolonError(message, code, hint ?? undefined);
    }
    if (reply.status === UNPROCESSABLE) return reply;
    throw new HolonError(`holon serve answered ${reply.status} without an error body: ${reply.text.slice(0, 200)}`, "holon_bad_reply");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.entries.clear();
    await Promise.all([...this.owned].map((serve) => this.stop(serve)));
    process.off("exit", this.onProcessExit);
  }
}
