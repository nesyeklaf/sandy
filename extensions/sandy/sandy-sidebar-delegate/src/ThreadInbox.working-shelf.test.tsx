// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { isWorkingTree } from "./working-tree";
import { STORAGE_KEYS } from "./lib/storage-keys";
import {
  inbox,
  SETTLED_NOTHING,
  defaultSidebarSettings,
  thread,
  listProps,
  toastMocks,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();
beforeEach(() => localStorage.setItem(STORAGE_KEYS.showArchived.key, "true"));

describe("parking threads", () => {
  it("moves a settled thread to the Settled shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Finished work" })],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_done",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    // The shelf renders once the lifecycle read resolves.
    const shelf = await screen.findByRole("region", { name: "Archived" });
    expect(within(shelf).getByText(/Archived \(1\)/)).toBeDefined();
    // Collapsed by default: parked work is out of the way, never gone.
    expect(screen.queryByText("Finished work")).toBeNull();
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
    expect(within(shelf).getByText("Finished work")).toBeDefined();
    expect(within(shelf).getByRole("listitem").textContent).toMatch(/sandy\s*·\s*Finished work/);
    expect(within(shelf).getByLabelText("sandy · Finished work")).toBeDefined();
  });

  it("keeps a working thread out of the shelves and offers no park action", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_busy",
            title: "Still running",
            indicator: "runtime",
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
          }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      // Settled in the store, but still working: it must stay visible.
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_busy",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    expect(await screen.findByText("Still running")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Archived" })).toBeNull();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it.each([
    [
      "an unread thread whose turn is still running",
      { status: "active" as const, indicator: "unread-success" as const },
    ],
    ["a message waiting to send", { queuedWork: "waiting" as const }],
    ["a message that failed to send", { queuedWork: "failed" as const }],
  ])("keeps %s out of the shelves and offers no park action", async (_, overrides) => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_busy", title: "Not done", ...overrides })],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_busy",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    expect(await screen.findByText("Not done")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Archived" })).toBeNull();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it("offers Park thread below the snooze times and allows parking again after Undo", async () => {
    const park = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING }));
    const resume = vi.fn(() => ({ ok: true }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }), park, resume },
    });
    // Rendered (not merely accepted as props): a card whose park controls
    // never mount leaves the whole feature unreachable.
    expect(await screen.findByLabelText("Settle thread")).toBeDefined();
    const snooze = screen.getByRole("combobox", { name: "Snooze thread" });
    expect(snooze.querySelector('[data-icon="Clock"]')).not.toBeNull();
    expect(snooze.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
    expect(snooze.classList.contains("[&>svg:last-child]:hidden")).toBe(true);
    expect(snooze.classList.contains("w-5")).toBe(true);
    fireEvent.keyDown(snooze, { key: "Enter" });
    expect(await screen.findByRole("option", { name: "1 hour" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Wait refresh (5 hours)" })).toBeDefined();
    expect(screen.getByRole("option", { name: "This evening" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Next week" })).toBeDefined();
    const menu = screen.getByRole("listbox");
    const parkOption = within(menu).getByRole("option", { name: "Park thread" });
    expect(within(menu).getAllByRole("option").at(-1)).toBe(parkOption);
    fireEvent.click(parkOption);
    await waitFor(() => expect(park).toHaveBeenCalledTimes(1));
    expect(rendered.rpcCalls).toContainEqual({ method: "park", input: { threadId: "thr_park" } });
    expect(rendered.rpcCalls.some((call) => call.method === "snooze" || call.method === "settle")).toBe(false);

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
    const undo = toastMocks.success.mock.calls.find(([message]) => message === "Thread parked")![1].action;
    act(() => undo.onClick());
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Park thread" }));
    await waitFor(() => expect(park).toHaveBeenCalledTimes(2));
  });

  it("keeps status rows actionable through snooze, settle, and unpin controls", async () => {
    const snooze = vi.fn(() => ({ ok: true }));
    const settle = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_failed",
            title: "Failed work",
            indicator: "unread-error",
            indicatorLabel: "Failed",
            isPinned: true,
          }),
          thread({
            id: "thr_unread",
            title: "Unread work",
            indicator: "unread-success",
            indicatorLabel: "Unread",
          }),
          thread({
            id: "thr_idle",
            title: "Idle work",
            updatedAt: Date.now() - 2 * 60_000,
          }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }), snooze, settle },
    });

    expect(within((await screen.findByText("Failed work")).closest("li")!).getByText("Failed")).toBeDefined();
    expect(screen.getByText("Unread")).toBeDefined();
    expect(screen.getByText(/^\d+m$/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Unpin Failed work" }));
    await waitFor(() =>
      expect(rendered.sdkCalls).toContainEqual({ method: "threads.unpin", args: [{ threadId: "thr_failed" }] }),
    );

    const unreadRow = screen.getByText("Unread work").closest("li")!;
    fireEvent.click(within(unreadRow).getByRole("button", { name: "Settle thread" }));
    await waitFor(() => expect(settle).toHaveBeenCalledWith({ threadId: "thr_unread" }));

    const idleRow = screen.getByText("Idle work").closest("li")!;
    fireEvent.keyDown(within(idleRow).getByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));
    await waitFor(() =>
      expect(snooze).toHaveBeenCalledWith({
        threadId: "thr_idle",
        snoozedUntil: expect.any(Number),
      }),
    );
  });

  it.each([false, true])(
    "draws working threads on two lines in Auto and quiet ones on one line (auto %s)",
    async (compactWorkingThreads) => {
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "busy", title: "Busy work", indicator: "runtime", indicatorLabel: "Working" }),
            thread({ id: "asking", title: "Asking work", indicator: "runtime", hasPendingInteraction: true }),
            thread({ id: "idle", title: "Idle work" }),
          ],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          // Fixture threads are old; keep them all in Active.
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            threadDensity: compactWorkingThreads ? "auto" : "comfortable",
            compactWorkingThreads,
          }),
          listLifecycle: () => ({ rows: [] }),
        },
      });
      const density = (title: string) =>
        screen.getByRole("link", { name: title }).closest("[data-parent-card]")!.getAttribute("data-row-density");
      await screen.findByRole("link", { name: "Busy work" });

      await waitFor(() => expect(density("Idle work")).toBe(compactWorkingThreads ? "dense" : "comfortable"));
      expect(density("Busy work")).toBe(compactWorkingThreads ? "compact" : "comfortable");
      expect(density("Asking work")).toBe("comfortable");
      const busy = screen.getByRole("link", { name: "Busy work" }).closest("[data-parent-card]") as HTMLElement;
      expect(within(busy).getByText("Working")).toBeDefined();
    },
  );

  it.each([false, true])("keeps a dense row's working children folded until expanded (dense %s)", async (dense) => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Parent work", indicator: "runtime" }),
          thread({ id: "child", parentThreadId: "parent", title: "Child work", indicator: "runtime" }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          showRunningChildrenWhenCollapsed: true,
          threadDensity: dense ? "dense" : "comfortable",
          compactWorkingThreads: dense,
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    await screen.findByRole("link", { name: "Parent work" });
    // The full card surfaces a working child; the one-line row does not.
    await waitFor(() => expect(screen.queryByText("Child work") === null).toBe(dense));

    if (dense) {
      fireEvent.click(screen.getByRole("button", { name: /1 child thread/ }));
      expect(await screen.findByText("Child work")).toBeDefined();
    }
  });

  it("keeps a row on two lines in Auto until its children and agents are done", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "waiting-on-child", title: "Waiting on child" }),
          thread({ id: "child", parentThreadId: "waiting-on-child", title: "Child work", indicator: "runtime" }),
          thread({ id: "asking", title: "Asking parent", hasPendingInteraction: true }),
          thread({ id: "asking-child", parentThreadId: "asking", title: "Asking child", indicator: "runtime" }),
          thread({
            id: "agent",
            title: "Agent parent",
            activity: { workflows: 0, backgroundAgents: 1, backgroundCommands: 0, planMode: 0, goals: 0 },
          }),
          thread({ id: "done", title: "Done parent" }),
          thread({ id: "done-child", parentThreadId: "done", title: "Done child" }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          threadDensity: "auto",
          compactWorkingThreads: true,
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    const density = (title: string) =>
      screen.getByRole("link", { name: title }).closest("[data-parent-card]")!.getAttribute("data-row-density");
    await screen.findByRole("link", { name: "Waiting on child" });

    await waitFor(() => expect(density("Done parent")).toBe("dense"));
    expect(density("Waiting on child")).toBe("compact");
    expect(density("Agent parent")).toBe("compact");
    expect(density("Asking parent")).toBe("comfortable");
  });

  it("counts live descendants despite unread success and keeps requests for input in Active", () => {
    const parent = thread({ id: "parent" });
    const liveChild = thread({ id: "child", parentThreadId: "parent", indicator: "unread-success", status: "active" });
    expect(isWorkingTree(parent, [liveChild], new Map())).toBe(true);
    const askingParent = thread({
      id: "asking",
      indicator: "waiting-for-input",
      activity: {
        workflows: 0,
        backgroundAgents: 1,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    expect(isWorkingTree(askingParent, [], new Map())).toBe(false);
  });

  it("keeps Unpin clickable on a parent compacted by child work", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Pinned parent", isPinned: true }),
          thread({ id: "child", parentThreadId: "parent", indicator: "runtime" }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          threadDensity: "auto",
          compactWorkingThreads: true,
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    const button = await screen.findByRole("button", { name: "Unpin Pinned parent" });
    expect(button.classList.contains("pointer-events-auto")).toBe(true);
  });

  it("moves threads with work running under them to the Working shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "busy", title: "Busy work", indicator: "runtime" }),
          thread({ id: "waiting", title: "Waiting on child" }),
          thread({ id: "child", parentThreadId: "waiting", title: "Child work", indicator: "runtime" }),
          thread({ id: "asking", title: "Asking parent", hasPendingInteraction: true }),
          thread({ id: "asking-child", parentThreadId: "asking", title: "Asking child", indicator: "runtime" }),
          thread({ id: "done", title: "Done work", indicator: "unread-success", isUnread: true }),
          thread({ id: "pinned", title: "Pinned busy", indicator: "runtime", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listLifecycle: () => ({ rows: [] }),
      },
    });
    await screen.findByRole("link", { name: "Busy work" });
    const titlesIn = (name: string) =>
      within(screen.getByRole("region", { name }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label"));

    await waitFor(() => expect(titlesIn("Working")).toEqual(["Busy work", "Waiting on child"]));
    expect(titlesIn("Needs you")).toEqual(["Asking parent"]);
    expect(titlesIn("Idle")).toEqual(["Done work"]);
    expect(titlesIn("Pinned")).toEqual(["Pinned busy"]);
  });

  it.each([true, false])("docks the shelves after Active to the bottom when enabled (%s)", async (dockShelves) => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "open", title: "Open work" }), thread({ id: "done", title: "Settled work" })],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          dockShelves,
        }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "done",
              settledAt: Date.now(),
              settledOverride: "settled",
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    const settled = await screen.findByRole("region", { name: "Archived" });
    const active = screen.getByRole("region", { name: "Idle" });
    await waitFor(() => expect(settled.closest("[data-shelf-dock]") !== null).toBe(dockShelves));
    // Active never moves into the dock; it scrolls in the space above.
    expect(active.closest("[data-shelf-dock]")).toBeNull();
  });
});
