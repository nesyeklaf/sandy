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
