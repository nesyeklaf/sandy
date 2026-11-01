// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { inbox, SETTLED_NOTHING, thread, listProps, parkingActions, parkFromCard, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  describe.each(parkingActions)("%s navigation", (action) => {
    it.each([false, true])(
      "opens a project-scoped composer when Pinned and Active are empty after the action, with the last thread pinned: %s",
      async (isPinned) => {
        const storedSettings = {
          ...DEFAULT_SIDEBAR_SETTINGS,
          ...{ inactiveThreadsEnabled: true, inactiveAfterHours: 6 },
        };
        localStorage.setItem("sandy-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

        const now = Date.now();
        const rendered = renderSlot(
          inbox,
          { ...listProps, activeThreadId: "only" },
          {
            sidebarThreads: {
              status: "ready",
              threads: [
                thread({ id: "only", title: "Only thread", updatedAt: now, isPinned }),
                thread({ id: "inactive", title: "Inactive thread" }),
                thread({ id: "parked", title: "Parked thread" }),
                thread({ id: "snoozed", title: "Snoozed thread" }),
                thread({ id: "settled", title: "Settled thread" }),
              ],
              projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
            },
            rpc: {
              getSidebarSettings: () => storedSettings,
              listLifecycle: () => ({
                rows: [
                  { threadId: "parked", parkedAt: now, settledAt: null, snoozedUntil: null, snoozedAt: null },
                  { threadId: "snoozed", settledAt: null, snoozedUntil: now + 60_000, snoozedAt: now },
                  { threadId: "settled", settledAt: now, snoozedUntil: null, snoozedAt: null },
                ],
              }),
              [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
            },
          },
        );

        await screen.findByRole("region", { name: "Settled" });
        const current = screen.getByText("Only thread").closest("li")!;
        await parkFromCard(current, action);
        await waitFor(() =>
          expect(rendered.navigateCalls).toContainEqual({
            method: "toCompose",
            options: { projectId: "proj_1", focusPrompt: true },
          }),
        );
      },
    );
  });
});
