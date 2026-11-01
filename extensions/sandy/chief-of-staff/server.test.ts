import { beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server";
import type { Overview } from "./contract";

type Host = ReturnType<typeof createFakePluginHost>;

let host: Host;
let threadStatus: Map<string, "idle" | "active">;
type Spawned = { id: string; title: string; prompt: string; pluginMetadata: Record<string, unknown>; providerId?: string; model?: string; reasoningLevel?: string };
let spawned: Spawned[];

async function setup(settings: Record<string, number | string> = {}) {
  threadStatus = new Map();
  spawned = [];
  host = createFakePluginHost({
    pluginId: "chief-of-staff",
    settings: { maxConcurrent: 2, maxNudges: 1, ...settings },
    sdk: {
      threads: {
        spawn: async (args: Omit<Spawned, "id"> & { projectId: string }) => {
          const id = `thr_${spawned.length + 1}`;
          const { providerId, model, reasoningLevel } = args;
          spawned.push({ id, title: args.title, prompt: args.prompt, pluginMetadata: args.pluginMetadata, providerId, model, reasoningLevel });
          threadStatus.set(id, "active");
          return makeThreadResponse({ id, projectId: args.projectId, status: "active" });
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, status: threadStatus.get(threadId) ?? "idle" }),
        send: async () => ({}),
        stop: async () => ({}),
        retry: async () => ({}),
      },
      projects: { list: async () => [{ id: "proj_a", name: "Alpha" }] },
    } as never,
  });
  await plugin(host.sandy);
}

const rpc = (method: string, input: unknown = null) => host.harness.behavior.callRpc(method, input);
const overview = async () => (await rpc("overview")) as Overview;
const tool = (name: string, threadId: string, input: unknown) =>
  host.harness.behavior.callAgentTool(name, input, { threadId, projectId: "proj_a" });
const sends = () =>
  host.harness.inspection.sdk.callsTo("threads.send").map(([args]) => {
    const { threadId, input } = args as { threadId: string; input: { text: string }[] };
    return { threadId, text: input[0]!.text };
  });
const idle = (threadId: string, lastAssistantText: string | null) => {
  threadStatus.set(threadId, "idle");
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: threadId, status: "idle" }),
    lastAssistantText,
  });
};
const status = async (id: number) => (await overview()).items.find((item) => item.id === id)!.status;

describe("chief of staff", () => {
  beforeEach(() => setup());

  it("starts one worker per item up to the concurrency limit", async () => {
    await rpc("add_backlog", { text: "- One\n- Two\n  details\n- Three", projectId: "proj_a" });
    const view = await overview();
    expect(view.items.map((item) => item.status)).toEqual(["running", "running", "queued"]);
    expect(spawned.map((s) => s.pluginMetadata)).toEqual([
      { role: "worker", itemId: 1 },
      { role: "worker", itemId: 2 },
    ]);
    expect(spawned[1]!.prompt).toContain("details");
  });

  it("gives tools only to the threads it spawned", async () => {
    const resolve = (pluginMetadata: Record<string, string>) =>
      host.harness.behavior
        .resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata }))
        .then((config) => config.tools.map((t) => t.name));
    expect(await resolve({ role: "worker" })).toEqual(["cos_ask", "cos_report"]);
    expect(await resolve({ role: "chief" })).toEqual(["cos_answer", "cos_escalate", "cos_close_item"]);
    expect(await resolve({})).toEqual([]);
  });

  it("routes a question through the chief and delivers its answer", async () => {
    await rpc("add_backlog", { text: "Fix login", projectId: "proj_a" });
    await rpc("set_guidance", { text: "Prefer small PRs." });
    expect(await tool("cos_ask", "thr_1", { question: "Which branch?", options: ["main", "dev"] })).toContain("Q1");
    expect(await status(1)).toBe("waiting_chief");
    const chief = spawned[1]!;
    expect(chief.pluginMetadata).toEqual({ role: "chief" });
    expect(chief.prompt).toContain("Which branch?");
    expect(chief.prompt).toContain("Prefer small PRs.");

    expect(await tool("cos_answer", chief.id, { questionId: 1, answer: "Use dev." })).toContain("Sent");
    expect(sends()).toEqual([{ threadId: "thr_1", text: expect.stringContaining("Use dev.") }]);
    expect(await status(1)).toBe("running");
    expect((await overview()).answeredByChief).toBe(1);
  });

  it("queues questions while the chief is busy and sends the next when it goes idle", async () => {
    await rpc("add_backlog", { text: "A\nB", projectId: "proj_a" });
    await tool("cos_ask", "thr_1", { question: "first?" });
    await tool("cos_ask", "thr_2", { question: "second?" });
    expect(spawned).toHaveLength(3); // no second chief
    await tool("cos_answer", "thr_3", { questionId: 1, answer: "yes" });
    await idle("thr_3", "answered");
    expect(sends().at(-1)).toEqual({ threadId: "thr_3", text: expect.stringContaining("second?") });
  });

  it("runs the chief on its configured model while workers keep the project default", async () => {
    await rpc("add_backlog", { text: "A", projectId: "proj_a" });
    await tool("cos_ask", "thr_1", { question: "?" });
    expect(spawned[0]).toMatchObject({ providerId: undefined, model: undefined, reasoningLevel: undefined });
    expect(spawned[1]).toMatchObject({ providerId: "pi", model: "openai-codex/gpt-5.6-luna", reasoningLevel: "medium" });
  });

  it("uses the chief model settings for the next chief thread", async () => {
    await setup({ chiefProvider: "codex", chiefModel: "gpt-6-astra", chiefReasoning: "high" });
    await rpc("add_backlog", { text: "A", projectId: "proj_a" });
    await tool("cos_ask", "thr_1", { question: "?" });
    expect(spawned[1]).toMatchObject({ providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" });
  });

  it("escalates real decisions to the user and sends the user's answer", async () => {
    await rpc("add_backlog", { text: "Buy a domain", projectId: "proj_a" });
    await tool("cos_ask", "thr_1", { question: "Spend $40?" });
    await tool("cos_escalate", "thr_2", { questionId: 1, why: "Costs money", options: ["Buy", "Skip"], recommendation: "Buy" });
    let view = await overview();
    expect(view.decisions.map((d) => [d.id, d.why, d.options])).toEqual([[1, "Costs money", ["Buy", "Skip"]]]);
    expect(view.items[0]!.status).toBe("waiting_user");

    await rpc("decide", { questionId: 1, answer: "Buy" });
    view = await overview();
    expect(view.decisions).toEqual([]);
    expect(view.items[0]!.status).toBe("running");
    expect(sends().at(-1)).toEqual({ threadId: "thr_1", text: expect.stringContaining("Answer from the user") });
  });

  it("escalates when the chief ends its turn without deciding", async () => {
    await rpc("add_backlog", { text: "A", projectId: "proj_a" });
    await tool("cos_ask", "thr_1", { question: "Hmm?" });
    await idle("thr_2", "Not sure.");
    const [decision] = (await overview()).decisions;
    expect(decision!.why).toContain("without deciding");
  });

  it("checks in on a stopped worker, then hands it to the user after the nudge limit", async () => {
    await rpc("add_backlog", { text: "A", projectId: "proj_a" });
    await idle("thr_1", "I stopped here.");
    expect(await status(1)).toBe("waiting_chief");
    expect(spawned[1]!.prompt).toContain("I stopped here.");
    await tool("cos_answer", "thr_2", { questionId: 1, answer: "Keep going." });
    await idle("thr_2", "done");

    await idle("thr_1", "Stopped again."); // nudges (1) reached maxNudges (1)
    const view = await overview();
    expect(view.items[0]!.status).toBe("waiting_user");
    expect(view.decisions[0]!.kind).toBe("checkin");
  });

  it("finishes items, starts queued ones, and handles failures", async () => {
    await rpc("add_backlog", { text: "A\nB\nC", projectId: "proj_a" });
    await tool("cos_report", "thr_1", { status: "done", summary: "Shipped A." });
    expect(await status(1)).toBe("done");
    expect(await status(3)).toBe("running");

    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_2", status: "error" }),
      error: "boom",
    });
    expect(await status(2)).toBe("failed");
    await rpc("item_action", { itemId: 2, action: "retry" });
    expect(host.harness.inspection.sdk.callsTo("threads.retry")).toEqual([[{ threadId: "thr_2" }]]);
    expect(await status(2)).toBe("running");
  });

  it("rejects chief tools from other threads and tools on unknown threads", async () => {
    await rpc("add_backlog", { text: "A", projectId: "proj_a" });
    await tool("cos_ask", "thr_1", { question: "?" });
    expect(await tool("cos_answer", "thr_1", { questionId: 1, answer: "x" })).toMatchObject({ isError: true });
    expect(await tool("cos_report", "thr_other", { status: "done", summary: "x" })).toMatchObject({ isError: true });
  });

  it("pauses dispatch and briefs over the CLI", async () => {
    await rpc("set_paused", { paused: true });
    await rpc("add_backlog", { text: "A", projectId: "proj_a" });
    expect(spawned).toHaveLength(0);
    const brief = await host.harness.behavior.runCli(["brief"]);
    expect(brief.exitCode).toBe(0);
    expect(brief.stdout).toContain("Decisions for you (0)");
    expect(brief.stdout).toContain("Dispatch is paused");
    const resumed = await host.harness.behavior.runCli(["resume"]);
    expect(resumed.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
  });
});
