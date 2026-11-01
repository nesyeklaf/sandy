import type { DiscoveredSkill, SkillRootKind } from "@sandy/host-daemon-contract";
import { createHash } from "node:crypto";
import type { SkillProvider } from "@sandy/server-contract";
import { describe, expect, it } from "vitest";
import {
  assembleSkillList,
  mapSkillScope,
  summarizeSkillRegistrations,
  type IndexedSkillRegistration,
} from "../../src/services/skills/skill-listing.js";

describe("mapSkillScope", () => {
  const cases: Array<{
    provider: SkillProvider;
    rootKind: SkillRootKind;
    scope: string;
    listedProvider: SkillProvider | null;
    manageable: boolean;
    filePath?: string;
  }> = [
    {
      provider: "claude-code",
      rootKind: "sandy-project",
      scope: "sandy-project",
      listedProvider: null,
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "sandy-data-dir",
      scope: "sandy-user",
      listedProvider: null,
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "sandy-builtin",
      scope: "sandy-builtin",
      listedProvider: null,
      manageable: false,
    },
    {
      provider: "claude-code",
      rootKind: "provider-project",
      scope: "provider-project",
      listedProvider: "claude-code",
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "provider-user",
      scope: "provider-user",
      listedProvider: "claude-code",
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "plugin",
      scope: "plugin",
      listedProvider: "claude-code",
      manageable: false,
    },
    {
      provider: "codex",
      rootKind: "plugin",
      scope: "plugin",
      listedProvider: "codex",
      manageable: false,
    },
  ];

  for (const testCase of cases) {
    it(`maps (${testCase.provider}, ${testCase.rootKind}) → ${testCase.scope}`, () => {
      expect(
        mapSkillScope(
          testCase.provider,
          testCase.rootKind,
          testCase.filePath ?? "/home/user/skills/review/SKILL.md",
        ),
      ).toEqual({
        scope: testCase.scope,
        provider: testCase.listedProvider,
        manageable: testCase.manageable,
      });
    });
  }

  it("keeps bundled Codex system skills protected", () => {
    expect(
      mapSkillScope(
        "codex",
        "provider-user",
        "/home/user/.codex/skills/.system/imagegen/SKILL.md",
      ),
    ).toEqual({ scope: "provider-user", provider: "codex", manageable: false });
  });
});

describe("assembleSkillList", () => {
  function discovered(
    name: string,
    rootKind: SkillRootKind,
    filePath: string,
  ): DiscoveredSkill {
    return {
      id: `skill_${createHash("sha256").update(filePath).digest("hex")}`,
      name,
      description: null,
      rootKind,
      filePath,
      realPath: filePath,
      contentSha256: createHash("sha256").update(filePath).digest("hex"),
      linked: false,
    };
  }

  it("de-dupes a sandy skill discovered under both providers", () => {
    const sandy = discovered(
      "shared",
      "sandy-data-dir",
      "/data/skills/shared/SKILL.md",
    );
    const result = assembleSkillList([
      { provider: "claude-code", skills: [sandy] },
      { provider: "codex", skills: [sandy] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "shared",
      provider: null,
      scope: "sandy-user",
    });
  });

  it("keeps provider-specific skills distinct and sorts by scope then name", () => {
    const result = assembleSkillList([
      {
        provider: "claude-code",
        skills: [
          discovered(
            "zed",
            "provider-user",
            "/home/.claude/skills/zed/SKILL.md",
          ),
          discovered("alpha", "sandy-project", "/cwd/.sandy/skills/alpha/SKILL.md"),
        ],
      },
      {
        provider: "codex",
        skills: [
          discovered(
            "zed",
            "provider-user",
            "/home/.codex/skills/zed/SKILL.md",
          ),
        ],
      },
    ]);
    expect(result.map((skill) => [skill.scope, skill.name])).toEqual([
      ["sandy-project", "alpha"],
      ["provider-user", "zed"],
      ["provider-user", "zed"],
    ]);
  });

  it("protects a Cursor skill discovered through a symlinked root", () => {
    const cursor = {
      ...discovered(
        "impeccable",
        "provider-project",
        "/cwd/.cursor/skills/impeccable/SKILL.md",
      ),
      linked: true,
    };

    expect(
      assembleSkillList([{ provider: "acp-cursor", skills: [cursor] }]),
    ).toContainEqual(
      expect.objectContaining({
        name: "impeccable",
        scope: "provider-project",
        provider: "acp-cursor",
        manageable: false,
      }),
    );
  });

  it("keeps linked provider user skills visible but not manageable", () => {
    const linked = {
      ...discovered(
        "shared-link",
        "provider-user",
        "/home/.codex/skills/shared-link/SKILL.md",
      ),
      linked: true,
    };

    expect(
      assembleSkillList([{ provider: "codex", skills: [linked] }])[0],
    ).toMatchObject({
      name: "shared-link",
      scope: "provider-user",
      manageable: false,
    });
  });
});

describe("summarizeSkillRegistrations", () => {
  function registration(
    overrides: Partial<IndexedSkillRegistration> &
      Pick<IndexedSkillRegistration, "filePath" | "name">,
  ): IndexedSkillRegistration {
    return {
      id: `skill_${createHash("sha256")
        .update(overrides.filePath + (overrides.provider ?? ""))
        .digest("hex")}`,
      description: null,
      provider: null,
      scope: "provider-user",
      pluginId: null,
      manageable: false,
      realPath: overrides.filePath,
      contentSha256: createHash("sha256")
        .update(overrides.filePath)
        .digest("hex"),
      ...overrides,
    };
  }

  it("lists a symlinked skill once with every agent that loads it and the other path once as a same-file duplicate", () => {
    const real = "/home/.pi/agent/git/forge-skills/skills/debug/SKILL.md";
    const piPackage = registration({
      name: "debug",
      provider: "pi",
      filePath: real,
    });
    const piLinked = registration({
      name: "debug",
      provider: "pi",
      filePath: "/home/.agents/skills/debug/SKILL.md",
      realPath: real,
      contentSha256: piPackage.contentSha256,
    });
    const cursorLinked = {
      ...piLinked,
      id: registration({
        name: "debug",
        provider: "acp-cursor",
        filePath: piLinked.filePath,
      }).id,
      provider: "acp-cursor",
    };

    const result = summarizeSkillRegistrations([
      piPackage,
      piLinked,
      cursorLinked,
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: piPackage.id,
      providers: ["acp-cursor", "pi"],
    });
    expect(
      result[0]?.duplicates.map((d) => [d.id, d.filePath, d.relation]),
    ).toEqual([[piLinked.id, piLinked.filePath, "same-file"]]);
    expect(result[0]).not.toHaveProperty("realPath");
    expect(result[0]).not.toHaveProperty("contentSha256");
  });

  it("marks a copied file as same-content and a different skill with the same name as same-name on both sides", () => {
    const original = registration({
      name: "pdf",
      provider: "acp-cursor",
      filePath: "/home/.cursor/skills/pdf/SKILL.md",
    });
    const copy = registration({
      name: "pdf",
      provider: "acp-hermes-agent",
      filePath: "/home/.hermes/skills/pdf/SKILL.md",
      contentSha256: original.contentSha256,
    });
    const other = registration({
      name: "pdf",
      scope: "plugin",
      pluginId: "docs",
      filePath: "/plugins/docs/skills/pdf/SKILL.md",
    });

    const result = summarizeSkillRegistrations([original, copy, other]);

    expect(result).toHaveLength(2);
    const byId = new Map(result.map((skill) => [skill.id, skill]));
    expect(byId.get(original.id)?.providers).toEqual([
      "acp-cursor",
      "acp-hermes-agent",
    ]);
    expect(
      byId.get(original.id)?.duplicates.map((d) => [d.id, d.relation]),
    ).toEqual([
      [copy.id, "same-content"],
      [other.id, "same-name"],
    ]);
    expect(
      byId.get(other.id)?.duplicates.map((d) => [d.id, d.relation]),
    ).toEqual([
      [original.id, "same-name"],
      [copy.id, "same-name"],
    ]);
    expect(byId.get(other.id)?.providers).toEqual([]);
  });

  it("does not count one path loaded by several agents as a duplicate", () => {
    const filePath = "/home/.agents/skills/architect/SKILL.md";
    const forCodex = registration({
      name: "architect",
      provider: "codex",
      filePath,
    });
    const forPi = registration({ name: "architect", provider: "pi", filePath });

    const result = summarizeSkillRegistrations([forCodex, forPi]);

    expect(result).toHaveLength(1);
    expect(result[0]?.providers).toEqual(["codex", "pi"]);
    expect(result[0]?.duplicates).toEqual([]);
  });

  it("leaves a unique skill without duplicates", () => {
    const only = registration({
      name: "solo",
      provider: "codex",
      filePath: "/home/.codex/skills/solo/SKILL.md",
    });
    expect(summarizeSkillRegistrations([only])).toEqual([
      {
        id: only.id,
        name: "solo",
        description: null,
        provider: "codex",
        scope: "provider-user",
        pluginId: null,
        filePath: only.filePath,
        manageable: false,
        providers: ["codex"],
        duplicates: [],
      },
    ]);
  });
});
