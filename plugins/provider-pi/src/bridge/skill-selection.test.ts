import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePiSessionSkills } from "../pi-package-skills.js";
import { resolvePiLaunch } from "./rpc-child.js";
import { resolvePiSkillLaunch } from "./skill-selection.js";

const nativeSkills = [
  { name: "sandy-injected", filePath: "/staged/sandy-injected/SKILL.md" },
  { name: "alpha", filePath: "/home/u/.pi/agent/skills/alpha/SKILL.md" },
  { name: "beta", filePath: "/home/u/.agents/skills/beta/SKILL.md" },
];

describe("resolvePiSkillLaunch", () => {
  it("keeps Pi's own discovery untouched under inherit", async () => {
    const launch = await resolvePiSkillLaunch({
      cwd: "/work",
      shellEnvOverrides: {},
      injectedSkillPaths: ["/staged"],
      selection: { mode: "inherit" },
      resolveSessionSkills: () => {
        throw new Error("inherit must not resolve");
      },
    });
    expect(launch).toEqual({ noSkills: false, skillPaths: ["/staged"] });
  });

  it("drops disabled names and lists every remaining skill file explicitly", async () => {
    const launch = await resolvePiSkillLaunch({
      cwd: "/work",
      shellEnvOverrides: {},
      injectedSkillPaths: ["/staged"],
      selection: { mode: "disable", names: ["beta"] },
      resolveSessionSkills: async (args) => {
        expect(args.extraSkillPaths).toEqual(["/staged"]);
        return nativeSkills;
      },
    });
    expect(launch).toEqual({
      noSkills: true,
      skillPaths: [
        "/staged/sandy-injected/SKILL.md",
        "/home/u/.pi/agent/skills/alpha/SKILL.md",
      ],
    });
  });

  it("starts only allowed names under allow-only", async () => {
    const launch = await resolvePiSkillLaunch({
      cwd: "/work",
      shellEnvOverrides: {},
      injectedSkillPaths: [],
      selection: { mode: "allow-only", names: ["alpha"] },
      resolveSessionSkills: async () => nativeSkills,
    });
    expect(launch).toEqual({
      noSkills: true,
      skillPaths: ["/home/u/.pi/agent/skills/alpha/SKILL.md"],
    });
  });

  it("discovers skills in the thread's environment, not the bridge's", async () => {
    vi.stubEnv("HOME", "/fixture/host");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fixture/host-agent");
    vi.stubEnv("SANDY_PI_BRIDGE_COMMAND", "/fixture/bin/pi");
    const seen: Parameters<typeof resolvePiSessionSkills>[0][] = [];
    try {
      await resolvePiSkillLaunch({
        cwd: "/work",
        shellEnvOverrides: {
          HOME: "/fixture/thread",
          PI_CODING_AGENT_DIR: "/fixture/thread-agent",
        },
        injectedSkillPaths: [],
        selection: { mode: "disable", names: ["beta"] },
        resolveSessionSkills: async (args) => {
          seen.push({ ...args, launchEnv: { ...args.launchEnv } });
          return nativeSkills;
        },
      });
      await resolvePiSkillLaunch({
        cwd: "/work",
        shellEnvOverrides: { HOME: "/fixture/thread", PI_CODING_AGENT_DIR: "" },
        injectedSkillPaths: [],
        selection: { mode: "allow-only", names: [] },
        resolveSessionSkills: async (args) => {
          seen.push({ ...args, launchEnv: { ...args.launchEnv } });
          return nativeSkills;
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(seen.map((args) => args.agentDir)).toEqual([
      "/fixture/thread-agent",
      "/fixture/thread/.pi/agent",
    ]);
    expect(seen.map((args) => args.env.HOME)).toEqual([
      "/fixture/thread",
      "/fixture/thread",
    ]);
    expect(seen.map((args) => args.launchEnv.SANDY_PI_BRIDGE_COMMAND)).toEqual([
      "/fixture/bin/pi",
      "/fixture/bin/pi",
    ]);
  });

  it.each([
    { mode: "disable" as const, names: ["unrelated"] },
    { mode: "allow-only" as const, names: ["alpha"] },
  ])("refuses to start when Pi resolution fails under $mode", async (selection) => {
    await expect(
      resolvePiSkillLaunch({
        cwd: "/work",
        shellEnvOverrides: {},
        injectedSkillPaths: ["/staged"],
        selection,
        resolveSessionSkills: async () => {
          throw new Error("pi missing");
        },
      }),
    ).rejects.toThrow(/could not list Pi skills.*session was not started: pi missing/);
  });

  it("starts without resolving Pi skills under inherit", async () => {
    const launch = await resolvePiSkillLaunch({
      cwd: "/work",
      shellEnvOverrides: {},
      injectedSkillPaths: ["/staged"],
      selection: { mode: "inherit" },
      resolveSessionSkills: async () => {
        throw new Error("pi missing");
      },
    });
    expect(launch).toEqual({ noSkills: false, skillPaths: ["/staged"] });
  });
});

const realPiCommand = process.env.SANDY_TEST_REAL_PI_COMMAND;

describe.skipIf(!realPiCommand)("resolvePiSessionSkills against installed Pi", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, `---\nname: ${name}\ndescription: The ${name} fixture\n---\nbody\n`);
    return file;
  }

  it("returns Pi's native skills with injected paths first", async () => {
    const home = mkdtempSync(join(tmpdir(), "sandy-pi-skill-selection-"));
    dirs.push(home);
    const agentDir = join(home, ".pi", "agent");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const nativeFile = writeSkill(join(agentDir, "skills"), "native-fixture");
    const staged = join(home, "staged");
    const injectedFile = writeSkill(staged, "injected-fixture");
    const skills = await resolvePiSessionSkills({
      cwd: work,
      agentDir,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
      launchEnv: {
        ...process.env,
        SANDY_PI_BRIDGE_COMMAND: realPiCommand ?? "pi",
      },
      extraSkillPaths: [staged],
    });
    expect(skills.map((skill) => skill.name)).toEqual([
      "injected-fixture",
      "native-fixture",
    ]);
    expect(skills.map((skill) => skill.filePath)).toEqual([
      injectedFile,
      nativeFile,
    ]);
  });

  async function projectSkillNames(globalSettings: Record<string, unknown>): Promise<string[]> {
    const home = mkdtempSync(join(tmpdir(), "sandy-pi-project-trust-"));
    dirs.push(home);
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
    const work = join(home, "work");
    writeSkill(join(work, ".pi", "skills"), "project-pi-fixture");
    writeSkill(join(work, ".agents", "skills"), "project-agents-fixture");
    const skills = await resolvePiSessionSkills({
      cwd: work,
      agentDir,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
      launchEnv: { ...process.env, SANDY_PI_BRIDGE_COMMAND: realPiCommand ?? "pi" },
      extraSkillPaths: [],
    });
    return skills.map((skill) => skill.name).sort();
  }

  it("loads project skills when Pi trusts projects by default", async () => {
    expect(await projectSkillNames({ defaultProjectTrust: "always" })).toEqual([
      "project-agents-fixture",
      "project-pi-fixture",
    ]);
  });

  it("skips project skills when Pi would ask and nothing decided trust", async () => {
    expect(await projectSkillNames({})).toEqual([]);
  });
});

describe.skipIf(!realPiCommand)("Pi session started with the bridge's skill launch", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    const home = mkdtempSync(join(tmpdir(), "sandy-pi-skill-launch-"));
    dirs.push(home);
    const agentDir = join(home, ".pi", "agent");
    writeSkill(join(agentDir, "skills"), "native-on-fixture");
    writeSkill(join(agentDir, "skills"), "native-off-fixture");
    const pkg = join(home, "pi-package");
    writeSkill(join(pkg, "skills"), "package-on-fixture");
    writeSkill(join(pkg, "skills"), "package-off-fixture");
    const extensionSkills = join(home, "extension-skills");
    writeSkill(extensionSkills, "extension-off-fixture");
    mkdirSync(join(pkg, "extensions"), { recursive: true });
    writeFileSync(
      join(pkg, "extensions", "contribute-skill.ts"),
      `export default function (pi) {\n  pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(extensionSkills)}] }));\n}\n`,
    );
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "sandy-skill-selection-fixture",
        keywords: ["pi-package"],
        pi: { skills: ["./skills"], extensions: ["./extensions"] },
      }),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [pkg] }),
    );
    const staged = join(home, "staged");
    writeSkill(staged, "injected-on-fixture");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      SANDY_PI_BRIDGE_COMMAND: realPiCommand ?? "pi",
    };
    return { home, work, env, staged };
  }

  async function listedSkills(
    selection: Parameters<typeof resolvePiSkillLaunch>[0]["selection"],
  ): Promise<string[]> {
    const { home, work, env, staged } = fixture();
    vi.stubEnv("SANDY_PI_BRIDGE_COMMAND", realPiCommand ?? "pi");
    const launch = await resolvePiSkillLaunch({
      cwd: work,
      shellEnvOverrides: { HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
      injectedSkillPaths: [staged],
      selection,
    });
    const pi = resolvePiLaunch(env);
    const args = [
      ...pi.args,
      "--mode",
      "rpc",
      "--no-session",
      "--session-dir",
      join(home, "sessions"),
      ...(launch.noSkills ? ["--no-skills"] : []),
      ...launch.skillPaths.flatMap((skillPath) => ["--skill", skillPath]),
    ];
    const child = spawn(pi.command, args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    try {
      const commands = await new Promise<Array<{ name: string; source: string }>>(
        (resolve, reject) => {
          let buffer = "";
          child.on("exit", (code) =>
            reject(new Error(`pi exited ${code} before get_commands: ${stderr}`)),
          );
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
              if (!line.startsWith("{")) continue;
              const message = JSON.parse(line) as {
                type?: string;
                command?: string;
                data?: { commands?: Array<{ name: string; source: string }> };
              };
              if (message.type === "response" && message.command === "get_commands") {
                resolve(message.data?.commands ?? []);
              }
            }
          });
          child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
        },
      );
      return commands
        .filter((command) => command.source === "skill")
        .map((command) => command.name)
        .filter((name) => name.endsWith("-fixture"))
        .sort();
    } finally {
      child.kill();
    }
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

  it.fails("known gap: hides a disabled skill an extension contributes through resources_discover", async () => {
    const listed = await listedSkills({
      mode: "disable",
      names: ["extension-off-fixture"],
    });
    expect(listed).not.toContain("skill:extension-off-fixture");
  }, 60_000);

  it.fails("known gap: hides an unlisted extension skill under allow-only", async () => {
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
});
