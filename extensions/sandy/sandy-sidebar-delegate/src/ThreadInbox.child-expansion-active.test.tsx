// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("reveals the active child without persisted expansion", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "child" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
          ],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    expect(screen.getByRole("list", { name: "Child threads" })).toBeDefined();
    expect(screen.getByText("Child")).toBeDefined();
  });

  it("collapses a parent while its child is active, keeping only that child visible", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "child-a" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child-a", title: "Child A", parentThreadId: "parent" }),
            thread({ id: "child-b", title: "Child B", parentThreadId: "parent" }),
          ],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const badge = screen.getByRole("button", { name: "2 child threads" });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Child A")).toBeDefined();
    expect(screen.queryByText("Child B")).toBeNull();
    const activeRow = screen.getByRole("button", {
      name: "Open child thread: Child A",
    });
    expect(activeRow.getAttribute("aria-current")).toBe("page");
    expect(activeRow.closest("[data-child-thread-row]")?.className).toContain("bg-sidebar-accent");

    fireEvent.click(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Child A")).toBeDefined();
    expect(screen.getByText("Child B")).toBeDefined();

    fireEvent.click(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Child A")).toBeDefined();
    expect(screen.queryByText("Child B")).toBeNull();
  });

  it("collapses a grandchild disclosure while a grandchild is active", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild-a" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
            thread({
              id: "grandchild-a",
              title: "Grandchild A",
              parentThreadId: "child",
            }),
            thread({
              id: "grandchild-b",
              title: "Grandchild B",
              parentThreadId: "child",
            }),
          ],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const disclosure = screen.getByRole("button", {
      name: "Show 2 grandchild threads for Child",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Grandchild A")).toBeDefined();
    expect(screen.queryByText("Grandchild B")).toBeNull();

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Grandchild B")).toBeDefined();

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Grandchild A")).toBeDefined();
    expect(screen.queryByText("Grandchild B")).toBeNull();
  });

  it("keeps an active child's parked parent visible on a collapsed shelf", async () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "child" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parked parent" }),
            thread({ id: "child", title: "Active child", parentThreadId: "parent" }),
          ],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: [
              {
                threadId: "parent",
                settledAt: 200,
                snoozedUntil: null,
                snoozedAt: null,
              },
            ],
          }),
        },
      },
    );

    const settled = await screen.findByRole("region", { name: "Settled" });
    expect(within(settled).getByRole("button", { name: /^Settled/, expanded: false })).toBeDefined();
    expect(within(settled).getByText("Parked parent")).toBeDefined();
  });

  it("reveals the active grandchild and its child disclosure", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
            thread({
              id: "grandchild",
              title: "Grandchild",
              parentThreadId: "child",
            }),
          ],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    expect(screen.getByRole("list", { name: "Grandchildren of Child" })).toBeDefined();
    expect(screen.getByText("Grandchild")).toBeDefined();
  });
});
