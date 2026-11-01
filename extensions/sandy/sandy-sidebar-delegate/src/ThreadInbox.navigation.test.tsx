// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  // The DOM contract behind numbered thread shortcuts and thread.next/previous.
  // A plugin that drops these attributes silently breaks nine host shortcuts.
  it("marks every row as a host shortcut target", () => {
    render([thread({ id: "thr_x" })]);
    const row = screen.getByRole("link");
    expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(row.getAttribute("data-sidebar-thread-id")).toBe("thr_x");
  });

  it("opens a thread on click and closes the mobile drawer", () => {
    let navigated = 0;
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_open" })],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );
    fireEvent.click(screen.getByRole("link"));
    expect(rendered.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_open",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  // sandy owns the modifier hold and numbering; rows draw what it assigns.
  it("shows sandy's jump shortcut on a row in place of its status", () => {
    const threads = [thread({ id: "thr_a", title: "Thread A" }), thread({ id: "thr_b", title: "Thread B" })];
    const options = {
      sidebarThreads: {
        status: "ready" as const,
        threads,
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    };
    const hints = () => [...document.querySelectorAll("kbd")].map((hint) => hint.textContent);

    const idle = renderSlot(inbox, listProps, options);
    expect(hints()).toEqual([]);
    const keys = (name: string) => screen.getByRole("link", { name }).getAttribute("aria-keyshortcuts");
    expect(keys("Thread A")).toBe("Alt+ArrowUp Alt+ArrowDown");
    idle.lifecycle.unmount();

    renderSlot(inbox, listProps, {
      ...options,
      sidebarShortcuts: { thr_a: { label: "⌘1", ariaKeyshortcuts: "Meta+1" } },
    });
    expect(hints()).toEqual(["⌘1"]);
    // The jump key joins the reorder keys the row already announces.
    expect(keys("Thread A")).toBe("Meta+1 Alt+ArrowUp Alt+ArrowDown");
    expect(keys("Thread B")).toBe("Alt+ArrowUp Alt+ArrowDown");
  });

  it("opens a thread normally when the platform modifier is held", () => {
    const rendered = render([thread({ id: "thr_modifier" })]);
    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    expect(rendered.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_modifier",
      options: { split: false },
    });
    expect(screen.queryByRole("toolbar", { name: /threads selected/ })).toBeNull();
  });
});
