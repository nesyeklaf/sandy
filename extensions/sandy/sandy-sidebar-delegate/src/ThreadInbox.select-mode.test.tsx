import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, toastMocks } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const projects = [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }];

function lastUndo(): { message: string; undo: () => void } {
  const [message, options] = toastMocks.success.mock.calls.at(-1)! as [
    string,
    { action: { label: string; onClick: () => void } },
  ];
  expect(options.action.label).toBe("Undo");
  return { message, undo: options.action.onClick };
}

function renderThreads(threads: ReturnType<typeof thread>[]) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    rpc: { listLifecycle: () => ({ rows: [] }), pin: () => ({ ok: true }) },
  });
}

async function enterSelectMode() {
  fireEvent.click(await screen.findByRole("button", { name: /^View options/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Select threads" }));
}

describe("select mode", () => {
  it("archives the picked threads from the bar and restores them with Undo", async () => {
    const rendered = renderThreads([
      thread({ id: "thr_a", title: "First" }),
      thread({ id: "thr_b", title: "Second" }),
      thread({ id: "thr_c", title: "Third" }),
    ]);
    await enterSelectMode();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select First" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Third" }));
    const bar = screen.getByRole("toolbar", { name: "Selected threads" });
    expect(within(bar).getByRole("status").textContent).toBe("2 selected");
    fireEvent.click(within(bar).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(rendered.sdkCalls.filter((call) => call.method === "threads.archive")).toEqual([
        { method: "threads.archive", args: [{ threadId: "thr_a" }] },
        { method: "threads.archive", args: [{ threadId: "thr_c" }] },
      ]),
    );
    expect(screen.queryByRole("toolbar", { name: "Selected threads" })).toBeNull();
    const { message, undo } = lastUndo();
    expect(message).toBe("Archived 2 threads");
    undo();
    await waitFor(() =>
      expect(rendered.sdkCalls.filter((call) => call.method === "threads.unarchive")).toEqual([
        { method: "threads.unarchive", args: [{ threadId: "thr_a" }] },
        { method: "threads.unarchive", args: [{ threadId: "thr_c" }] },
      ]),
    );
  });

  it("keeps the count readable on a phone-width bar by showing its actions as named icons", async () => {
    renderThreads([thread({ id: "thr_a", title: "First" }), thread({ id: "thr_b", title: "Second" })]);
    await enterSelectMode();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select First" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Second" }));
    const bar = screen.getByRole("toolbar", { name: "Selected threads" });
    expect(bar.textContent).toBe("2 selected");
    expect(Array.from(bar.querySelectorAll("button"), (control) => control.getAttribute("aria-label"))).toEqual([
      "Snooze selected",
      "Archive",
      "Pin",
      "Tag",
      "Leave select mode",
    ]);
  });

  it("leaves select mode without acting", async () => {
    const rendered = renderThreads([thread({ id: "thr_a", title: "First" })]);
    await enterSelectMode();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select First" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave select mode" }));
    expect(screen.queryByRole("checkbox", { name: "Select First" })).toBeNull();
    expect(rendered.sdkCalls.filter((call) => call.method === "threads.archive")).toEqual([]);
  });
});

describe("row fields", () => {
  it("hides the host on rows when View turns it off", async () => {
    renderThreads([
      thread({
        id: "thr_a",
        title: "On a box",
        host: { id: "host_1", name: "box" },
        environment: {
          id: "env_a",
          name: "Worktree",
          branchName: "sandy/a",
          workspaceDisplayKind: "managed-worktree",
          path: null,
          isWorktree: null,
          providerId: null,
        },
      }),
    ]);
    expect(await screen.findByLabelText("Machine: box")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^View options/ }));
    const host = await screen.findByRole("button", { name: "Host", pressed: true });
    fireEvent.click(host);
    await waitFor(() => expect(screen.queryByLabelText("Machine: box")).toBeNull());
    expect(screen.getByRole("button", { name: "Host", pressed: false })).toBeTruthy();
  });
});

describe("diff and PR fields", () => {
  it("shows the branch's line counts and the PR's check state", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_a",
            title: "Has a PR",
            environment: {
              id: "env_a",
              name: "Worktree",
              branchName: "sandy/a",
              workspaceDisplayKind: "managed-worktree",
              path: null,
              isWorktree: null,
              providerId: null,
            },
          }),
        ],
        projects,
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        status: () => ({
          env_a: {
            outcome: "available",
            workspace: {
              workingTree: { insertions: 8, deletions: 2, lineStatsComplete: true },
              mergeBase: { insertions: 40, deletions: 10, lineStatsComplete: true },
            },
          },
        }),
        pullRequests: () => ({
          env_a: {
            outcome: "available",
            pullRequest: {
              number: 7,
              title: "Feature",
              url: "https://github.com/o/r/pull/7",
              state: "open",
              attention: "none",
              updatedAt: "2026-10-23T12:00:00Z",
              checks: { state: "failing", totalCount: 2, passedCount: 1, failedCount: 1, pendingCount: 0 },
            },
          },
        }),
      },
    });
    expect(await screen.findByLabelText("48 lines added, 12 removed")).toBeTruthy();
    expect(await screen.findByRole("img", { name: "Checks failed" })).toBeTruthy();
  });
});

describe("activity bell", () => {
  it("counts a hidden delegate question once, on the parent row it rolls into", async () => {
    const now = Date.now();
    renderThreads([
      thread({ id: "parent", title: "Root", latestAttentionAt: now - 600_000 }),
      thread({
        id: "child",
        title: "Hidden question",
        parentThreadId: "parent",
        originPluginId: "work",
        isHidden: true,
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
        latestAttentionAt: now - 60_000,
      }),
    ]);
    await screen.findByRole("region", { name: "Needs you" });
    fireEvent.click(screen.getByRole("button", { name: "Activity, 1 thread needs you" }));
    const feed = within(await screen.findByRole("dialog", { name: "Activity" })).getByRole("list", {
      name: "Activity feed",
    });
    expect(
      within(feed)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("Root asked a question")]);
  });

  it("counts Needs you rows: indicator-only questions count, asking siblings share their parent's row", async () => {
    renderThreads([
      thread({ id: "indicator", title: "Indicator only", indicator: "waiting-for-input" }),
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "c1", title: "Child one", parentThreadId: "parent", hasPendingInteraction: true }),
      thread({ id: "c2", title: "Child two", parentThreadId: "parent", hasPendingInteraction: true }),
      thread({ id: "c3", title: "Child three", parentThreadId: "parent", hasPendingInteraction: true }),
    ]);
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(
      within(needs)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(expect.arrayContaining(["Indicator only", "Parent"]));
    expect(screen.getByRole("button", { name: "Activity, 2 threads need you" })).toBeTruthy();
  });

  it("lists the last day's events and restores an archived thread", async () => {
    const now = Date.now();
    const rendered = renderThreads([
      thread({ id: "thr_q", title: "Asks", hasPendingInteraction: true, latestAttentionAt: now - 60_000 }),
      thread({ id: "thr_gone", title: "Gone", isArchived: true, archivedAt: now - 120_000 }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Activity, 1 thread needs you" }));
    const dialog = await screen.findByRole("dialog", { name: "Activity" });
    expect(within(dialog).getByText("1 thread waits in Needs you")).toBeTruthy();
    const feed = within(dialog).getByRole("list", { name: "Activity feed" });
    expect(
      within(feed)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("Asks asked a question"), expect.stringContaining("Gone archived")]);
    fireEvent.click(within(feed).getByRole("button", { name: "Restore Gone" }));
    await waitFor(() =>
      expect(rendered.sdkCalls.filter((call) => call.method === "threads.unarchive")).toEqual([
        { method: "threads.unarchive", args: [{ threadId: "thr_gone" }] },
      ]),
    );
  });
});
