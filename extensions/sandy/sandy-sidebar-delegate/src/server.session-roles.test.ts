import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { loadPlugin } from "./test-server";
import { IDEA_INSTRUCTIONS, ORCHESTRATOR_INSTRUCTIONS, SESSION_ROLES_TOOL } from "./server-session-roles";

type Harness = Awaited<ReturnType<typeof loadPlugin>>;

const resolve = (harness: Harness, threadId: string) =>
  harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
    }),
  );

describe("session roles", () => {
  it("tells an orchestrator session its role and gives it the roles tool", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("setOrchestrator", { threadIds: ["thr_o"], orchestrator: true });
    const resolved = await resolve(harness, "thr_o");
    expect(resolved.instructions).toBe(ORCHESTRATOR_INSTRUCTIONS);
    expect(resolved.tools.map((tool) => tool.name)).toEqual([SESSION_ROLES_TOOL]);
  });

  it("tells an idea session its role", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("setIdea", { threadIds: ["thr_i"], idea: true });
    const resolved = await resolve(harness, "thr_i");
    expect(resolved.instructions).toBe(IDEA_INSTRUCTIONS);
    expect(resolved.tools).toEqual([]);
  });

  it("leaves an unmarked session alone, and drops the role once unmarked", async () => {
    const harness = await loadPlugin();
    expect(await resolve(harness, "thr_x")).toMatchObject({ instructions: null, tools: [] });
    await harness.behavior.callRpc("setOrchestrator", { threadIds: ["thr_x"], orchestrator: true });
    await harness.behavior.callRpc("setOrchestrator", { threadIds: ["thr_x"], orchestrator: false });
    expect(await resolve(harness, "thr_x")).toMatchObject({ instructions: null, tools: [] });
  });

  it("lists idea and orchestrator sessions for the orchestrator", async () => {
    const harness = await loadPlugin();
    const threads = [
      makeThreadResponse({ id: "thr_i", title: "Ticket ideas" }),
      makeThreadResponse({ id: "thr_o", title: "Dispatcher" }),
    ];
    harness.inspection.sdk.stub("threads.list", async (args: { threadIds?: string[] }) =>
      threads.filter((thread) => args.threadIds?.includes(thread.id)),
    );
    await harness.behavior.callRpc("setIdea", { threadIds: ["thr_i"], idea: true });
    await harness.behavior.callRpc("setOrchestrator", { threadIds: ["thr_o"], orchestrator: true });
    const output = JSON.parse(String(await harness.behavior.callAgentTool(SESSION_ROLES_TOOL, {})));
    expect(output.ideaSessions.map((row: { id: string }) => row.id)).toEqual(["thr_i"]);
    expect(output.orchestratorSessions.map((row: { title: string }) => row.title)).toEqual(["Dispatcher"]);
  });
});
