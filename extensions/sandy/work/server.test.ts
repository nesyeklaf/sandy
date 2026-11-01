// Runs under vitest: workflows imports its siblings as .js. The sandy/work entry on a fake SANDY: every part registers once through combine(), and the merged
// registrations carry all four parts' tools, one CLI with the parts as subcommands and one configure.
import { test } from "vitest";
import assert from "node:assert/strict";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server.ts";

async function load() {
  const host = createFakePluginHost({ pluginId: "work", agentSkillIds: ["workflows-plus", "track", "delegate"] });
  await plugin(host.sandy);
  return host;
}

test("the entry registers the agent tools of delegate, track, workflows and goals, each name once", async () => {
  const { harness } = await load();
  try {
    const names = harness.registrations.agentTools.map((tool) => tool.name);
    for (const name of ["sandy_delegate", "sandy_delegate_wait", "stage_start", "stage_advance", "sandy_workflow_plus_run"]) {
      assert.ok(names.includes(name), `missing ${name} in ${names.join(", ")}`);
    }
    assert.equal(new Set(names).size, names.length, "a tool name is registered twice");
  } finally {
    await harness.dispose();
  }
});

test("one CLI, sandy work, hands each part's subcommand to the part", async () => {
  const { harness } = await load();
  try {
    assert.equal(harness.registrations.cli?.name, "work");
    const overview = await harness.runCli([]);
    assert.equal(overview.exitCode, 0);
    for (const part of ["delegate", "workflows-plus"]) assert.match(overview.stdout ?? "", new RegExp(`\\b${part}\\b`));
    const unknown = await harness.runCli(["nope"]);
    assert.equal(unknown.exitCode, 2);
  } finally {
    await harness.dispose();
  }
});

test("each part's help names its commands under sandy work", async () => {
  const { harness } = await load();
  try {
    for (const part of ["delegate", "track", "workflows-plus"]) {
      const help = await harness.runCli([part, "--help"]);
      assert.equal(help.exitCode, 0, part);
      const text = help.stdout ?? "";
      assert.match(text, new RegExp(`sandy work ${part}\\b`), text);
      assert.doesNotMatch(text, new RegExp(`sandy ${part}\\b`), text);
    }
  } finally {
    await harness.dispose();
  }
});

// One configure for the whole plugin means SANDY offers only what it selects: a part that registers tools
// without selecting them (track had no configure of its own) would silently lose them.
test("one configure: a plain thread gets the stage tools and the track skill", async () => {
  const { harness } = await load();
  try {
    const config = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_plain" } }));
    const names = config.tools.map((tool) => (typeof tool === "string" ? tool : tool.name));
    for (const name of ["stage_start", "stage_status", "stage_submit", "stage_advance", "stage_propose_force"]) {
      assert.ok(names.includes(name), `missing ${name} in ${names.join(", ")}`);
    }
    assert.ok(config.skills.includes("track"), config.skills.join(", "));
  } finally {
    await harness.dispose();
  }
});

test("one configure: a plain thread gets the author tools of every part, no workflow worker tool", async () => {
  const { harness } = await load();
  try {
    const config = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_plain" } }));
    const names = config.tools.map((tool) => (typeof tool === "string" ? tool : tool.name));
    assert.ok(names.includes("sandy_workflow_plus_run"), names.join(", "));
    assert.ok(!names.includes("sandy_workflow_plus_result"), names.join(", "));
    assert.equal(new Set(names).size, names.length);
  } finally {
    await harness.dispose();
  }
});
