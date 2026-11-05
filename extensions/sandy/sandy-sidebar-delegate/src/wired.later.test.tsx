// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createWired } from "./test-wired";
import { loadInboxApp, thread } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

const question = (id: string, threadId: string) => ({
  id,
  threadId,
  status: "pending" as const,
  statusReason: null,
  createdAt: 10,
  resolvedAt: null,
  turnId: "turn_1",
  providerId: "codex",
  providerThreadId: "p_1",
  providerRequestId: `r_${id}`,
  payload: {
    kind: "user_question" as const,
    questions: [
      {
        id: "branch",
        prompt: "Create a branch?",
        multiSelect: false,
        allowFreeText: false,
        required: true,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    ],
  },
});

const asking = (id: string, extra: Parameters<typeof thread>[0] = {}) =>
  thread({
    id,
    title: `Ask ${id}`,
    updatedAt: Date.now(),
    hasPendingInteraction: true,
    indicator: "waiting-for-input",
    ...extra,
  });

async function later(wired: Awaited<ReturnType<typeof createWired>>) {
  const needs = await screen.findByRole("region", { name: "Needs you" });
  fireEvent.click(await within(needs).findByRole("button", { name: "Later" }));
  await waitFor(() => expect(wired.db.prepare("SELECT 1 FROM thread_lifecycle").all()).not.toHaveLength(0));
  await wired.flush();
  await screen.findByRole("region", { name: "Snoozed" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
}

it("Later snoozes a pending question until another question arrives", async () => {
  const wired = await createWired([asking("ask")], { interactions: { ask: [question("int_1", "ask")] as never } });
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  wired.mount();
  await later(wired);
  await wired.interactionPending("ask", question("int_2", "ask") as never);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeNull());
});

it("Later on a parent defers its child's question and a new child question wakes the parent", async () => {
  const wired = await createWired(
    [thread({ id: "parent", title: "Release", updatedAt: Date.now() }), asking("child", { parentThreadId: "parent" })],
    { interactions: { child: [question("int_1", "child")] as never } },
  );
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  wired.mount();
  await later(wired);
  await wired.interactionPending("child", question("int_2", "child") as never);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeNull());
});

it("Later moves a question from an active turn out of Needs you", async () => {
  const wired = await createWired([asking("ask", { status: "active", runtimeStatus: "active" })], {
    interactions: { ask: [question("int_1", "ask")] as never },
  });
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  wired.mount();
  await later(wired);
});

it("Later on a parent moves its child's active-turn question out of Needs you", async () => {
  const wired = await createWired(
    [
      thread({ id: "parent", title: "Release", updatedAt: Date.now() }),
      asking("child", { parentThreadId: "parent", status: "active", runtimeStatus: "active" }),
    ],
    { interactions: { child: [question("int_1", "child")] as never } },
  );
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  wired.mount();
  await later(wired);
});

async function laterKeepsTreeActive(wired: Awaited<ReturnType<typeof createWired>>) {
  await wired.call("updateSidebarSettings", { autoSettleInactive: false });
  wired.mount();
  const needs = await screen.findByRole("region", { name: "Needs you" });
  fireEvent.click(await within(needs).findByRole("button", { name: "Later" }));
  await waitFor(() => expect(wired.db.prepare("SELECT 1 FROM thread_lifecycle").all()).toHaveLength(1));
  await wired.flush();
  expect(screen.queryByRole("region", { name: "Snoozed" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeNull();
}

it("Later on a child's question keeps the parent's own running turn active", async () => {
  const wired = await createWired(
    [
      thread({
        id: "parent",
        title: "Running parent",
        status: "active",
        runtimeStatus: "active",
        indicator: "runtime",
        updatedAt: Date.now(),
      }),
      asking("child", { parentThreadId: "parent", status: "active", runtimeStatus: "active" }),
    ],
    { interactions: { child: [question("int_child", "child")] as never } },
  );
  await laterKeepsTreeActive(wired);
});

it("Later on a waiting parent keeps its child's background command active", async () => {
  const wired = await createWired(
    [
      asking("parent", { status: "active", runtimeStatus: "active" }),
      thread({
        id: "child",
        title: "Background task",
        parentThreadId: "parent",
        activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 1, planMode: 0, goals: 0 },
      }),
    ],
    { interactions: { parent: [question("int_parent", "parent")] as never } },
  );
  await laterKeepsTreeActive(wired);
});
