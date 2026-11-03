import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server.ts";
import { machineSchema } from "../work/track/machine.ts";
import { migrateLinear, type FlowStep } from "./graph.ts";
import { formatIo } from "./io.ts";
import { UX_SKILLS, uxFlow } from "./ux-flow.fixture.ts";
import { classify, DEFAULT_USE_CASES, FALLBACK_ID, resolveUseCase, sourceOf } from "./usecases.ts";

const skillEntry = (id: string, name: string, description: string, metadata: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description,
  provider: null,
  scope: "user",
  pluginId: null,
  filePath: "/" + id,
  manageable: true,
  providers: [],
  duplicates: [],
  metadata,
  ...extra,
});

const skills = [
  skillEntry("skill_a", "debug", "Find the cause of a failure", { inputs: "failure: text; repro?: url", outputs: "diagnosis.md: file(diagnosis.md)" }),
  skillEntry("skill_b", "write-docs", "Write project docs", { inputs: "topic: choice(a); oops", outputs: "doc: banana" }),
  skillEntry("skill_c", "zebra", "Something unrelated"),
  skillEntry("skill_d", "debug", "duplicate entry", {}, { provider: "pi", scope: "provider-user", filePath: "/home/u/.agents/skills/debug/SKILL.md", manageable: false }),
];

const uxSkills = UX_SKILLS.map((info, index) => skillEntry("ux_" + String(index), info.name, info.purpose, { inputs: formatIo(info.inputs), outputs: formatIo(info.outputs) }));

const deletedThreads: string[] = [];

async function boot(reply = "{}", listed: readonly unknown[] = skills) {
  const { sandy, harness } = createFakePluginHost({
    pluginId: "skill-usecases",
    sdk: {
      projects: { list: async () => [{ id: "proj_1", name: "One" }, { id: "proj_2", name: "Two" }] },
      skills: { list: async () => ({ skills: listed }) },
      threads: {
        spawn: async () => ({ id: "thr_ai" }),
        wait: async () => ({}),
        output: async () => ({ output: reply }),
        delete: async ({ threadId }: { threadId: string }) => {
          deletedThreads.push(threadId);
          return {};
        },
      },
    } as never,
  });
  await plugin(sandy);
  return Object.assign(harness, { kv: sandy.storage.kv });
}

test("name hits beat description hits and unknown skills fall back", () => {
  assert.equal(classify({ name: "debug", description: null }, DEFAULT_USE_CASES), "debug");
  assert.equal(classify({ name: "zebra", description: "nothing" }, DEFAULT_USE_CASES), FALLBACK_ID);
  assert.equal(classify({ name: "x", description: "write a plan" }, DEFAULT_USE_CASES), "plan");
});

test("manual assignment wins and a stale assignment is ignored", () => {
  const skill = { name: "debug", description: null };
  assert.deepEqual(resolveUseCase(skill, DEFAULT_USE_CASES, { debug: "write" }), { useCaseId: "write", manual: true });
  assert.deepEqual(resolveUseCase(skill, DEFAULT_USE_CASES, { debug: "gone" }), { useCaseId: "debug", manual: false });
});

test("state groups skills, dedupes by name, picks the first project", async () => {
  const harness = await boot();
  const state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  assert.equal(state.projectId, "proj_1");
  assert.deepEqual(state.skills.map((s: any) => [s.name, s.useCaseId, s.manual]), [
    ["debug", "debug", false],
    ["write-docs", "write", false],
    ["zebra", "other", false],
  ]);
});

test("assign persists, publishes and can be cleared", async () => {
  const harness = await boot();
  await harness.behavior.callRpc("assign", { skillName: "zebra", useCaseId: "learn" });
  let state = (await harness.behavior.callRpc("state", { projectId: "proj_2" })) as any;
  assert.equal(state.projectId, "proj_2");
  assert.deepEqual(state.skills.find((s: any) => s.name === "zebra"), { name: "zebra", description: "Something unrelated", scope: "user", provider: null, useCaseId: "learn", manual: true, sources: ["other"], inputs: [], outputs: [], ioErrors: [] });
  await harness.behavior.callRpc("assign", { skillName: "zebra", useCaseId: null });
  state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  assert.equal(state.skills.find((s: any) => s.name === "zebra").manual, false);
});

test("removing a use case drops assignments to it; the fallback id is reserved", async () => {
  const harness = await boot();
  await harness.behavior.callRpc("assign", { skillName: "zebra", useCaseId: "learn" });
  const kept = DEFAULT_USE_CASES.filter((u) => u.id !== "learn");
  assert.deepEqual(await harness.behavior.callRpc("saveUseCases", { useCases: kept }), { ok: true });
  const state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  assert.equal(state.skills.find((s: any) => s.name === "zebra").manual, false);
  assert.deepEqual(await harness.behavior.callRpc("saveUseCases", { useCases: [{ id: "other", label: "x", keywords: [] }] }), { ok: false });
  assert.deepEqual(await harness.behavior.callRpc("saveUseCases", { useCases: [kept[0], kept[0]] }), { ok: false });
});

test("reset restores the defaults", async () => {
  const harness = await boot();
  await harness.behavior.callRpc("saveUseCases", { useCases: [{ id: "only", label: "Only", keywords: ["zebra"] }] });
  await harness.behavior.callRpc("resetUseCases", {});
  const state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  assert.equal(state.useCases.length, DEFAULT_USE_CASES.length);
});

test("sources are derived from the skill location and merged over duplicates", async () => {
  const at = (scope: string, provider: string | null, filePath: string) => sourceOf({ scope, provider, filePath });
  assert.equal(at("provider-user", "pi", "/home/u/.agents/skills/x/SKILL.md"), "agents");
  assert.equal(at("provider-user", "codex", "/home/u/.codex/skills/.system/x/SKILL.md"), "codex");
  assert.equal(at("provider-user", "acp-omp", "/home/u/.config/opencode/skills/x/SKILL.md"), "opencode");
  assert.equal(at("sandy-project", null, "/p/.sandy/skills/x/SKILL.md"), "sandy");
  assert.equal(at("plugin", null, "/home/u/.sandy-machines/m/x/SKILL.md"), "sandy plugins");
  assert.equal(at("plugin", "codex", "/home/u/.codex/plugins/x/SKILL.md"), "codex plugins");
  assert.equal(at("provider-user", null, "/srv/x/SKILL.md"), "other");
  const harness = await boot();
  const state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  assert.deepEqual(state.skills.find((s: any) => s.name === "debug").sources, ["agents", "other"]);
});

const flow = (id: string, useCaseId: string, name = id, steps: FlowStep[] = [{ skill: "debug", note: "" }]) =>
  migrateLinear({ id, useCaseId, name, description: "", steps });

test("deleting an area moves its flows to the fallback; unknown areas are rejected", async () => {
  const harness = await boot();
  assert.deepEqual(await harness.behavior.callRpc("saveFlows", { flows: [flow("a", "learn"), flow("b", "plan")] }), { ok: true });
  assert.deepEqual(await harness.behavior.callRpc("saveFlows", { flows: [flow("c", "nope")] }), { ok: false });
  await harness.behavior.callRpc("saveUseCases", { useCases: DEFAULT_USE_CASES.filter((u) => u.id !== "learn") });
  const overview = (await harness.behavior.callRpc("overview", {})) as any;
  assert.deepEqual(overview.flows.map((f: any) => [f.id, f.useCaseId]), [["a", "other"], ["b", "plan"]]);
});

test("recommended flow keeps only known skills once, in order, and the helper thread is deleted", async () => {
  deletedThreads.length = 0;
  const reply = '```json\n{"name":"Fix bug","description":"d","rationale":"r","steps":[{"skill":"nope","note":"x"},{"skill":"debug","note":"find"},{"skill":"debug","note":"again"},{"skill":"write-docs"}]}\n```';
  const harness = await boot(reply);
  const result = (await harness.behavior.callRpc("recommendFlow", { projectId: null, useCaseId: "debug", goal: "fix", current: null })) as any;
  assert.deepEqual(result.proposal.steps, [{ skill: "debug", note: "find" }, { skill: "write-docs", note: "" }]);
  assert.deepEqual(deletedThreads, ["thr_ai"]);
});

test("an AI reply without JSON fails and still cleans up", async () => {
  deletedThreads.length = 0;
  const harness = await boot("sorry, no");
  await assert.rejects(harness.behavior.callRpc("recommendFlow", { projectId: null, useCaseId: "debug", goal: "", current: null }));
  assert.deepEqual(deletedThreads, ["thr_ai"]);
});

test("assignment proposals skip unchanged skills; applying creates a new area once", async () => {
  const reply = JSON.stringify({
    assignments: [
      { skill: "debug", area: "debug", reason: "same" },
      { skill: "zebra", area: "Animals", reason: "stripes" },
      { skill: "write-docs", area: "Animals", reason: "x" },
      { skill: "ghost", area: "plan", reason: "unknown" },
    ],
  });
  const harness = await boot(reply);
  const { proposals } = (await harness.behavior.callRpc("recommendAssignments", { projectId: null })) as any;
  assert.deepEqual(proposals.map((p: any) => [p.skillName, p.areaId, p.newAreaLabel]), [["zebra", null, "Animals"], ["write-docs", null, "Animals"]]);
  await harness.behavior.callRpc("applyAssignments", { items: proposals.map((p: any) => ({ skillName: p.skillName, areaId: p.areaId, newAreaLabel: p.newAreaLabel })) });
  const state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  const animals = state.useCases.filter((u: any) => u.label === "Animals");
  assert.equal(animals.length, 1);
  assert.deepEqual(state.skills.filter((s: any) => s.useCaseId === animals[0].id).map((s: any) => s.name), ["write-docs", "zebra"]);
});

test("agent tools list skills by area and flows in order", async () => {
  const harness = await boot();
  await harness.behavior.callRpc("saveFlows", { flows: [flow("f1", "debug", "Fix it", [{ skill: "debug", note: "find cause" }, { skill: "write-docs", note: "" }])] });
  const areas = (await harness.behavior.callAgentTool("skill_areas", { area: "debug" })) as string;
  assert.match(areas, /^Debug and test \(debug\)\n- debug:/u);
  assert.doesNotMatch(areas, /zebra/u);
  const flows = (await harness.behavior.callAgentTool("skill_flows", { flow: "fix it" })) as string;
  assert.match(flows, /1\. debug - find cause\n2\. write-docs/u);
  assert.equal(await harness.behavior.callAgentTool("skill_flows", { flow: "missing" }), "No flows found.");
});

test("the ~ mention provider finds flows by name and resolves one into run instructions", async () => {
  const harness = await boot();
  await harness.behavior.callRpc("saveFlows", {
    flows: [
      flow("f1", "debug", "Fix it", [{ skill: "debug", note: "find cause" }, { skill: "write-docs", note: "" }]),
      flow("f2", "plan", "Plan it", []),
    ],
  });
  const provider = harness.registrations.mentionProviders[0]!;
  assert.deepEqual(provider.triggers, ["~"]);
  const found = await provider.search({ trigger: "~", query: "fix", projectId: null, threadId: null });
  assert.deepEqual(found.map((item) => [item.id, item.title, item.subtitle]), [["f1", "Fix it", "debug > write-docs"]]);
  assert.equal((await provider.search({ trigger: "~", query: "", projectId: null, threadId: null })).length, 2);
  const resolved = (await provider.resolve("f1")) as { context: string };
  assert.match(resolved.context, /^Run the flow "Fix it" as a track\.\n1\. Call flow_track with flow "f1"\./u);
  assert.match(resolved.context, /stage_start with that machine and the note "Flow Fix it"/u);
  assert.match(resolved.context, /use each skill in this order instead.*\n1\. \/debug - find cause\n2\. \/write-docs\n/u);
  await assert.rejects(async () => provider.resolve("gone"), /no longer exists/u);
});

test("stored linear flows are read as graphs and written back once as graphs", async () => {
  const harness = await boot();
  const linear = { id: "old", useCaseId: "debug", name: "Old", description: "d", steps: [{ skill: "debug", note: "find" }, { skill: "write-docs", note: "" }] };
  await harness.kv.set("flows", [linear]);
  const overview = (await harness.behavior.callRpc("overview", {})) as any;
  assert.deepEqual(overview.flows, [migrateLinear(linear)]);
  assert.deepEqual(await harness.kv.get("flows"), [migrateLinear(linear)]);
  const flows = (await harness.behavior.callAgentTool("skill_flows", { flow: "old" })) as string;
  assert.match(flows, /1\. debug - find\n2\. write-docs/u);
});

test("a branching flow saves and resolves into run text with its branches", async () => {
  const harness = await boot();
  const branching = {
    ...flow("g1", "debug", "Branchy", [{ skill: "debug", note: "" }]),
    nodes: [
      ...flow("g1", "debug").nodes,
      { id: "q", kind: "gate", question: "Good enough?", x: 0, y: 0, owner: "owner", options: ["yes", "no"], material: [], ends: [0] },
    ],
    wires: [
      { id: "w1", from: "s1", port: 0, to: "q" },
      { id: "w2", from: "q", port: 1, to: "s1" },
    ],
  };
  assert.deepEqual(await harness.behavior.callRpc("saveFlows", { flows: [branching] }), { ok: true });
  const resolved = (await harness.registrations.mentionProviders[0]!.resolve("g1")) as { context: string };
  assert.match(resolved.context, /1\. \/debug\n2\. Ask me: Good enough\? \(yes -> finish, no -> step 1\)/u);
});

test("skill rows carry the IO parsed from SKILL.md metadata and report malformed entries", async () => {
  const harness = await boot();
  const state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  const debug = state.skills.find((s: any) => s.name === "debug");
  assert.deepEqual(debug.inputs, [
    { name: "failure", optional: false, type: { kind: "text" } },
    { name: "repro", optional: true, type: { kind: "url" } },
  ]);
  assert.deepEqual(debug.outputs, [{ name: "diagnosis.md", optional: false, type: { kind: "file", path: "diagnosis.md" } }]);
  assert.deepEqual(debug.ioErrors, []);
  const docs = state.skills.find((s: any) => s.name === "write-docs");
  assert.deepEqual(docs.inputs, []);
  assert.deepEqual(docs.outputs, []);
  assert.deepEqual(docs.ioErrors, [
    'inputs: entry 1 "topic": choice(...) needs at least two values',
    'inputs: entry 2 "oops" has no type, write "Name: type"',
    'outputs: entry 1 "doc": unknown type "banana", use text, url, file, file(path) or choice(a, b)',
  ]);
});

test("a skill listed by an older host without metadata still yields a row with no IO", async () => {
  const { metadata: _dropped, ...bare } = skillEntry("skill_old", "legacy", "Listed before metadata existed");
  const harness = await boot("{}", [...skills, bare]);
  const state = (await harness.behavior.callRpc("state", { projectId: null })) as any;
  const legacy = state.skills.find((s: any) => s.name === "legacy");
  assert.deepEqual([legacy.inputs, legacy.outputs, legacy.ioErrors], [[], [], []]);
  assert.ok(state.skills.some((s: any) => s.name === "debug"));
});

test("flow_track compiles the UX flow into a machine the track accepts", async () => {
  const harness = await boot("{}", uxSkills);
  assert.deepEqual(await harness.behavior.callRpc("saveFlows", { flows: [{ ...uxFlow(), useCaseId: "plan" }] }), { ok: true });
  const text = (await harness.behavior.callAgentTool("flow_track", { flow: "UX design" })) as string;
  const parsed = machineSchema.safeParse(JSON.parse(text));
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(JSON.parse(text).start, "frame-the-problem");
  assert.equal(await harness.behavior.callAgentTool("flow_track", { flow: "ux" }), text);
});

test("flow_track refuses a broken flow with its Check problems and an unknown flow by name", async () => {
  const harness = await boot("{}", uxSkills);
  const flow = uxFlow();
  const broken = { ...flow, useCaseId: "plan", wires: flow.wires.filter((item) => item.id !== "w10") };
  await harness.behavior.callRpc("saveFlows", { flows: [broken] });
  const refused = (await harness.behavior.callAgentTool("flow_track", { flow: "ux" })) as any;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /cannot run as a track yet/u);
  assert.match(refused.content[0].text, /"keep" leads nowhere.*\(fix in the editor: Finish here, Add Output after keep\)/u);
  const missing = (await harness.behavior.callAgentTool("flow_track", { flow: "nope" })) as any;
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No flow named "nope"/u);
});
