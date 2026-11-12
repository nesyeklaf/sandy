// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";
import { STORAGE_KEYS } from "./lib/storage-keys";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("Compact project display", () => {
  it.each(["comfortable", "compact", "dense"] as const)(
    "updates project names without hiding icons or changing full cards (%s)",
    async (display) => {
      let settings = {
        ...defaultSidebarSettings,
        threadDensity: display,
        keepPinnedThreadsFull: true,
      };
      const view = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          projects: [{ id: "proj_1", name: "Sidebar project", isPersonal: false, href: "", settingsHref: "" }],
          threads: [
            thread({ id: "working", title: "Working thread", indicator: "runtime", indicatorLabel: "Working" }),
            thread({ id: "pinned", title: "Full pinned thread", isPinned: true }),
            thread({ id: "parked", title: "Parked thread" }),
          ],
        },
        rpc: {
          getSidebarSettings: () => settings,
          listLifecycle: () => ({ rows: [{ threadId: "parked", parkedAt: Date.now() }] }),
        },
      });
      fireEvent.click(await screen.findByRole("button", { name: "Snoozed (1)" }));
      const row = (title: string) => screen.getByText(title).closest("li")!;
      await waitFor(() => {
        expect(row("Working thread").querySelector("[data-row-density]")?.getAttribute("data-row-density")).toBe(
          display,
        );
        expect(screen.getByText("Parked thread")).toBeDefined();
      });

      for (const compactProjectIconOnly of [true, false]) {
        settings = { ...settings, compactProjectIconOnly };
        await view.emitRealtime("sidebar-settings", {});
        await waitFor(() => {
          for (const title of ["Working thread", "Full pinned thread", "Parked thread"]) {
            const card = row(title);
            const iconOnly =
              title === "Working thread" && (display === "dense" || (compactProjectIconOnly && display === "compact"));
            expect(within(card).getByText("Sidebar project").classList.contains("sr-only")).toBe(iconOnly);
            expect(card.querySelector("[data-letter]")).not.toBeNull();
            if (iconOnly) expect(within(card).queryByText("·")).toBeNull();
            else if (title === "Parked thread") expect(within(card).getByText("·")).toBeDefined();
          }
        });
      }
    },
  );

  it("shows only the project icon in dense rows and gives the title the width", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects: [{ id: "proj_1", name: "Sidebar project", isPersonal: false, href: "", settingsHref: "" }],
        threads: [
          thread({ id: "waiting", title: "Birch implementation" }),
          thread({ id: "pinned", title: "Atlas planning", isPinned: true }),
        ],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          threadDensity: "dense",
          compactProjectIconOnly: false,
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    await waitFor(() => {
      for (const title of ["Birch implementation", "Atlas planning"]) {
        const row = screen.getByText(title).closest("li")!;
        expect(row.querySelector("[data-row-density]")?.getAttribute("data-row-density")).toBe("dense");
        expect(row.querySelector("[data-letter]")).not.toBeNull();
        expect(within(row).getByText("Sidebar project").classList.contains("sr-only")).toBe(true);
        expect(within(row).queryByText("·")).toBeNull();
      }
    });
  });

  it("limits icon-only projects to Idle, Pinned, and Working when all cards are compact", async () => {
    const now = Date.now();
    localStorage.setItem(STORAGE_KEYS.showArchived.key, "true");
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects: [{ id: "proj_1", name: "Sidebar project", isPersonal: false, href: "", settingsHref: "" }],
        threads: [
          thread({ id: "active", title: "Active thread", updatedAt: now }),
          thread({ id: "pinned", title: "Pinned thread", isPinned: true, updatedAt: now }),
          thread({ id: "working", title: "Working thread", indicator: "runtime", updatedAt: now }),
          thread({ id: "inactive", title: "Inactive thread", updatedAt: now - 7 * 60 * 60_000 }),
          thread({ id: "parked", title: "Parked thread", updatedAt: now }),
          thread({ id: "snoozed", title: "Snoozed thread", updatedAt: now }),
          thread({ id: "settled", title: "Settled thread", updatedAt: now }),
        ],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          threadDensity: "dense",
          compactProjectIconOnly: true,
        }),
        listLifecycle: () => ({
          rows: [
            { threadId: "parked", parkedAt: now, settledAt: null, snoozedAt: null, snoozedUntil: null },
            { threadId: "snoozed", settledAt: null, snoozedAt: now, snoozedUntil: now + 86_400_000 },
            { threadId: "settled", settledAt: now, snoozedAt: null, snoozedUntil: null },
          ],
        }),
      },
    });
    for (const shelf of ["Snoozed", "Archived"]) {
      const region = await screen.findByRole("region", { name: shelf });
      const collapsed = within(region).queryByRole("button", { name: new RegExp(`^${shelf} \\(`), expanded: false });
      if (collapsed) fireEvent.click(collapsed);
    }
    await waitFor(() => {
      for (const [shelf, title] of [
        ["Idle", "Active"],
        ["Idle", "Inactive"],
        ["Pinned", "Pinned"],
        ["Working", "Working"],
        ["Snoozed", "Parked"],
        ["Snoozed", "Snoozed"],
        ["Archived", "Settled"],
      ] as const) {
        const region = screen.getByRole("region", { name: shelf });
        const row = within(region).getByText(`${title} thread`).closest("li")!;
        const iconOnly = ["Idle", "Pinned", "Working"].includes(shelf);
        expect(row.querySelector(".h-8")).not.toBeNull();
        expect(row.querySelector("[data-letter]")).not.toBeNull();
        expect(within(row).getByText("Sidebar project").classList.contains("sr-only")).toBe(iconOnly);
        expect(within(row).queryByText("·") !== null).toBe(!iconOnly);
      }
    });
  });
});
