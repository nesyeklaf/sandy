import type { HostProviderCommand } from "@sandy/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { buildCommandListResponse } from "../../../src/services/threads/provider-command-typeahead.js";

function skill(
  name: string,
  overrides: Partial<HostProviderCommand> = {},
): HostProviderCommand {
  return {
    name,
    source: "skill",
    origin: overrides.origin ?? "user",
    description: overrides.description ?? null,
    argumentHint: overrides.argumentHint ?? null,
  };
}

describe("buildCommandListResponse", () => {
  it("adds the provider's live commands that the scan does not offer", () => {
    const response = buildCommandListResponse({
      commands: [skill("grilling")],
      liveCommands: [
        { name: "grilling", description: "Live copy of a scanned skill" },
        {
          name: "simplify",
          description: "Simplify the changed code",
          inputHint: "[<target>]",
        },
        { name: "clear", description: "Provider clear" },
      ],
      includeBuiltinCompact: false,
      skillCatalog: [],
      skillSelection: { mode: "inherit" },
    });

    expect(
      response.commands.map((command) => [command.name, command.description]),
    ).toEqual([
      ["clear", "Start fresh context in this thread"],
      ["simplify", "Simplify the changed code"],
      ["grilling", null],
    ]);
    expect(
      response.commands.find((command) => command.name === "simplify"),
    ).toMatchObject({ source: "command", argumentHint: "[<target>]" });
  });

  it("keeps canonical built-ins when project commands collide", () => {
    const response = buildCommandListResponse({
      commands: [
        {
          name: "clear",
          source: "command",
          origin: "project",
          description: "Project clear command",
          argumentHint: null,
        },
        {
          name: "compact",
          source: "command",
          origin: "project",
          description: "Project compact command",
          argumentHint: "<target>",
        },
      ],
      liveCommands: [],
      includeBuiltinCompact: true,
      skillCatalog: [],
      skillSelection: { mode: "inherit" },
    });

    expect(response.commands).toEqual([
      {
        name: "clear",
        source: "command",
        origin: "builtin",
        description: "Start fresh context in this thread",
        argumentHint: null,
      },
      {
        name: "compact",
        source: "command",
        origin: "builtin",
        description: "Compact context",
        argumentHint: null,
      },
    ]);
  });

  it("includes plugin provenance on canonical skill rows", () => {
    const response = buildCommandListResponse({
      commands: [],
      liveCommands: [],
      includeBuiltinCompact: true,
      skillCatalog: [
        {
          provenance: { kind: "plugin", pluginId: "ottonomous" },
          runtimeSource: {
            kind: "tree",
            sourceType: "data-dir",
            name: "review",
            description: "Review the current change",
            treeHash: "abc123",
            entryPath: "SKILL.md",
          },
        },
      ],
      skillSelection: { mode: "inherit" },
    });

    expect(response.commands).toContainEqual({
      name: "review",
      source: "skill",
      origin: "user",
      description: "Review the current change",
      argumentHint: null,
      pluginId: "ottonomous",
    });
  });

  it("keeps the first user-origin skill when global roots provide the same name", () => {
    const response = buildCommandListResponse({
      commands: [
        skill("sandy-cli", { description: "Data-dir override" }),
        skill("sandy-cli", { description: "Built-in default" }),
      ],
      liveCommands: [],
      includeBuiltinCompact: true,
      skillCatalog: [],
      skillSelection: { mode: "inherit" },
    });

    expect(
      response.commands.filter((command) => command.name === "sandy-cli"),
    ).toEqual([
      {
        name: "sandy-cli",
        source: "skill",
        origin: "user",
        description: "Data-dir override",
        argumentHint: null,
      },
    ]);
  });

  it("drops skill rows the selection turns off, from every source, and keeps commands", () => {
    const catalogSkill = (name: string) => ({
      provenance: { kind: "plugin" as const, pluginId: "ottonomous" },
      runtimeSource: {
        kind: "tree" as const,
        sourceType: "data-dir" as const,
        name,
        description: `The ${name} skill`,
        treeHash: "abc123",
        entryPath: "SKILL.md",
      },
    });
    const commands = [
      skill("grilling"),
      skill("simplify"),
      {
        name: "grilling",
        source: "command" as const,
        origin: "project" as const,
        description: null,
        argumentHint: null,
      },
    ];
    const names = (selection: Parameters<
      typeof buildCommandListResponse
    >[0]["skillSelection"]) =>
      buildCommandListResponse({
        commands,
        liveCommands: [{ name: "grilling", description: "Live copy" }],
        includeBuiltinCompact: false,
        skillCatalog: [catalogSkill("review"), catalogSkill("grilling")],
        skillSelection: selection,
      }).commands.map((command) => `${command.source}:${command.name}`);

    expect(names({ mode: "disable", names: ["grilling"] })).toEqual([
      "command:clear",
      "skill:review",
      "skill:simplify",
      "command:grilling",
    ]);
    expect(names({ mode: "allow-only", names: ["review"] })).toEqual([
      "command:clear",
      "skill:review",
      "command:grilling",
    ]);
  });

  it("omits the built-in compact row for unsupported providers", () => {
    const response = buildCommandListResponse({
      commands: [],
      liveCommands: [],
      includeBuiltinCompact: false,
      skillCatalog: [],
      skillSelection: { mode: "inherit" },
    });

    expect(response.commands).toEqual([
      {
        name: "clear",
        source: "command",
        origin: "builtin",
        description: "Start fresh context in this thread",
        argumentHint: null,
      },
    ]);
  });
});
