import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ExperimentalSkillSelection as SkillSelection } from "@sandy-sdk/plugin-sdk/provider-bridge";
import { PiRpcChild } from "./rpc-child.js";
import { PiRpcSession } from "./rpc-session.js";
import { SANDY_PI_EXTENSION_SOURCE } from "./sandy-pi-extension.js";
import { preparePiSdkRpcLaunch } from "./skill-selection.js";
import { locatePiPackageDir } from "../pi-package-skills.js";

const realPiCommand = process.env.SANDY_TEST_REAL_PI_COMMAND;
const commandsSchema = z.object({
  commands: z.array(z.object({ name: z.string(), source: z.string() })),
});
const snapshotSchema = z.object({
  prompt: z.string(),
  tools: z.array(z.string()),
  trusted: z.boolean(),
  cwd: z.string(),
  offline: z.string().optional(),
  skipVersionCheck: z.string().optional(),
});

describe.skipIf(!realPiCommand)("Pi SDK worker against installed Pi", () => {
  const dirs: string[] = [];
  const children: PiRpcChild[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.closeGracefully();
      await child.waitForExit();
    }
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} fixture\n---\nbody\n`,
    );
  }

  function fixture() {
    const home = mkdtempSync(join(tmpdir(), "sandy-pi-sdk-"));
    dirs.push(home);
    const agentDir = join(home, ".pi", "agent");
    writeSkill(join(agentDir, "skills"), "native-on-fixture");
    writeSkill(join(agentDir, "skills"), "native-off-fixture");
    const pkg = join(home, "pi-package");
    writeSkill(join(pkg, "skills"), "package-on-fixture");
    writeSkill(join(pkg, "skills"), "package-off-fixture");
    const extensionSkills = join(home, "extension-skills");
    writeSkill(extensionSkills, "extension-off-fixture");
    const snapshotPath = join(home, "snapshot.json");
    mkdirSync(join(pkg, "extensions"), { recursive: true });
    writeFileSync(
      join(pkg, "extensions", "contribute-skill.ts"),
      `
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(extensionSkills)}] }));
        pi.registerCommand("fixture-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
        pi.registerCommand("fixture-snapshot", {
          handler: async (_args, ctx) => {
            writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({
              prompt: ctx.getSystemPrompt(), tools: pi.getAllTools().map(tool => tool.name).sort(),
              trusted: ctx.isProjectTrusted(), cwd: ctx.cwd,
              offline: process.env.PI_OFFLINE, skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,
            }));
          },
        });
      }
    `,
    );
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "sandy-skill-selection-fixture",
        keywords: ["pi-package"],
        pi: { skills: ["./skills"], extensions: ["./extensions"] },
      }),
    );
    const settings = { packages: [pkg] };
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
    const staged = join(home, "staged");
    writeSkill(staged, "injected-on-fixture");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      OPENAI_API_KEY: "sandy-offline-fixture-not-a-real-key",
      SANDY_PI_BRIDGE_COMMAND: realPiCommand,
    };
    return { home, agentDir, work, env, staged, snapshotPath, settings, pkg };
  }

  async function start(
    f: ReturnType<typeof fixture>,
    selection: SkillSelection,
    native = false,
    sessionPath?: string,
    extraArgs: string[] = [],
  ) {
    vi.stubEnv(
      "SANDY_PI_BRIDGE_COMMAND",
      f.env.SANDY_PI_BRIDGE_COMMAND ?? "pi",
    );
    vi.stubEnv("SANDY_PI_BRIDGE_ARGS", f.env.SANDY_PI_BRIDGE_ARGS);
    const args = [
      "--mode",
      "rpc",
      ...(sessionPath ? ["--session", sessionPath] : ["--no-session"]),
      "--session-dir",
      join(f.home, "sessions"),
      "--skill",
      f.staged,
      ...extraArgs,
    ];
    const launch = native
      ? null
      : preparePiSdkRpcLaunch({
          cwd: f.work,
          env: f.env,
          launchEnv: process.env,
          cliArgs: args,
          selection,
          scratchPrefix: join(f.home, "worker-" + Math.random()),
        });
    if (!native) expect(launch).not.toBeNull();
    const child = new PiRpcChild({
      cwd: f.work,
      env: launch?.env ?? f.env,
      args,
      ...(launch ? { launch } : {}),
      onEvent: () => undefined,
      onChannelMessage: () => undefined,
      onExit: () => undefined,
      recordThreadId: null,
    });
    children.push(child);
    await child.requestOk({ type: "get_state" });
    return child;
  }

  async function names(child: PiRpcChild) {
    const commands = commandsSchema.parse(
      await child.requestOk({ type: "get_commands" }),
    );
    return commands.commands
      .filter((command) => command.source === "skill")
      .map((command) => command.name)
      .filter((name) => name.endsWith("-fixture"))
      .sort();
  }

  async function snapshot(f: ReturnType<typeof fixture>, child: PiRpcChild) {
    const available = commandsSchema.parse(
      await child.requestOk({ type: "get_commands" }),
    );
    expect(
      available.commands.some((command) => command.name === "fixture-snapshot"),
    ).toBe(true);
    await child.requestOk({ type: "prompt", message: "/fixture-snapshot" });
    return snapshotSchema.parse(
      JSON.parse(readFileSync(f.snapshotPath, "utf8")),
    );
  }

  async function listedSkills(selection: SkillSelection) {
    return names(await start(fixture(), selection));
  }

  it("loads native, package, extension and injected fixtures under inherit", async () => {
    expect(await listedSkills({ mode: "inherit" })).toEqual([
      "skill:extension-off-fixture",
      "skill:injected-on-fixture",
      "skill:native-off-fixture",
      "skill:native-on-fixture",
      "skill:package-off-fixture",
      "skill:package-on-fixture",
    ]);
  }, 60_000);

  it("drops disabled native and package skills", async () => {
    const listed = await listedSkills({
      mode: "disable",
      names: ["native-off-fixture", "package-off-fixture"],
    });
    expect(listed).toContain("skill:native-on-fixture");
    expect(listed).toContain("skill:package-on-fixture");
    expect(listed).toContain("skill:injected-on-fixture");
    expect(listed).not.toContain("skill:native-off-fixture");
    expect(listed).not.toContain("skill:package-off-fixture");
  }, 60_000);

  it("starts only allowed native, package and injected skills under allow-only", async () => {
    const listed = await listedSkills({
      mode: "allow-only",
      names: ["native-on-fixture", "package-on-fixture", "injected-on-fixture"],
    });
    expect(listed).toContain("skill:injected-on-fixture");
    expect(listed).toContain("skill:native-on-fixture");
    expect(listed).toContain("skill:package-on-fixture");
    expect(listed).not.toContain("skill:native-off-fixture");
    expect(listed).not.toContain("skill:package-off-fixture");
  }, 60_000);

  it("hides a disabled skill an extension contributes through resources_discover", async () => {
    const listed = await listedSkills({
      mode: "disable",
      names: ["extension-off-fixture"],
    });
    expect(listed).not.toContain("skill:extension-off-fixture");
  }, 60_000);

  it("hides an unlisted extension skill under allow-only", async () => {
    const listed = await listedSkills({
      mode: "allow-only",
      names: ["native-on-fixture", "package-on-fixture", "injected-on-fixture"],
    });
    expect(listed).toEqual([
      "skill:injected-on-fixture",
      "skill:native-on-fixture",
      "skill:package-on-fixture",
    ]);
  }, 60_000);

  it("filters the effective prompt without changing ordinary Pi or inherit tools", async () => {
    const f = fixture();
    const filtered = await start(f, {
      mode: "disable",
      names: ["extension-off-fixture"],
    });
    const filteredSnapshot = await snapshot(f, filtered);
    expect(filteredSnapshot.prompt).not.toContain(
      "<name>extension-off-fixture</name>",
    );
    expect(filteredSnapshot.prompt).toContain("<name>native-on-fixture</name>");
    filtered.closeGracefully();
    await filtered.waitForExit();
    const native = await start(f, { mode: "inherit" }, true);
    const nativeNames = await names(native);
    const nativeSnapshot = await snapshot(f, native);
    expect(nativeNames).toContain("skill:extension-off-fixture");
    native.closeGracefully();
    await native.waitForExit();
    const inherited = await start(f, { mode: "inherit" });
    expect(await names(inherited)).toEqual(nativeNames);
    const inheritedSnapshot = await snapshot(f, inherited);
    expect(inheritedSnapshot).toEqual(nativeSnapshot);
    expect(filteredSnapshot.tools).toEqual(nativeSnapshot.tools);
  }, 60_000);

  it.each(["true", "yes"])(
    "matches native offline flags for PI_OFFLINE=%s",
    async (value) => {
      const f = fixture();
      f.env.PI_OFFLINE = value;
      delete f.env.PI_SKIP_VERSION_CHECK;
      const native = await start(f, { mode: "inherit" }, true);
      const nativeSnapshot = await snapshot(f, native);
      expect(nativeSnapshot.offline).toBe("1");
      expect(nativeSnapshot.skipVersionCheck).toBe("1");
      native.closeGracefully();
      await native.waitForExit();
      const worker = await start(f, { mode: "inherit" });
      expect(await snapshot(f, worker)).toEqual(nativeSnapshot);
    },
    60_000,
  );

  it("matches native migration of legacy command templates", async () => {
    for (const native of [true, false]) {
      const f = fixture();
      mkdirSync(join(f.agentDir, "commands"));
      writeFileSync(
        join(f.agentDir, "commands", "legacy-fixture.md"),
        "Local legacy prompt template",
      );
      const child = await start(f, { mode: "inherit" }, native);
      const listed = commandsSchema.parse(
        await child.requestOk({ type: "get_commands" }),
      );
      expect(
        listed.commands.map((command) => command.name),
        native ? "native" : "worker",
      ).toContain("legacy-fixture");
      expect(
        readFileSync(join(f.agentDir, "prompts", "legacy-fixture.md"), "utf8"),
      ).toBe("Local legacy prompt template");
      child.closeGracefully();
      await child.waitForExit();
    }
  }, 60_000);

  it("rejects a stored session whose working directory no longer exists like native RPC", async () => {
    const f = fixture();
    const sessionPath = join(f.home, "missing-cwd-session.jsonl");
    writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "cf3445c0-5308-44ad-a7a1-cc853793f393",
        timestamp: new Date().toISOString(),
        cwd: join(f.home, "removed-worktree"),
      }) + "\n",
    );
    for (const native of [true, false]) {
      await expect(
        start(f, { mode: "inherit" }, native, sessionPath),
      ).rejects.toThrow("Stored session working directory does not exist:");
      expect((await children[children.length - 1]!.waitForExit()).code).toBe(1);
    }
  }, 60_000);

  it.each([
    { args: ["-not-an-option"], error: "Unknown option: -not-an-option" },
    {
      args: ["--fork", "fixture"],
      error: "--fork cannot be combined with --no-session",
    },
    { args: ["--provider", "fixture"], error: "--provider requires --model" },
  ])(
    "rejects invalid RPC launch arguments $args like native Pi",
    async ({ args, error }) => {
      const f = fixture();
      for (const native of [true, false]) {
        await expect(
          start(f, { mode: "inherit" }, native, undefined, args),
        ).rejects.toThrow(error);
        expect((await children[children.length - 1]!.waitForExit()).code).toBe(
          1,
        );
      }
    },
    60_000,
  );

  it("keeps configured Pi CLI arguments in the SDK worker", async () => {
    const f = fixture();
    mkdirSync(join(f.agentDir, "prompts"));
    writeFileSync(
      join(f.agentDir, "prompts", "configured-fixture.md"),
      "Local prompt template",
    );
    const nativeWithPrompts = await start(f, { mode: "inherit" }, true);
    expect(
      commandsSchema
        .parse(await nativeWithPrompts.requestOk({ type: "get_commands" }))
        .commands.map((command) => command.name),
    ).toContain("configured-fixture");
    nativeWithPrompts.closeGracefully();
    await nativeWithPrompts.waitForExit();
    const packageDir = locatePiPackageDir(f.env, f.work);
    const manifest = z
      .object({ bin: z.object({ pi: z.string() }) })
      .parse(
        JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")),
      );
    f.env.SANDY_PI_BRIDGE_COMMAND = process.execPath;
    f.env.SANDY_PI_BRIDGE_ARGS = JSON.stringify([
      join(packageDir, manifest.bin.pi),
      "--no-prompt-templates",
    ]);
    for (const native of [true, false]) {
      const child = await start(f, { mode: "inherit" }, native);
      expect(
        commandsSchema
          .parse(await child.requestOk({ type: "get_commands" }))
          .commands.map((command) => command.name),
      ).not.toContain("configured-fixture");
      child.closeGracefully();
      await child.waitForExit();
    }
  }, 60_000);

  it("keeps its captured selection after extension reload and session/cwd replacement", async () => {
    const f = fixture();
    writeFileSync(
      join(f.agentDir, "settings.json"),
      JSON.stringify({ ...f.settings, defaultProjectTrust: "always" }),
    );
    const selection: SkillSelection = {
      mode: "disable",
      names: ["extension-off-fixture", "project-off-fixture"],
    };
    const child = await start(f, selection);
    selection.names.push("native-on-fixture");
    const before = await names(child);
    expect(before).toContain("skill:native-on-fixture");
    expect(before).not.toContain("skill:extension-off-fixture");
    const available = commandsSchema.parse(
      await child.requestOk({ type: "get_commands" }),
    );
    expect(
      available.commands.some((command) => command.name === "fixture-reload"),
    ).toBe(true);
    await child.requestOk({ type: "prompt", message: "/fixture-reload" });
    expect(await names(child)).toEqual(before);
    const otherCwd = join(f.home, "other-work");
    writeSkill(join(otherCwd, ".pi", "skills"), "project-on-fixture");
    writeSkill(join(otherCwd, ".pi", "skills"), "project-off-fixture");
    const sessionPath = join(f.home, "other-session.jsonl");
    writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "cf3445c0-5308-44ad-a7a1-cc853793f393",
        timestamp: new Date().toISOString(),
        cwd: otherCwd,
      }) + "\n",
    );
    await child.requestOk({ type: "switch_session", sessionPath });
    const switched = await names(child);
    expect(switched).toContain("skill:project-on-fixture");
    expect(switched).toContain("skill:native-on-fixture");
    expect(switched).not.toContain("skill:project-off-fixture");
    expect(switched).not.toContain("skill:extension-off-fixture");
    expect((await snapshot(f, child)).cwd).toBe(otherCwd);
    expect((await snapshot(f, child)).prompt).not.toContain(
      "<name>extension-off-fixture</name>",
    );
    await child.requestOk({ type: "new_session" });
    expect(await names(child)).toEqual(switched);
  }, 60_000);

  it.each([true, false])(
    "matches saved project trust %s",
    async (trusted) => {
      const f = fixture();
      writeSkill(join(f.work, ".pi", "skills"), "project-on-fixture");
      writeFileSync(
        join(f.agentDir, "trust.json"),
        JSON.stringify({ [f.work]: trusted }),
      );
      const native = await start(f, { mode: "inherit" }, true);
      const listed = await names(native);
      expect(listed.includes("skill:project-on-fixture")).toBe(trusted);
      native.closeGracefully();
      await native.waitForExit();
      const worker = await start(f, {
        mode: "disable",
        names: ["extension-off-fixture"],
      });
      expect((await names(worker)).includes("skill:project-on-fixture")).toBe(
        trusted,
      );
    },
    60_000,
  );

  it("starts the production Sandy session and removes worker scratch files on exit", async () => {
    const f = fixture();
    vi.stubEnv("SANDY_PI_BRIDGE_COMMAND", realPiCommand ?? "pi");
    const extensionPath = join(f.home, "sandy-extension.ts");
    writeFileSync(extensionPath, SANDY_PI_EXTENSION_SOURCE);
    const scratchDir = join(f.home, "scratch");
    mkdirSync(scratchDir);
    const session = new PiRpcSession(
      {
        cwd: f.work,
        skillSelection: { mode: "disable", names: ["extension-off-fixture"] },
        sessionFilePath: join(f.home, "session.jsonl"),
        sessionDir: join(f.home, "sessions"),
        scratchDir,
        extensionPath,
        recordThreadId: "thr_sdk_fixture",
        shellEnvOverrides: Object.fromEntries(
          Object.entries(f.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
      async () => ({ content: "", isError: true }),
      () => undefined,
      () => undefined,
    );
    try {
      await session.start();
      expect((await session.getState()).model?.provider).not.toBe("unknown");
      expect(
        readdirSync(scratchDir).some((name) => name.endsWith(".sdk.mjs")),
      ).toBe(true);
    } finally {
      await session.closeGracefully(5000);
    }
    await vi.waitFor(() => expect(readdirSync(scratchDir)).toEqual([]));
  }, 60_000);

  it.each([
    { decision: "yes", defaultProjectTrust: "ask", expected: true },
    { decision: "no", defaultProjectTrust: "always", expected: false },
    { decision: "undecided", defaultProjectTrust: "always", expected: true },
    { decision: "undecided", defaultProjectTrust: "ask", expected: false },
  ])(
    "matches native dynamic trust: $decision with $defaultProjectTrust",
    async ({ decision, defaultProjectTrust, expected }) => {
      const f = fixture();
      writeSkill(join(f.work, ".pi", "skills"), "project-on-fixture");
      writeSkill(join(f.work, ".agents", "skills"), "project-off-fixture");
      mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
      writeFileSync(
        join(f.agentDir, "extensions", "trust.ts"),
        `export default pi => pi.on("project_trust", () => ({ trusted: "${decision}" }));`,
      );
      writeFileSync(
        join(f.agentDir, "settings.json"),
        JSON.stringify({ ...f.settings, defaultProjectTrust }),
      );
      const native = await start(f, { mode: "inherit" }, true);
      const nativeNames = await names(native);
      expect(nativeNames.includes("skill:project-on-fixture")).toBe(expected);
      native.closeGracefully();
      await native.waitForExit();
      const selected = await start(f, {
        mode: "disable",
        names: ["project-off-fixture"],
      });
      expect((await names(selected)).includes("skill:project-on-fixture")).toBe(
        expected,
      );
      expect(await names(selected)).not.toContain("skill:project-off-fixture");
      expect((await snapshot(f, selected)).trusted).toBe(expected);
    },
    60_000,
  );
});
