// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { thread, render, loadInboxApp } from "./test-inbox";
import { delegateChildRecord } from "./test-fixtures";
import type { DelegateChildRecord } from "./delegate-children";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const EXPANSION_KEY = "sandy-sidebar:child-expansion:v1";
const childRecord = (id: string, overrides: Partial<DelegateChildRecord> = {}) =>
  delegateChildRecord(id, { projectId: "proj_1", ...overrides });

// Most cases look at finished children too, so they turn "Hide finished subagents" off.
// The inactive shelf stays off as before the settings load, so the parent stays in the list.
function renderWithChildren(
  children: DelegateChildRecord[],
  hostThreads = [thread({ id: "parent", title: "Parent" })],
  hideFinishedSubagents = false,
) {
  return render(hostThreads, undefined, {
    listDelegateChildren: () => ({ children }),
    getSidebarSettings: () => ({ ...DEFAULT_SIDEBAR_SETTINGS, inactiveThreadsEnabled: false, hideFinishedSubagents }),
  });
}

describe("ThreadInbox delegate children", () => {
  it("nests hidden children and workers under the parent, collapsed behind a count", async () => {
    renderWithChildren([
      childRecord("hidden", { title: "Hidden delegate" }),
      childRecord("worker", {
        title: "Workflow worker",
        originPluginId: "workflows-plus",
        parentThreadId: null,
        lifecycleOwnerThreadId: "parent",
      }),
      childRecord("archived", { title: "Archived delegate", archivedAt: 5 }),
    ]);

    const badge = await screen.findByRole("button", { name: "2 child threads" });
    // Idle hidden children are collapsed; they do not show as rows or as roots.
    expect(screen.queryByText("Hidden delegate")).toBeNull();
    expect(screen.queryByText("Archived delegate")).toBeNull();

    fireEvent.click(badge);
    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(within(childList).getByRole("button", { name: "Open child thread: Hidden delegate" })).toBeDefined();
    expect(within(childList).getByRole("button", { name: "Open child thread: Workflow worker" })).toBeDefined();
    expect(within(childList).queryByText("Archived delegate")).toBeNull();
  });

  it("puts needs-you on the parent and shows the waiting child while collapsed", async () => {
    renderWithChildren([
      childRecord("quiet", { title: "Quiet delegate" }),
      childRecord("asks", { title: "Asking delegate", hasPendingInteraction: true }),
    ]);

    const badge = await screen.findByRole("button", { name: /^2 child threads/ });
    expect(badge.getAttribute("data-child-status")).toBe("needs-you");
    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(within(childList).getByRole("button", { name: /^Open child thread: Asking delegate/ })).toBeDefined();
    expect(within(childList).queryByText("Quiet delegate")).toBeNull();
  });

  it("keeps a persisted expansion for a parent whose only children are hidden", async () => {
    window.localStorage.setItem(EXPANSION_KEY, JSON.stringify(["parent"]));
    renderWithChildren([childRecord("hidden", { title: "Hidden delegate" })]);

    expect(await screen.findByRole("button", { name: "Open child thread: Hidden delegate" })).toBeDefined();
    // Let the post-load prune run; the expansion must survive it.
    await waitFor(() => expect(screen.getByRole("list", { name: "Child threads" })).toBeDefined());
    expect(JSON.parse(window.localStorage.getItem(EXPANSION_KEY) ?? "[]")).toEqual(["parent"]);
  });

  it("does not forget the expansion while the server list has not arrived", async () => {
    window.localStorage.setItem(EXPANSION_KEY, JSON.stringify(["parent"]));
    render([thread({ id: "parent", title: "Parent" })], undefined, {
      listDelegateChildren: () => {
        throw new Error("plugin server unavailable");
      },
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.parse(window.localStorage.getItem(EXPANSION_KEY) ?? "[]")).toEqual(["parent"]);
  });

  it("hides finished children when Hide finished subagents is on", async () => {
    window.localStorage.setItem(EXPANSION_KEY, JSON.stringify(["parent"]));
    renderWithChildren(
      [
        childRecord("done", { title: "Done delegate" }),
        childRecord("working", { title: "Working delegate", status: "active" }),
        childRecord("asks", { title: "Asking delegate", hasPendingInteraction: true }),
      ],
      undefined,
      true,
    );

    const childList = await screen.findByRole("list", { name: "Child threads" });
    expect(
      await within(childList).findByRole("button", { name: /^Open child thread: Working delegate/ }),
    ).toBeDefined();
    expect(within(childList).getByRole("button", { name: /^Open child thread: Asking delegate/ })).toBeDefined();
    await waitFor(() => expect(within(childList).queryByText("Done delegate")).toBeNull());
  });

  it("leaves the list unchanged when there are no delegate children", async () => {
    renderWithChildren([]);
    expect(await screen.findByText("Parent")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Child threads" })).toBeNull();
  });
});
