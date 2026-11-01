// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { inbox, SETTLED_NOTHING, thread, listProps, parkFromMenu, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  describe.each([
    ["Parked", "settle"],
    ["Parked", "snooze"],
    ["Snoozed", "settle"],
    ["Snoozed", "park"],
    ["Settled", "snooze"],
    ["Settled", "park"],
  ] as const)("%s compact card: %s", (shelf, action) => {
    it.each(["pinned", "active", "empty"])("follows the same navigation with %s candidates", async (destination) => {
      const storedSettings = {
        ...DEFAULT_SIDEBAR_SETTINGS,
        ...{ inactiveThreadsEnabled: true, inactiveAfterHours: 6 },
      };
      localStorage.setItem("sandy-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

      const now = Date.now();
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: "current" },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "current", title: "Current" }),
              ...(destination === "pinned"
                ? [
                    thread({ id: "first-pin", title: "First pin", isPinned: true }),
                    thread({ id: "second-pin", title: "Second pin", isPinned: true }),
                  ]
                : []),
              ...(destination !== "empty"
                ? [
                    thread({ id: "first-active", title: "First active", updatedAt: now, createdAt: 200 }),
                    thread({ id: "last-active", title: "Last active", updatedAt: now, createdAt: 100 }),
                  ]
                : []),
              thread({ id: "inactive", title: "Inactive" }),
            ],
            projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            getSidebarSettings: () => storedSettings,
            listLifecycle: () => ({
              rows: [
                {
                  threadId: "current",
                  parkedAt: shelf === "Parked" ? now : null,
                  settledAt: shelf === "Settled" ? now : null,
                  snoozedUntil: shelf === "Snoozed" ? now + 60_000 : null,
                  snoozedAt: shelf === "Snoozed" ? now : null,
                },
              ],
            }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      const region = await screen.findByRole("region", { name: shelf });
      await parkFromMenu(within(region).getByText("Current"), action);
      await waitFor(() =>
        expect(rendered.navigateCalls).toEqual([
          destination === "empty"
            ? { method: "toCompose", options: { projectId: "proj_1", focusPrompt: true } }
            : { method: "toThread", threadId: destination === "pinned" ? "first-pin" : "first-active" },
        ]),
      );
    });
  });
});
