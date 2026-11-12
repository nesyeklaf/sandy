import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExperimentalSkillSelection as SkillSelection } from "@sandy-sdk/plugin-sdk/provider-bridge";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { PiRpcSession } from "./rpc-session.js";
import { npmNodeShim } from "./npm-shim.test-support.js";

const dirs: string[] = [];
const sessions: PiRpcSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.closeGracefully(1000);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
});

function fixture(
  version: unknown,
  selection: SkillSelection,
  shellEnvOverrides: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "sandy-pi-compat-"));
  dirs.push(root);
  const packageDir = join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const scratchDir = join(root, "scratch");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  mkdirSync(scratchDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version,
      type: "module",
      bin: { pi: "cli.js" },
    }),
  );
  writeFileSync(join(packageDir, "dist", "index.js"), "");
  const marker = join(root, "native-started");
  const cli = join(packageDir, "cli.js");
  writeFileSync(
    cli,
    `
    import { writeFileSync, writeSync } from "node:fs";
    import { createInterface } from "node:readline";
    writeFileSync(${JSON.stringify(marker)}, "native");
    const input = createInterface({ input: process.stdin });
    input.on("line", line => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true,
        data: { model: { provider: "fixture", id: "fixture" }, isStreaming: false, isCompacting: false },
      }) + "\\n");
    });
    input.on("close", () => process.exit(0));
    writeSync(3, JSON.stringify({ kind: "ready" }) + "\\n");
  `,
  );
  vi.stubEnv(PI_BRIDGE_COMMAND_ENV, process.execPath);
  vi.stubEnv(PI_BRIDGE_ARGS_ENV, JSON.stringify([cli]));
  const session = new PiRpcSession(
    {
      cwd: root,
      skillSelection: selection,
      sessionDir: root,
      sessionFilePath: join(root, "session.jsonl"),
      scratchDir,
      extensionPath: join(root, "extension.ts"),
      recordThreadId: "thr_compat_fixture",
      noSession: true,
      shellEnvOverrides,
    },
    async () => ({ content: "", isError: true }),
    () => undefined,
    () => undefined,
  );
  sessions.push(session);
  return { session, marker, scratchDir, root };
}

it.each([
  { mode: "disable", names: ["fixture"] },
  { mode: "allow-only", names: [] },
] satisfies SkillSelection[])(
  "refuses a filtered $mode start on Pi older than 1.5.1 without CLI fallback",
  async (selection) => {
    const f = fixture("0.84.0", selection);
    await expect(f.session.start()).rejects.toThrow(
      "requires Pi 1.5.1 or later; installed: 0.84.0",
    );
    expect(existsSync(f.marker)).toBe(false);
    expect(readdirSync(f.scratchDir)).toEqual([]);
  },
);

it("preserves the native inherit launcher for older supported Pi", async () => {
  const f = fixture("0.84.0", { mode: "inherit" });
  await f.session.start();
  expect(existsSync(f.marker)).toBe(true);
  await f.session.closeGracefully(1000);
  await vi.waitFor(() => expect(readdirSync(f.scratchDir)).toEqual([]));
});

it.skipIf(process.platform === "win32")(
  "keeps the configured runtime when the child PATH shadows node",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sandy-pi-runtime-"));
    dirs.push(root);
    const shadow = join(root, "node");
    writeFileSync(shadow, "#!/bin/sh\necho wrong-node >&2\nexit 65\n");
    chmodSync(shadow, 0o700);
    const f = fixture(
      "1.5.1",
      { mode: "disable", names: ["fixture"] },
      { PATH: root },
    );
    await expect(f.session.start()).rejects.toThrow(
      "missing DefaultResourceLoader",
    );
    expect(existsSync(f.marker)).toBe(false);
    await vi.waitFor(() => expect(readdirSync(f.scratchDir)).toEqual([]));
  },
);

it.skipIf(process.platform !== "win32")(
  "uses the native npm shim runtime for a filtered SDK worker",
  async () => {
    const f = fixture("1.5.1", { mode: "allow-only", names: [] });
    const shim = join(f.root, "pi.cmd");
    writeFileSync(
      shim,
      npmNodeShim("node_modules\\@earendil-works\\pi-coding-agent\\cli.js"),
    );
    copyFileSync(process.execPath, join(f.root, "node.exe"));
    vi.stubEnv(PI_BRIDGE_COMMAND_ENV, shim);
    vi.stubEnv(PI_BRIDGE_ARGS_ENV, "[]");
    await expect(f.session.start()).rejects.toThrow(
      "missing DefaultResourceLoader",
    );
    expect(existsSync(f.marker)).toBe(false);
    await vi.waitFor(() => expect(readdirSync(f.scratchDir)).toEqual([]));
  },
);

it("keeps native inherit for an unreadable manifest version", async () => {
  const f = fixture(1, { mode: "inherit" });
  await f.session.start();
  expect(existsSync(f.marker)).toBe(true);
});

it("removes scratch files when spawning throws synchronously", async () => {
  const f = fixture(
    "0.84.0",
    { mode: "inherit" },
    { SANDY_TEST_INVALID_ENV: "\0" },
  );
  await expect(f.session.start()).rejects.toThrow(/null bytes/i);
  expect(existsSync(f.marker)).toBe(false);
  expect(readdirSync(f.scratchDir)).toEqual([]);
});

it.each(["1.5.1", "1.5.2", "2.0.0"])(
  "uses the SDK worker for Pi %s and refuses it when the SDK lacks the adapter API",
  async (version) => {
    const f = fixture(version, { mode: "allow-only", names: [] });
    await expect(f.session.start()).rejects.toThrow(
      "missing DefaultResourceLoader",
    );
    expect(existsSync(f.marker)).toBe(false);
    await vi.waitFor(() => expect(readdirSync(f.scratchDir)).toEqual([]));
  },
);
