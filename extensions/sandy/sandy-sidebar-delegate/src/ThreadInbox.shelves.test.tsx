// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { inbox, defaultSidebarSettings, thread, listProps, deferred, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();
beforeEach(() => localStorage.setItem(STORAGE_KEYS.showArchived.key, "true"));

describe("parking threads", () => {
  it("shows the wake countdown on a snoozed row", async () => {
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later" })],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_snz",
              settledAt: null,
              snoozedUntil: wakeAt,
              snoozedAt: Date.now(),
            },
          ],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("2h")).toBeDefined();
    expect(within(shelf).getByLabelText("sandy · Later")).toBeDefined();
    expect(within(shelf).getByText("sandy").className).toContain("text-muted-foreground/50");
    expect(within(shelf).getByText("·").className).toContain("text-sm");
    expect(within(shelf).getByText("Later").className).toContain("text-foreground/80");
    expect(within(shelf).getByLabelText("Wake thread now")).toBeDefined();
  });

  it("persists each shelf's expanded state across remounts", async () => {
    const storedSettings = {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...{
      },
    };
    localStorage.setItem("sandy-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

    const now = Date.now();
    const rows = [
      {
        threadId: "thr_done",
        settledAt: 200,
        snoozedUntil: null,
        snoozedAt: null,
      },
      {
        threadId: "thr_later",
        settledAt: null,
        snoozedUntil: now + 60_000,
        snoozedAt: now,
      },
    ];
    const options = {
      sidebarThreads: {
        status: "ready" as const,
        threads: [
          thread({ id: "thr_active", title: "Active work", updatedAt: now }),
          thread({ id: "thr_done", title: "Finished work" }),
          thread({ id: "thr_later", title: "Later work" }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { getSidebarSettings: () => storedSettings, listLifecycle: () => ({ rows }) },
    };

    renderSlot(inbox, listProps, options);
    let activeShelf = screen.getByRole("region", { name: "Waiting" });
    let settledShelf = await screen.findByRole("region", { name: "Archived" });
    let snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(activeShelf).getByRole("button", { name: /^Waiting/, expanded: true }));
    fireEvent.click(within(settledShelf).getByRole("button", { expanded: false }));
    fireEvent.click(within(snoozedShelf).getByRole("button"));
    expect(within(activeShelf).queryByText("Active work")).toBeNull();
    expect(within(settledShelf).getByText("Finished work")).toBeDefined();
    expect(within(snoozedShelf).getByText("Later work")).toBeDefined();

    cleanup();
    renderSlot(inbox, listProps, options);
    activeShelf = screen.getByRole("region", { name: "Waiting" });
    settledShelf = await screen.findByRole("region", { name: "Archived" });
    snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    expect(within(activeShelf).getByRole("button", { name: /^Waiting/, expanded: false })).toBeDefined();
    expect(within(settledShelf).getByRole("button", { expanded: true })).toBeDefined();
    expect(within(snoozedShelf).getByRole("button", { expanded: true })).toBeDefined();
    expect(within(activeShelf).queryByText("Active work")).toBeNull();
    expect(within(settledShelf).getByText("Finished work")).toBeDefined();
    expect(within(snoozedShelf).getByText("Later work")).toBeDefined();
  });

  it("does not flash settled threads as Waiting after an app restart", async () => {
    const now = Date.now();
    const pendingSettings = deferred<typeof defaultSidebarSettings>();
    const pendingLifecycle = deferred<{
      rows: Array<{
        threadId: string;
        settledAt: number;
        snoozedUntil: null;
        snoozedAt: null;
      }>;
    }>();
    const props = { ...listProps };
    const sidebarThreads = {
      status: "ready" as const,
      threads: [
        thread({ id: "settled", title: "Settled work" }),
      ],
      projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
    };
    renderSlot(inbox, props, {
      sidebarThreads,
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listLifecycle: () => ({
          rows: [
            {
              threadId: "settled",
              settledAt: now,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });

    await screen.findByRole("region", { name: "Archived" });
    cleanup();

    renderSlot(inbox, props, {
      sidebarThreads,
      rpc: {
        getSidebarSettings: () => pendingSettings.promise,
        listLifecycle: () => pendingLifecycle.promise,
      },
    });

    const settledShelf = screen.getByRole("region", { name: "Archived" });
    expect(within(settledShelf).getByRole("button", { expanded: false })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Waiting" })).toBeNull();
    expect(screen.queryByText("Settled work")).toBeNull();
  });

  it("keeps the currently open parked row visible while collapsed", async () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "thr_open" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_open", title: "Open but settled" })],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: [
              {
                threadId: "thr_open",
                settledAt: 200,
                snoozedUntil: null,
                snoozedAt: null,
              },
            ],
          }),
        },
      },
    );

    const shelf = await screen.findByRole("region", { name: "Archived" });
    expect(within(shelf).getByRole("button", { expanded: false })).toBeDefined();
    expect(within(shelf).getByText("Open but settled")).toBeDefined();
  });

  it("sorts snoozed rows by soonest wake and settled rows by settle time", async () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "later", title: "Later wake", createdAt: 100 }),
          thread({ id: "sooner", title: "Sooner wake", createdAt: 1 }),
          thread({ id: "old-settle", title: "Older settle", createdAt: 999 }),
          thread({ id: "new-settle", title: "Newer settle", createdAt: 1 }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            { threadId: "later", settledAt: null, snoozedUntil: now + 5_000, snoozedAt: now },
            { threadId: "sooner", settledAt: null, snoozedUntil: now + 1_000, snoozedAt: now },
            { threadId: "old-settle", settledAt: 500, snoozedUntil: null, snoozedAt: null },
            { threadId: "new-settle", settledAt: 900, snoozedUntil: null, snoozedAt: null },
          ],
        }),
      },
    });

    const snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    const settledShelf = await screen.findByRole("region", { name: "Archived" });
    fireEvent.click(within(snoozedShelf).getByRole("button"));
    fireEvent.click(within(settledShelf).getByRole("button", { expanded: false }));
    expect(
      within(snoozedShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Sooner wake"), expect.stringContaining("Later wake")]);
    expect(
      within(settledShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Newer settle"), expect.stringContaining("Older settle")]);
  });

  it("shows 10 settled rows initially and loads 25 more at a time", async () => {
    const threads = Array.from({ length: 36 }, (_, index) =>
      thread({ id: `settled-${index}`, title: `Settled ${index}` }),
    );
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: threads.map((candidate, index) => ({
            threadId: candidate.id,
            settledAt: 1_000 - index,
            snoozedUntil: null,
            snoozedAt: null,
          })),
        }),
      },
    });

    const shelf = await screen.findByRole("region", { name: "Archived" });
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 25 more" }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(35);
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 1 more" }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(36);
    expect(within(shelf).queryByText(/Load .* more/)).toBeNull();
  });
});

describe("B4 shelf classification", () => {
  const projects = [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }];

  it("classifies live work into Working with default settings", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "busy", title: "Busy", status: "active", indicator: "runtime" })],
        projects,
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    await screen.findByRole("link", { name: "Busy" });
    expect(within(screen.getByRole("region", { name: "Working" })).getByRole("link", { name: "Busy" })).toBeDefined();
  });

  it("rolls a failed child into the Failed shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Root" }),
          thread({ id: "child", title: "Broken", parentThreadId: "parent", status: "error", indicator: "unread-error" }),
        ],
        projects,
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    await screen.findByRole("link", { name: "Root" });
    expect(within(screen.getByRole("region", { name: "Failed" })).getByRole("link", { name: "Root" })).toBeDefined();
  });

  it("keeps a question ahead of a failed child", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Root" }),
          thread({ id: "broken", title: "Broken", parentThreadId: "parent", status: "error", indicator: "unread-error" }),
          thread({
            id: "asking",
            title: "Asking",
            parentThreadId: "parent",
            hasPendingInteraction: true,
            indicator: "waiting-for-input",
          }),
        ],
        projects,
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByRole("link", { name: "Root" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Failed" })).toBeNull();
  });
});
