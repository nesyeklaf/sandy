import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiSessionSkills } from "../pi-package-skills.js";
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
      env: {},
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
      env: {},
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
      env: {},
      injectedSkillPaths: [],
      selection: { mode: "allow-only", names: ["alpha"] },
      resolveSessionSkills: async () => nativeSkills,
    });
    expect(launch).toEqual({
      noSkills: true,
      skillPaths: ["/home/u/.pi/agent/skills/alpha/SKILL.md"],
    });
  });

  it("fails closed to the server-filtered Sandy skills when Pi resolution fails", async () => {
    const errors: unknown[] = [];
    const launch = await resolvePiSkillLaunch({
      cwd: "/work",
      env: {},
      injectedSkillPaths: ["/staged"],
      selection: { mode: "disable", names: ["beta"] },
      resolveSessionSkills: async () => {
        throw new Error("pi missing");
      },
      onResolveError: (error) => errors.push(error),
    });
    expect(launch).toEqual({ noSkills: true, skillPaths: ["/staged"] });
    expect(errors).toHaveLength(1);
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
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
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
});
