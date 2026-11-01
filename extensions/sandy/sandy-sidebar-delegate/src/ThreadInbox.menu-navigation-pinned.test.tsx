// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, SETTLED_NOTHING, thread, listProps, parkingActions, parkFromCard, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  describe.each(parkingActions)("%s navigation", (action) => {
    it.each([
      ["current", "first-pin"],
      ["first-pin", "second-pin"],
    ])("leaving %s selects %s before Active, using the full pinned order", async (currentId, expectedId) => {
      localStorage.setItem("sandy-sidebar:active-sort:v1", "created");
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: currentId },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "first-pin", title: "First pin", isPinned: true, createdAt: 10 }),
              thread({ id: "second-pin", title: "Second pin", isPinned: true, createdAt: 100 }),
              thread({ id: "current", title: "Current", createdAt: 20 }),
              thread({ id: "active", title: "First active", createdAt: 200 }),
            ],
            projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      const pinned = await screen.findByRole("region", { name: "Pinned" });
      fireEvent.click(within(pinned).getByRole("button", { expanded: true }));
      const current = screen.getByText(currentId === "current" ? "Current" : "First pin").closest("li")!;
      await parkFromCard(current, action);
      await waitFor(() =>
        expect(rendered.navigateCalls).toContainEqual({
          method: "toThread",
          threadId: expectedId,
        }),
      );
    });

    it("selects the first Active thread when leaving the last Pinned thread", async () => {
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: "pinned" },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "pinned", title: "Last pin", isPinned: true }),
              thread({ id: "first", title: "First active", createdAt: 20 }),
              thread({ id: "last", title: "Last active", createdAt: 10 }),
            ],
            projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      const pinned = await screen.findByRole("region", { name: "Pinned" });
      await parkFromCard(within(pinned).getByText("Last pin").closest("li")!, action);
      await waitFor(() =>
        expect(rendered.navigateCalls).toContainEqual({
          method: "toThread",
          threadId: "first",
        }),
      );
    });
  });
});
