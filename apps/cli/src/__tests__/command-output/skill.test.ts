import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { defaultAppSettings } from "@sandy/domain";
import { registerSkillCommands } from "../../commands/skill.js";

describe("sandy skill commands", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerSkillCommands(
      program,
      () => "http://server",
      () => ({ projectId: "project-context", serverUrl: "http://server" }),
    );

  it("lists installed skills through the public SDK", async () => {
    const get = vi.fn(async () => ({
      skills: [
        {
          id: `skill_${"a".repeat(64)}`,
          name: "review",
          description: "Review the current diff",
          provider: "codex",
          scope: "codex-user",
          filePath: "/home/user/.agents/skills/review/SKILL.md",
          manageable: true,
          writable: true,
          providers: ["codex"],
          duplicates: [],
        },
      ],
    }));
    stubServerApi({ "v1.projects.:id.skills.$get": get });

    await runCommand(["skill", "list"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "project-context" },
      query: { environmentId: "" },
    });
    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
      "review",
    );
  });

  it("reports a stale skill revision instead of overwriting the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandy-cli-skill-"));
    try {
      const file = join(dir, "SKILL.md");
      await writeFile(file, "---\nname: review\n---\nEdited\n");
      const patch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "conflict",
              message: "Skill changed before it was saved",
              details: { currentRevision: "d".repeat(64) },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      );
      stubServerApi({ "v1.projects.:id.skills.content.$patch": patch });

      await expect(
        runCommand(
          [
            "skill",
            "update",
            `skill_${"a".repeat(64)}`,
            "--file",
            file,
            "--revision",
            "b".repeat(64),
          ],
          register,
        ),
      ).rejects.toThrow("process.exit:1");

      expect(patch).toHaveBeenCalledWith({
        param: { id: "project-context" },
        json: {
          skillId: `skill_${"a".repeat(64)}`,
          environmentId: null,
          path: "SKILL.md",
          content: "---\nname: review\n---\nEdited\n",
          revision: "b".repeat(64),
        },
      });
      expect(
        collectLogLines(vi.mocked(console.error)).join("\n"),
      ).toContain(`now ${"d".repeat(64)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a new file in a skill folder with --new and refuses an existing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandy-cli-skill-"));
    try {
      const file = join(dir, "check.sh");
      await writeFile(file, "echo ok\n");
      const patch = vi
        .fn()
        .mockResolvedValueOnce({
          filePath: "/home/me/.agents/skills/review/scripts/check.sh",
          revision: "c".repeat(64),
        })
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: "conflict",
              message: "Skill changed before it was saved",
              details: { currentRevision: "d".repeat(64) },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        );
      stubServerApi({ "v1.projects.:id.skills.content.$patch": patch });
      const args = [
        "skill",
        "update",
        `skill_${"a".repeat(64)}`,
        "--file",
        file,
        "--path",
        "scripts/check.sh",
        "--new",
      ];

      await runCommand(args, register);
      expect(patch).toHaveBeenCalledWith({
        param: { id: "project-context" },
        json: {
          skillId: `skill_${"a".repeat(64)}`,
          environmentId: null,
          path: "scripts/check.sh",
          content: "echo ok\n",
          revision: null,
        },
      });
      await expect(runCommand(args, register)).rejects.toThrow("process.exit:1");
      expect(
        collectLogLines(vi.mocked(console.error)).join("\n"),
      ).toContain("scripts/check.sh already exists");
      await expect(
        runCommand([...args, "--revision", "b".repeat(64)], register),
      ).rejects.toThrow("process.exit:1");
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a shared skill from a local file and refuses a taken name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandy-cli-skill-"));
    try {
      const file = join(dir, "SKILL.md");
      await writeFile(file, "---\nname: review\n---\nNew\n");
      const post = vi
        .fn()
        .mockResolvedValueOnce({
          filePath: "/home/me/.agents/skills/review/SKILL.md",
          revision: "c".repeat(64),
        })
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: "conflict",
              message: "A skill with this name already exists",
              details: { currentRevision: null },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        );
      stubServerApi({ "v1.projects.:id.skills.$post": post });

      await runCommand(
        ["skill", "create", "review", "--file", file, "--shared"],
        register,
      );
      expect(post).toHaveBeenCalledWith({
        param: { id: "project-context" },
        json: {
          environmentId: null,
          scope: "shared-user",
          name: "review",
          content: "---\nname: review\n---\nNew\n",
        },
      });
      expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
        "Created /home/me/.agents/skills/review/SKILL.md",
      );

      await expect(
        runCommand(["skill", "create", "review", "--file", file], register),
      ).rejects.toThrow("process.exit:1");
      expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
        "already exists",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("turns one sandy skill source off and keeps the other settings", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: {
          ...defaultAppSettings,
          streamerMode: true,
          disabledSkillSources: ["sandy-user"],
        },
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(["skill", "sources", "shared", "off", "--json"], register);

    expect(put).toHaveBeenCalledWith({
      json: {
        ...defaultAppSettings,
        streamerMode: true,
        disabledSkillSources: ["sandy-user", "shared"],
      },
    });
    const printed = JSON.parse(
      collectLogLines(vi.mocked(console.log)).join("\n"),
    );
    expect(
      printed.sources.map((source: { id: string; enabled: boolean }) => [
        source.id,
        source.enabled,
      ]),
    ).toEqual([
      ["sandy-plugins", true],
      ["sandy-user", false],
      ["sandy-project", true],
      ["shared", false],
    ]);
  });

  it("rejects an unknown skill source without writing settings", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
      })),
      "v1.settings.general.$put": put,
    });

    await expect(
      runCommand(["skill", "sources", "pi", "off"], register),
    ).rejects.toThrow("process.exit:1");
    expect(put).not.toHaveBeenCalled();
  });
});
