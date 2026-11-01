import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { reservePort, wait } from "./cdp.mjs";

export const DEFAULT_FIREFOX = join(
  homedir(),
  "sandy-perf/firefox/firefox/firefox",
);
export const PROFILER_THREADS = [
  "GeckoMain",
  "Renderer",
  "Compositor",
  "StyleThread",
  "DOM Worker",
];
export const PROFILER_FEATURES = ["js", "cpu", "nomarkerstacks"];

export const resolveFirefox = (explicit) => {
  const candidate = resolve(
    explicit ?? process.env.SANDY_PERF_FIREFOX ?? DEFAULT_FIREFOX,
  );
  if (!existsSync(candidate))
    throw new Error(
      "Firefox executable not found: " +
        candidate +
        ". Pass --firefox or set SANDY_PERF_FIREFOX.",
    );
  return candidate;
};

class BidiClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    await new Promise((resolveOpen, reject) => {
      socket.onopen = resolveOpen;
      socket.onerror = () =>
        reject(new Error("BiDi socket failed: " + this.url));
    });
    socket.onmessage = (message) => this.receive(JSON.parse(message.data));
    socket.onclose = () => {
      for (const { reject } of this.pending.values())
        reject(new Error("BiDi socket closed"));
      this.pending.clear();
    };
    this.socket = socket;
  }

  receive(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve: done, reject, method } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === "error")
        reject(
          new Error(
            method + ": " + message.error + " " + (message.message ?? ""),
          ),
        );
      else done(message.result);
      return;
    }
    if (message.type === "event")
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  close() {
    this.socket?.close();
  }
}

const connectBidi = async (port, exited) => {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    const client = new BidiClient("ws://127.0.0.1:" + port + "/session");
    try {
      await Promise.race([client.connect(), exited]);
      return client;
    } catch (error) {
      if (error.message.startsWith("Firefox exited")) throw error;
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(
    "Firefox remote agent did not start: " + (lastError?.message ?? port),
  );
};

const jsonExpression = (expression) =>
  "(async () => { const value = await (" +
  expression +
  "); return value === undefined ? '__undefined__' : JSON.stringify(value) })()";

const evaluationValue = (result) => {
  if (result.type === "exception")
    throw new Error(
      "evaluate failed: " +
        (result.exceptionDetails?.text ?? JSON.stringify(result)),
    );
  const text = result.result?.value;
  if (typeof text !== "string" || text === "__undefined__") return undefined;
  return JSON.parse(text);
};

const pointerMoves = (from, to, steps) =>
  Array.from({ length: steps }, (_, index) => {
    const share = (index + 1) / steps;
    return {
      type: "pointerMove",
      x: Math.round(from.x + (to.x - from.x) * share),
      y: Math.round(from.y + (to.y - from.y) * share),
      duration: 16,
    };
  });

export class FirefoxBrowser {
  constructor({ client, proc, profileDir, chromeContext, context, log }) {
    this.client = client;
    this.proc = proc;
    this.profileDir = profileDir;
    this.chromeContext = chromeContext;
    this.context = context;
    this.log = log;
    this.pointer = { x: 0, y: 0 };
  }

  static async launch({
    firefox,
    windowSize = "1600,1000",
    headless = true,
  } = {}) {
    const executable = resolveFirefox(firefox);
    const port = await reservePort();
    const profileDir = mkdtempSync(join(tmpdir(), "sandy-perf-firefox-"));
    const args = [
      "--no-remote",
      "--profile",
      profileDir,
      "--remote-debugging-port",
      String(port),
      "--remote-allow-system-access",
      "--window-size",
      windowSize,
    ];
    if (headless) args.unshift("--headless");
    const proc = spawn(executable, args, {
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = [];
    const keep = (chunk) => {
      log.push(String(chunk));
      if (log.length > 200) log.shift();
    };
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    const exited = new Promise((_, reject) =>
      proc.once("exit", (code) =>
        reject(new Error("Firefox exited early with code " + code)),
      ),
    );
    exited.catch(() => {});
    try {
      const client = await connectBidi(port, exited);
      await client.send("session.new", { capabilities: {} });
      const chrome = await client.send("browsingContext.getTree", {
        "moz:scope": "chrome",
        maxDepth: 0,
      });
      const content = await client.send("browsingContext.getTree", {
        maxDepth: 0,
      });
      const tab = await client.send("browsingContext.create", { type: "tab" });
      for (const { context } of content.contexts)
        await client.send("browsingContext.close", { context });
      const chromeContext = chrome.contexts?.[0]?.context;
      if (!chromeContext)
        throw new Error(
          "No chrome context; Firefox needs --remote-allow-system-access",
        );
      return new FirefoxBrowser({
        client,
        proc,
        profileDir,
        chromeContext,
        context: tab.context,
        log,
      });
    } catch (error) {
      proc.kill("SIGKILL");
      rmSync(profileDir, { recursive: true, force: true });
      throw new Error(error.message + "\n" + log.join("").slice(-1500));
    }
  }

  async evaluateIn(context, expression) {
    const result = await this.client.send("script.evaluate", {
      target: { context },
      expression: jsonExpression(expression),
      awaitPromise: true,
      resultOwnership: "none",
    });
    return evaluationValue(result);
  }

  evaluate(expression) {
    return this.evaluateIn(this.context, expression);
  }

  chromeEvaluate(expression) {
    return this.evaluateIn(this.chromeContext, expression);
  }

  async version() {
    return this.chromeEvaluate("Services.appinfo.version");
  }

  async addPreloadScript(source) {
    await this.client.send("script.addPreloadScript", {
      functionDeclaration: "() => {" + source + "\n}",
    });
  }

  async setViewport({ width, height }) {
    await this.client.send("browsingContext.setViewport", {
      context: this.context,
      viewport: { width, height },
      devicePixelRatio: 1,
    });
  }

  async navigate(url) {
    await this.client.send("browsingContext.navigate", {
      context: this.context,
      url,
      wait: "complete",
    });
  }

  async waitForExpression(
    expression,
    { timeoutMs = 30_000, intervalMs = 50, description = expression } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate("Boolean(" + expression + ")")) return;
      await wait(intervalMs);
    }
    throw new Error(
      "Timed out after " + timeoutMs + " ms waiting for: " + description,
    );
  }

  async center(selector) {
    const point = await this.evaluate(
      "(() => { const el = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()",
    );
    if (!point) throw new Error("No element matches " + selector);
    return point;
  }

  async reveal(selector) {
    await this.evaluate(
      "(() => { const node = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (!node) throw new Error('no element for ' + " +
        JSON.stringify(selector) +
        "); node.scrollIntoView({ block: 'nearest' }); return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))) })()",
    );
  }

  async pointerActions(actions) {
    await this.client.send("input.performActions", {
      context: this.context,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions,
        },
      ],
    });
  }

  async hover(target, { steps = 6 } = {}) {
    const point =
      typeof target === "string" ? await this.center(target) : target;
    const to = { x: Math.round(point.x), y: Math.round(point.y) };
    await this.pointerActions(pointerMoves(this.pointer, to, steps));
    this.pointer = to;
    return to;
  }

  async click(target, { hoverMs = 150, pressMs = 80, steps = 6 } = {}) {
    const to = await this.hover(target, { steps });
    await this.pointerActions([
      { type: "pause", duration: Math.max(0, Math.round(hoverMs)) },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: Math.max(0, Math.round(pressMs)) },
      { type: "pointerUp", button: 0 },
    ]);
    return to;
  }

  async pressKey(key) {
    await this.client.send("input.performActions", {
      context: this.context,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: key },
            { type: "keyUp", value: key },
          ],
        },
      ],
    });
  }

  async startProfiler({
    entries = 64 * 1024 * 1024,
    intervalMs = 1,
    features = PROFILER_FEATURES,
    threads = PROFILER_THREADS,
  } = {}) {
    await this.chromeEvaluate(
      "Services.profiler.StartProfiler(" +
        [entries, intervalMs, features, threads]
          .map((value) => JSON.stringify(value))
          .join(", ") +
        ").then(() => Services.profiler.IsActive())",
    );
  }

  async dumpProfile(path) {
    await this.chromeEvaluate(
      "Services.profiler.dumpProfileToFileAsync(" +
        JSON.stringify(path) +
        ").then(() => true)",
    );
  }

  async stopProfiler() {
    await this.chromeEvaluate(
      "Promise.resolve(Services.profiler.StopProfiler()).then(() => true)",
    );
  }

  async close() {
    const exited = new Promise((done) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) done();
      else this.proc.once("exit", done);
    });
    await Promise.race([
      this.client.send("browser.close").catch(() => null),
      wait(5000),
    ]);
    this.client.close();
    const closed = await Promise.race([exited.then(() => true), wait(5000)]);
    if (!closed) {
      this.proc.kill("SIGKILL");
      await Promise.race([exited, wait(3000)]);
    }
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}
