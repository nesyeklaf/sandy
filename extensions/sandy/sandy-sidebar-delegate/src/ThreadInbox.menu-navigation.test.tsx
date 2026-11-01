// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import {
  inbox,
  SETTLED_NOTHING,
  thread,
  listProps,
  render,
  deferred,
  toastMocks,
  parkingActions,
  parkFromMenu,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  it("navigates when the host omits split for a compact or focused thread", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "compact", title: "Compact thread" })],
        projects: [],
      },
      threadActions: () => [],
    });
    fireEvent.contextMenu(await screen.findByText("Compact thread"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Open in split"));
    expect(rendered.navigateCalls).toEqual([{ method: "toThread", threadId: "compact", options: { split: true } }]);
    expect(rendered.threadActionCalls).toEqual([]);
    expect(rendered.sdkCalls).toEqual([]);
  });

  it("offers the plugin's own thread actions on right-click", async () => {
    render([thread({ id: "thr_menu", title: "Right click me" })]);
    const row = await screen.findByText("Right click me");
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    // The plugin builds this menu itself — the SDK ships no menu component —
    // so the items are this plugin's choice, backed by the action hook.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Open in split",
      "Parent",
      "Move to project…",
      "Repo",
      "Pin",
      "Snooze",
      "Park thread",
      "Settle",
      "Rename",
      "Regenerate title",
      "Mark unread",
      "Copy",
      "Archive",
      "Delete",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(4);
  });

  it("reminds the user what settling released and what it left running", async () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "only" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "only", title: "Only thread" })],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          settle: () => ({
            ok: true,
            reclaim: {
              closedTerminals: 1,
              keptTerminals: 2,
              stoppedRuntime: true,
            },
          }),
        },
      },
    );

    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Thread settled",
        expect.objectContaining({
          description: "Agent session stopped · closed 1 terminal nobody used · 2 terminals left running",
          duration: 10_000,
        }),
      ),
    );
  });

  it.each(parkingActions)("does not override navigation while %s is in flight", async (action) => {
    const pendingSettle = deferred<{ ok: true; reclaim: typeof SETTLED_NOTHING }>();
    const props = { ...listProps, activeThreadId: "slow" };
    const rendered = renderSlot(inbox, props, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "slow", title: "Slow settle", createdAt: 20 }),
          thread({ id: "elsewhere", title: "Elsewhere", createdAt: 10 }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        [action]: () => pendingSettle.promise,
      },
    });

    await parkFromMenu(await screen.findByText("Slow settle"), action);
    await waitFor(() => expect(rendered.rpcCalls.filter((call) => call.method === action)).toHaveLength(1));
    const InboxComponent = inbox.component;
    rendered.rerender(<InboxComponent {...props} activeThreadId="elsewhere" />);
    pendingSettle.resolve({ ok: true, reclaim: SETTLED_NOTHING });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
    expect(rendered.navigateCalls.filter((call) => call.method === "toThread" || call.method === "toCompose")).toEqual(
      [],
    );
  });
});
