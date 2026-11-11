import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  codexSkillConfigArgs,
  codexSkillConfigEntries,
  type CodexListedSkill,
} from "./skill-selection.js";

const listed: CodexListedSkill[] = [
  { name: "alpha", path: "/skills/alpha/SKILL.md", enabled: true },
  { name: "beta", path: "/skills/beta/SKILL.md", enabled: true },
  { name: "alpha", path: "/project/alpha/SKILL.md", enabled: true },
  { name: "gamma", path: "/skills/gamma/SKILL.md", enabled: false },
];

describe("codexSkillConfigEntries", () => {
  it("adds nothing under inherit", () => {
    expect(codexSkillConfigEntries({ mode: "inherit" }, listed)).toEqual([]);
  });

  it("disables by name without a listing", () => {
    expect(
      codexSkillConfigEntries({ mode: "disable", names: ["alpha"] }, null),
    ).toEqual([{ name: "alpha", enabled: false }]);
  });

  it("disables every same-named copy and every non-allowed skill under allow-only", () => {
    expect(
      codexSkillConfigEntries({ mode: "allow-only", names: ["beta"] }, listed),
    ).toEqual([
      { path: "/skills/alpha/SKILL.md", enabled: false },
      { path: "/project/alpha/SKILL.md", enabled: false },
      { path: "/skills/gamma/SKILL.md", enabled: false },
    ]);
  });

  it("keeps a skill the user disabled off even when allow-only names it", () => {
    expect(
      codexSkillConfigEntries({ mode: "allow-only", names: ["gamma"] }, listed),
    ).toContainEqual({ path: "/skills/gamma/SKILL.md", enabled: false });
  });

  it("cannot build an allow-only filter without a listing", () => {
    expect(
      codexSkillConfigEntries({ mode: "allow-only", names: ["beta"] }, null),
    ).toBeNull();
  });
});

describe("codexSkillConfigArgs", () => {
  it("emits no override when nothing is disabled", () => {
    expect(codexSkillConfigArgs([])).toEqual([]);
  });

  it("quotes names and paths as TOML strings and drops duplicates", () => {
    expect(
      codexSkillConfigArgs([
        { name: 'we"ird', enabled: false },
        { name: 'we"ird', enabled: false },
        { path: "/a b/SKILL.md", enabled: false },
      ]),
    ).toEqual([
      "-c",
      'skills.config=[{name="we\\"ird",enabled=false},{path="/a b/SKILL.md",enabled=false}]',
    ]);
  });
});

describe.skipIf(process.env.SANDY_TEST_REAL_CODEX !== "1")(
  "Codex app-server honours the generated skills.config",
  () => {
    const dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function fixtureHome(): string {
      const home = mkdtempSync(join(tmpdir(), "sandy-codex-skill-selection-"));
      dirs.push(home);
      for (const name of ["enabled-fixture", "disabled-fixture"]) {
        const dir = join(home, "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: probe fixture ${name}\n---\nbody\n`,
        );
      }
      return home;
    }

    async function listFixtures(
      home: string,
      configArgs: readonly string[],
    ): Promise<CodexListedSkill[]> {
      const child = spawn(
        process.env.SANDY_TEST_CODEX_COMMAND ?? "codex",
        [...configArgs, "app-server"],
        { cwd: home, env: { ...process.env, CODEX_HOME: home } },
      );
      const lines = createInterface({ input: child.stdout });
      const responses = new Map<number, (value: unknown) => void>();
      lines.on("line", (line) => {
        const message = z
          .object({ id: z.number().optional(), result: z.unknown().optional() })
          .safeParse(JSON.parse(line));
        if (message.success && message.data.id !== undefined) {
          responses.get(message.data.id)?.(message.data.result);
        }
      });
      const request = (id: number, method: string, params: unknown) =>
        new Promise<unknown>((resolve) => {
          responses.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      try {
        await request(1, "initialize", {
          clientInfo: { name: "sandy-skill-selection-test", version: "0.0.0" },
          capabilities: {},
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        const result = z
          .object({
            data: z.array(
              z.object({
                skills: z.array(
                  z.object({ name: z.string(), path: z.string(), enabled: z.boolean() }),
                ),
              }),
            ),
          })
          .parse(await request(2, "skills/list", { cwds: [home], forceReload: true }));
        return result.data
          .flatMap((entry) => entry.skills)
          .filter((skill) => skill.name.endsWith("-fixture"))
          .sort((a, b) => a.name.localeCompare(b.name));
      } finally {
        child.kill();
      }
    }

    it("disables by name", async () => {
      const home = fixtureHome();
      const skills = await listFixtures(
        home,
        codexSkillConfigArgs(
          codexSkillConfigEntries({ mode: "disable", names: ["disabled-fixture"] }, null) ?? [],
        ),
      );
      expect(skills.map((skill) => [skill.name, skill.enabled])).toEqual([
        ["disabled-fixture", false],
        ["enabled-fixture", true],
      ]);
    }, 60_000);

    it("disables everything outside allow-only by path", async () => {
      const home = fixtureHome();
      const unfiltered = await listFixtures(home, []);
      const skills = await listFixtures(
        home,
        codexSkillConfigArgs(
          codexSkillConfigEntries(
            { mode: "allow-only", names: ["enabled-fixture"] },
            unfiltered,
          ) ?? [],
        ),
      );
      expect(skills.map((skill) => [skill.name, skill.enabled])).toEqual([
        ["disabled-fixture", false],
        ["enabled-fixture", true],
      ]);
    }, 60_000);
  },
);
