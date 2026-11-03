import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { renderSlot } from "./test-slot";
import { ANSWER_HOLD_MS } from "./answer-hold";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp, toastMocks } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const branchQuestion = {
  id: "int_q",
  threadId: "thr_ask",
  status: "pending",
  statusReason: null,
  createdAt: 10,
  resolvedAt: null,
  turnId: "turn_1",
  providerId: "codex",
  providerThreadId: "p_1",
  providerRequestId: "r_1",
  payload: {
    kind: "user_question",
    questions: [
      {
        id: "branch",
        prompt: "Create a branch?",
        multiSelect: false,
        allowFreeText: false,
        required: true,
        options: [
          { value: "yes", label: "Yes, create feat/login" },
          { value: "no", label: "No, work on main" },
        ],
      },
    ],
  },
};

const approval = {
  ...branchQuestion,
  id: "int_a",
  payload: {
    kind: "approval",
    reason: "Delete the build folder",
    availableDecisions: ["allow_once", "deny"],
    subject: { kind: "command", itemId: "i", command: "rm -rf build", cwd: null, actions: [], sessionGrant: null },
  },
};

function renderAsking(
  threads: PluginSidebarThread[],
  interactions: unknown[] = [branchQuestion],
  threadDensity: "comfortable" | "compact" | "dense" = "comfortable",
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads,
      projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
    },
    sdk: { threads: { interactions: { list: async () => interactions, resolve: async () => ({}) } } } as never,
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getSidebarSettings: () => ({ ...defaultSidebarSettings, threadDensity }),
    },
  });
}

const asking = thread({
  id: "thr_ask",
  title: "Login flow",
  hasPendingInteraction: true,
  indicator: "waiting-for-input",
});
const resolveCalls = (rendered: ReturnType<typeof renderAsking>) =>
  rendered.sdkCalls.filter((call) => call.method === "threads.interactions.resolve");

describe("answer in the row", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the answer for a few seconds and sends it once the hold runs out", async () => {
    const rendered = renderAsking([asking]);
    const group = await screen.findByRole("group", { name: "Answer Login flow" });
    expect(screen.getByText("Create a branch?")).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.click(within(group).getByRole("button", { name: "No, work on main" }));
    expect(within(group).getByText("Answered “No, work on main”")).toBeTruthy();
    act(() => vi.advanceTimersByTime(ANSWER_HOLD_MS - 1));
    expect(resolveCalls(rendered)).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(resolveCalls(rendered)).toEqual([
      {
        method: "threads.interactions.resolve",
        args: [
          {
            threadId: "thr_ask",
            interactionId: "int_q",
            resolution: { kind: "user_answer", answers: { branch: { selected: ["no"] } } },
          },
        ],
      },
    ]);
  });

  it("drops the answer when Undo is pressed within the hold", async () => {
    const rendered = renderAsking([asking]);
    const group = await screen.findByRole("group", { name: "Answer Login flow" });
    vi.useFakeTimers();
    fireEvent.click(within(group).getByRole("button", { name: "Yes, create feat/login" }));
    const [message, options] = toastMocks.success.mock.calls.at(-1)! as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("Answered “Yes, create feat/login”");
    expect(options.action.label).toBe("Undo");
    act(() => options.action.onClick());
    expect(within(group).getByRole("button", { name: "Yes, create feat/login" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(ANSWER_HOLD_MS * 2));
    expect(resolveCalls(rendered)).toEqual([]);
  });

  it("snoozes the thread for an hour on Later", async () => {
    const rendered = renderAsking([asking]);
    const group = await screen.findByRole("group", { name: "Answer Login flow" });
    const before = Date.now();
    fireEvent.click(within(group).getByRole("button", { name: "Later" }));
    await waitFor(() => expect(rendered.rpcCalls.filter((call) => call.method === "snooze")).toHaveLength(1));
    const call = rendered.rpcCalls.find((entry) => entry.method === "snooze")!;
    const until = (call.input as { snoozedUntil: number }).snoozedUntil;
    expect(until - before).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(until - before).toBeLessThan(60 * 60 * 1000 + 60_000);
  });

  it("offers only Open for an approval", async () => {
    renderAsking([asking], [approval]);
    const group = await screen.findByRole("group", { name: "Answer Login flow" });
    expect(screen.getByText("Delete the build folder")).toBeTruthy();
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Open", "Later"]);
  });

  it("shows a folded child's question in the parent row", async () => {
    const parent = thread({ id: "thr_parent", title: "Release" });
    const child = { ...asking, title: "Branch check: login", parentThreadId: "thr_parent" };
    renderAsking([parent, child]);
    const group = await screen.findByRole("group", { name: "Answer Branch check: login" });
    expect(group.closest("li")?.querySelector('a[data-sidebar-thread-id="thr_parent"]')).not.toBeNull();
    expect(screen.getByText("Branch check:")).toBeTruthy();
  });

  it("keeps dense rows to one line", async () => {
    renderAsking([asking], [branchQuestion], "dense");
    await screen.findByRole("link", { name: "Login flow" });
    await waitFor(() => expect(document.querySelector('[data-row-density="dense"]')).not.toBeNull());
    expect(screen.queryByRole("group", { name: "Answer Login flow" })).toBeNull();
  });
});
