import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server.js";

const bundledSkills = readdirSync(new URL("./skills", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

it("introduces sandy without user-question guidance", async () => {
  const { sandy, harness } = createFakePluginHost({
    pluginId: "sandy-guide",
    agentSkillIds: bundledSkills,
  });
  try {
    await plugin(sandy);
    const introduction = harness.registrations.instructionProvider?.({
      threadId: "thr_test",
      projectId: "proj_test",
    });
    expect(introduction).toContain("You are working inside sandy");
    expect(introduction).toContain("agentic IDE");
    expect(introduction).toContain(
      "Reference a SANDY thread as `@thread:thr_abc123`",
    );
    expect(introduction).toContain("Do not construct thread URLs manually");
    expect(introduction).toContain("`sandy voice transcribe <path>`");
    expect(introduction).not.toContain(
      "Ask the user a blocking question only when",
    );
    expect(introduction).toBe(introduction?.trim());
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("keeps the introduction and skill switches independent across reloads", async () => {
  const { sandy, harness } = createFakePluginHost({
    pluginId: "sandy-guide",
    agentSkillIds: bundledSkills,
  });
  try {
    await plugin(sandy);
    const instructions = () =>
      harness.registrations.instructionProvider?.({
        threadId: "thr_test",
        projectId: "proj_test",
      });
    const skills = async () =>
      (
        await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext(),
        )
      ).skills;
    expect(instructions()).toContain("You are working inside sandy");
    expect((await skills()).sort()).toEqual([...bundledSkills].sort());
    await harness.behavior.setSettings({
      introduction: false,
      pluginAuthoring: false,
    });
    expect(instructions()).toBeNull();
    expect(await skills()).toEqual(["sandy-cli", "skill-creator"]);
    await harness.behavior.setSettings({ skills: false });
    expect(await skills()).toEqual([]);
    await harness.lifecycle.reload(plugin);
    expect(instructions()).toBeNull();
    expect(await skills()).toEqual([]);
    await harness.behavior.setSettings({ introduction: true, skills: true });
    expect(instructions()).toContain("sandy status");
    expect(await skills()).toEqual(["sandy-cli", "skill-creator"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

describe("individual skill selection", () => {
  it.each([
    ["sandyCli", ["sandy-plugin-authoring", "skill-creator"]],
    ["pluginAuthoring", ["sandy-cli", "skill-creator"]],
    ["skillCreator", ["sandy-cli", "sandy-plugin-authoring"]],
  ])("disables %s", async (key, expected) => {
    const { sandy, harness } = createFakePluginHost({
      pluginId: "sandy-guide",
      agentSkillIds: bundledSkills,
    });
    try {
      await plugin(sandy);
      await harness.behavior.setSettings({ [key]: false });
      expect(
        (
          await harness.behavior.resolveAgentConfiguration(
            makePluginAgentConfigurationContext(),
          )
        ).skills,
      ).toEqual(expected);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
