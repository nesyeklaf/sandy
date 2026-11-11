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
import {
  CLAUDE_SKILL_PLUGIN_NAME,
  ensureClaudeSkillPlugin,
  filterClaudeSkillRoots,
  scanClaudeNativeSkills,
} from "../skill-plugins.js";

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
    },
    {},
  );
}

describe("buildClaudeSkillFilter", () => {
  it("leaves Claude's discovery alone under inherit", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "inherit" },
        nativeSkillNames: ["alpha"],
      }),
    );
    expect(options.settings).not.toHaveProperty("skillOverrides");
    expect(options).not.toHaveProperty("skills");
  });

  it("turns each disabled name off through settings.skillOverrides", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "disable", names: ["alpha", "beta"] },
        nativeSkillNames: [],
      }),
    );
    expect(options.settings).toMatchObject({
      skillOverrides: { alpha: "off", beta: "off" },
    });
  });

  it("turns off every native skill outside an allow-only list", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "allow-only", names: ["alpha"] },
        nativeSkillNames: ["alpha", "beta", "gamma", "beta"],
      }),
    );
    expect(options.settings).toMatchObject({
      skillOverrides: { beta: "off", gamma: "off" },
    });
    expect(options.settings).not.toHaveProperty("skillOverrides.alpha");
    expect(options).not.toHaveProperty("skills");
    expect(options.allowedTools ?? []).not.toContain("Skill(alpha)");
  });

  it("turns off every native skill when allow-only names nothing", () => {
    const options = sdkOptionsFor(
      buildClaudeSkillFilter({
        selection: { mode: "allow-only", names: [] },
        nativeSkillNames: ["alpha"],
      }),
    );
    expect(options.settings).toMatchObject({ skillOverrides: { alpha: "off" } });
  });
});

describe.skipIf(process.env.SANDY_TEST_REAL_CLAUDE !== "1")(
  "Claude SDK honours the bridge's skill filter",
  () => {
    const dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function writeSkill(root: string, name: string): void {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: probe fixture ${name}\n---\nbody\n`,
      );
    }

    function fixture() {
      const root = mkdtempSync(join(tmpdir(), "sandy-claude-skill-selection-"));
      dirs.push(root);
      const configDir = join(root, "claude");
      writeSkill(join(configDir, "skills"), "native-on-fixture");
      writeSkill(join(configDir, "skills"), "native-off-fixture");
      const injectedRoot = join(root, "injected");
      writeSkill(injectedRoot, "injected-on-fixture");
      writeSkill(injectedRoot, "injected-off-fixture");
      const pluginsRoot = join(root, "plugins");
      mkdirSync(pluginsRoot, { recursive: true });
      const cwd = join(root, "cwd");
      mkdirSync(join(cwd, ".git"), { recursive: true });
      return { configDir, cwd, injectedRoot, pluginsRoot };
    }

    async function listedFixtures(
      selection: Parameters<typeof buildClaudeSkillFilter>[0]["selection"],
    ): Promise<string[]> {
      const { configDir, cwd, injectedRoot, pluginsRoot } = fixture();
      const native = await scanClaudeNativeSkills({ cwd, claudeDir: configDir });
      const [root] = await filterClaudeSkillRoots({
        roots: [{ id: "sandy-test", path: injectedRoot }],
        native,
        pluginsRoot,
        selection,
      });
      const plugins = root
        ? [{ type: "local" as const, path: ensureClaudeSkillPlugin({ pluginsRoot, root }) }]
        : [];
      const options = sdkOptionsFor(
        buildClaudeSkillFilter({
          selection,
          nativeSkillNames: native.map((skill) => skill.name),
        }),
      );
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
          plugins,
          env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
          ...(options.settings ? { settings: options.settings } : {}),
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

    const bare = (name: string) => name.slice(name.lastIndexOf(":") + 1);

    it("lists native and injected fixtures under inherit", async () => {
      const listed = await listedFixtures({ mode: "inherit" });
      expect(listed.map(bare).sort()).toEqual([
        "injected-off-fixture",
        "injected-on-fixture",
        "native-off-fixture",
        "native-on-fixture",
      ]);
      expect(listed).toContain(
        `${CLAUDE_SKILL_PLUGIN_NAME}:injected-on-fixture`,
      );
    }, 90_000);

    it("hides disabled native and injected skills", async () => {
      const listed = await listedFixtures({
        mode: "disable",
        names: ["native-off-fixture", "injected-off-fixture"],
      });
      expect(listed.map(bare).sort()).toEqual([
        "injected-on-fixture",
        "native-on-fixture",
      ]);
    }, 90_000);

    it("lists only allowed native and injected skills under allow-only", async () => {
      const listed = await listedFixtures({
        mode: "allow-only",
        names: ["native-on-fixture", "injected-on-fixture"],
      });
      expect(listed.map(bare).sort()).toEqual([
        "injected-on-fixture",
        "native-on-fixture",
      ]);
    }, 90_000);

    it("lists no fixture when allow-only names only an absent skill", async () => {
      expect(
        await listedFixtures({ mode: "allow-only", names: ["absent-skill"] }),
      ).toEqual([]);
    }, 90_000);

    it("lists no fixture when allow-only names nothing", async () => {
      expect(await listedFixtures({ mode: "allow-only", names: [] })).toEqual([]);
    }, 90_000);
  },
);
