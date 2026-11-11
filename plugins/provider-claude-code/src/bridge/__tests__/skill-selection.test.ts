import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimePermissionPolicy } from "@sandy-sdk/plugin-sdk/provider-bridge";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeSessionParams } from "../../session-params.js";
import { claudeThreadStartParamsSchema } from "../commands.js";
import { buildSessionOptions } from "../session-options.js";
import { buildClaudeSkillFilter } from "../skill-selection.js";

const executionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} satisfies RuntimePermissionPolicy;

function sdkOptionsFor(filter: ReturnType<typeof buildClaudeSkillFilter>) {
  const params = claudeThreadStartParamsSchema.parse(
    buildClaudeSessionParams({
      threadId: "thread-1",
      cwd: "/tmp/worktree",
      options: executionOptions,
      instructionMode: "append",
      skillFilter: filter,
    }),
  );
  return buildSessionOptions(
    {
      cwd: params.cwd,
      instructionMode: params.instructionMode,
      permissionMode: params.permissionMode,
      permissionScope: params.permissionScope,
      serviceTier: params.serviceTier,
      workflowsEnabled: params.workflowsEnabled,
      chromeEnabled: params.chromeEnabled,
      disable1MContext: params.disable1MContext,
      artifactsEnabled: params.artifactsEnabled,
      sandboxEnabled: params.sandboxEnabled,
      ...(params.skillOverrides ? { skillOverrides: params.skillOverrides } : {}),
      ...(params.skills ? { skills: params.skills } : {}),
    },
    {},
  );
}

describe("buildClaudeSkillFilter", () => {
  it("leaves Claude's discovery alone under inherit", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "inherit" },
        injectedPluginNames: ["sandy-global-skills"],
      }),
    );
    expect(options.skills).toBeUndefined();
    expect(options.settings).not.toHaveProperty("skillOverrides");
  });

  it("turns each disabled name off through settings.skillOverrides", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "disable", names: ["alpha", "beta"] },
        injectedPluginNames: [],
      }),
    );
    expect(options.settings).toMatchObject({
      skillOverrides: { alpha: "off", beta: "off" },
    });
    expect(options.skills).toBeUndefined();
  });

  it("enables only the allowed names, bare and qualified by each injected plugin", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "allow-only", names: ["alpha"] },
        injectedPluginNames: ["sandy-global-skills", "sandy-global-skills-0a1b2c3d"],
      }),
    );
    expect(options.skills).toEqual([
      "alpha",
      "sandy-global-skills:alpha",
      "sandy-global-skills-0a1b2c3d:alpha",
    ]);
  });

  it("enables no skill when allow-only names nothing", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "allow-only", names: [] },
        injectedPluginNames: ["sandy-global-skills"],
      }),
    );
    expect(options.skills).toEqual([]);
  });
});

describe.skipIf(process.env.SANDY_TEST_REAL_CLAUDE !== "1")(
  "Claude SDK honours the bridge's skill filter",
  () => {
    const dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function fixtureConfigDir(): { configDir: string; cwd: string } {
      const root = mkdtempSync(join(tmpdir(), "sandy-claude-skill-selection-"));
      dirs.push(root);
      const configDir = join(root, "claude");
      for (const name of ["enabled-fixture", "disabled-fixture"]) {
        const dir = join(configDir, "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: probe fixture ${name}\n---\nbody\n`,
        );
      }
      const cwd = join(root, "cwd");
      mkdirSync(cwd, { recursive: true });
      return { configDir, cwd };
    }

    async function listedFixtures(
      filter: ReturnType<typeof buildClaudeSkillFilter>,
    ): Promise<string[]> {
      const { configDir, cwd } = fixtureConfigDir();
      const options = sdkOptionsFor(filter);
      async function* idle(): AsyncGenerator<never> {
        await new Promise(() => undefined);
      }
      const q = query({
        prompt: idle(),
        options: {
          cwd,
          settingSources: ["user"],
          persistSession: false,
          maxTurns: 1,
          env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
          ...(options.settings ? { settings: options.settings } : {}),
          ...(options.skills ? { skills: options.skills } : {}),
        },
      });
      try {
        const commands = await q.supportedCommands();
        return commands
          .map((command) => command.name)
          .filter((name) => name.endsWith("-fixture"))
          .sort();
      } finally {
        q.close();
      }
    }

    it("hides a disabled skill from the session", async () => {
      expect(
        await listedFixtures(
          buildClaudeSkillFilter({
            selection: { mode: "disable", names: ["disabled-fixture"] },
            injectedPluginNames: [],
          }),
        ),
      ).toEqual(["enabled-fixture"]);
    }, 90_000);

    it("lists only allowed skills under allow-only", async () => {
      expect(
        await listedFixtures(
          buildClaudeSkillFilter({
            selection: { mode: "allow-only", names: ["enabled-fixture"] },
            injectedPluginNames: [],
          }),
        ),
      ).toEqual(["enabled-fixture"]);
    }, 90_000);
  },
);
