import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

export const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const chromeCandidates = () => {
  if (platform() === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (platform() === "win32") {
    return [
      join(
        process.env.PROGRAMFILES ?? "",
        "Google/Chrome/Application/chrome.exe",
      ),
      join(
        process.env["PROGRAMFILES(X86)"] ?? "",
        "Google/Chrome/Application/chrome.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Google/Chrome/Application/chrome.exe",
      ),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome"),
  ];
};

export const resolveChrome = (explicit) => {
  const requested = explicit ?? process.env.SANDY_PERF_CHROME;
  if (requested) {
    const candidate = resolve(requested);
    if (!existsSync(candidate))
      throw new Error(`Chrome executable not found: ${candidate}`);
    return candidate;
  }
  const candidate = chromeCandidates().find((path) => path && existsSync(path));
  if (!candidate)
    throw new Error(
      "Chrome/Chromium was not found. Pass --chrome or set SANDY_PERF_CHROME.",
    );
  return candidate;
};

export const reservePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });

const waitForJson = async (url, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(
    `Chrome debugging endpoint did not start: ${lastError?.message ?? url}`,
  );
};

export const createPageTarget = async (port) => {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForJson(`${baseUrl}/json/version`);
  try {
    const response = await fetch(
      `${baseUrl}/json/new?${encodeURIComponent("about:blank")}`,
      { method: "PUT" },
    );
    if (response.ok) {
      const target = await response.json();
      if (target?.type === "page" && target.webSocketDebuggerUrl) return target;
    }
  } catch {}
  const targets = await waitForJson(`${baseUrl}/json`);
  const target = targets.find(
    (entry) => entry.type === "page" && entry.webSocketDebuggerUrl,
  );
  if (!target) throw new Error("Chrome did not expose or create a page target");
  return target;
};

export const ANTI_THROTTLING_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
];

export const UNCAPPED_FRAME_ARGS = [
  "--disable-frame-rate-limit",
  "--disable-gpu-vsync",
];

export const launchChrome = ({
  chrome,
  profileDir,
  port,
  headless = true,
  extraArgs = [],
  windowSize = "1600,1000",
}) => {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--force-device-scale-factor=1",
    ...ANTI_THROTTLING_ARGS,
    ...UNCAPPED_FRAME_ARGS,
    ...extraArgs,
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  if (process.getuid?.() === 0) args.unshift("--no-sandbox");
  return spawn(chrome, args, { stdio: "ignore" });
};

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolveConnect, reject) => {
      this.socket.addEventListener("open", resolveConnect, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(new Error(`${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  once(method, timeoutMs = 15_000) {
    return new Promise((resolveEvent, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const unsubscribe = this.on(method, (params) => {
        clearTimeout(timeout);
        unsubscribe();
        resolveEvent(params);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

export const evaluateValue = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `Page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value ?? null;
};
