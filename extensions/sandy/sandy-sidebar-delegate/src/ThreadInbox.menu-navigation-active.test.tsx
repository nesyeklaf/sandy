// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import {
  inbox,
  SETTLED_NOTHING,
  thread,
  listProps,
  deferred,
  toastMocks,
  parkingActions,
  parkFromCard,
  parkFromMenu,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  describe.each(parkingActions)("%s navigation", (action) => {
    it("updates another thread from the context menu without changing the open thread", async () => {
      let settled: string | null = null;
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: "open" },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "thr_settle", title: "Settle from menu" }),
              thread({ id: "open", title: "Stay here" }),
            ],
            projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            [action]: (input) => {
              settled = (input as { threadId: string }).threadId;
              return { ok: true, reclaim: SETTLED_NOTHING };
            },
          },
        },
      );

      await parkFromMenu(await screen.findByText("Settle from menu"), action);
      await waitFor(() => expect(settled).toBe("thr_settle"));
      await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
      expect([
        ...rendered.navigateCalls,
        ...rendered.sdkCalls,
        ...rendered.splitSourceCalls,
        ...rendered.threadActionCalls,
      ]).toEqual([]);
    });

    it("opens the next Active thread when leaving its first row", async () => {
      let navigated = 0;
      const rendered = renderSlot(
        inbox,
        {
          ...listProps,
          activeThreadId: "current",
          onNavigate: () => (navigated += 1),
        },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "current", title: "Current", createdAt: 20 }),
              thread({ id: "next", title: "Next", createdAt: 10 }),
            ],
            projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      await parkFromMenu(await screen.findByText("Current"), action);
      await waitFor(() =>
        expect(rendered.navigateCalls).toContainEqual({
          method: "toThread",
          threadId: "next",
        }),
      );
      expect(navigated).toBe(1);
    });

    it.each([
      ["manual", "manual", false],
      ["manual", "manual", true],
      ["created", "created", true],
      ["activity", "activity", true],
      // The first project unit always starts with the first manual thread.
      ["project", "manual", true],
    ] as const)(
      "leaving a thread in %s order opens %s first with Active collapsed: %s",
      async (mode, expectedId, collapsed) => {
        localStorage.setItem("sandy-sidebar:active-sort:v1", mode);
        const order = ["manual", "current", "created", "activity", "project"];
        localStorage.setItem("sandy-sidebar:inbox-order-cache:v1", JSON.stringify(order));
        const rendered = renderSlot(
          inbox,
          { ...listProps, activeThreadId: "current" },
          {
            sidebarThreads: {
              status: "ready",
              threads: [
                thread({ id: "current", title: "Current", createdAt: 50, updatedAt: 50 }),
                thread({ id: "manual", title: "Manual first", createdAt: 20, updatedAt: 20 }),
                thread({ id: "created", title: "Newest first", createdAt: 100, updatedAt: 100 }),
                thread({ id: "activity", title: "Recent first", createdAt: 10, updatedAt: 200 }),
                thread({ id: "project", title: "Alpha first", projectId: "alpha", createdAt: 5 }),
              ],
              projects: [
                { id: "proj_1", name: "Zulu", isPersonal: false, href: "", settingsHref: "" },
                { id: "alpha", name: "Alpha", isPersonal: false, href: "", settingsHref: "" },
              ],
            },
            rpc: {
              listLifecycle: () => ({ rows: [] }),
              listInboxOrder: () => ({ inboxThreadIds: order }),
              [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
            },
          },
        );

        const active = await screen.findByRole("region", { name: "Needs you" });
        if (collapsed) {
          fireEvent.click(within(active).getByRole("button", { name: "Needs you", expanded: true }));
        }
        const current = within(active).getByText("Current").closest("li")!;
        await parkFromCard(current, action);
        await waitFor(() =>
          expect(rendered.navigateCalls).toContainEqual({
            method: "toThread",
            threadId: expectedId,
          }),
        );
      },
    );

    it("uses the remaining Active threads when the first one settles elsewhere during the request", async () => {
      const pendingSettle = deferred<{ ok: true; reclaim: typeof SETTLED_NOTHING }>();
      let firstSettled = false;
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: "current" },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "first", title: "First active", createdAt: 30 }),
              thread({ id: "second", title: "Second active", createdAt: 20 }),
              thread({ id: "current", title: "Current", createdAt: 10 }),
            ],
            projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({
              rows: firstSettled
                ? [{ threadId: "first", settledAt: Date.now(), snoozedUntil: null, snoozedAt: null }]
                : [],
            }),
            [action]: () => pendingSettle.promise,
          },
        },
      );
      const current = (await screen.findByText("Current")).closest("li")!;
      await parkFromCard(current, action);
      await waitFor(() => expect(rendered.rpcCalls.some((call) => call.method === action)).toBe(true));

      firstSettled = true;
      await rendered.emitRealtime("lifecycle", {});
      await waitFor(() =>
        expect(within(screen.getByRole("region", { name: "Needs you" })).queryByText("First active")).toBeNull(),
      );
      pendingSettle.resolve({ ok: true, reclaim: SETTLED_NOTHING });
      await waitFor(() =>
        expect(rendered.navigateCalls).toContainEqual({
          method: "toThread",
          threadId: "second",
        }),
      );
    });
  });
});
