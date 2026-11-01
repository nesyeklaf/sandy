// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { thread, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("archives the selected child instead of its parent", async () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open child thread: Child" }));

    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive"));
    expect(rendered.threadActionCalls).toContainEqual({
      key: "sandy--core/archive",
      threadId: "child",
    });
    expect(rendered.threadActionCalls).not.toContainEqual({
      key: "sandy--core/archive",
      threadId: "parent",
    });
  });

  it("releases the agent sessions archive leaves loaded", async () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "idle-child", title: "Idle child", parentThreadId: "parent" }),
      thread({
        id: "busy-child",
        title: "Busy child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({ id: "stranger", title: "Stranger" }),
    ]);

    fireEvent.contextMenu(screen.getByText("Parent"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive"));

    expect(rendered.threadActionCalls).toContainEqual({
      key: "sandy--core/archive",
      threadId: "parent",
    });
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "releaseRuntimes",
        input: { threadIds: ["parent", "idle-child"] },
      }),
    );
  });

  for (const busyChild of [
    thread({ id: "running", title: "Running child", indicator: "runtime" }),
    thread({
      id: "needs-input",
      title: "Needs input child",
      hasPendingInteraction: true,
    }),
  ]) {
    it(`disables Archive for a busy child: ${busyChild.id}`, async () => {
      render([thread({ id: "parent", title: "Parent" }), { ...busyChild, parentThreadId: "parent" }]);
      fireEvent.click(screen.getByRole("button", { name: /^1 child thread/ }));
      fireEvent.contextMenu(
        screen.getByRole("button", {
          name: `Open child thread: ${busyChild.title}${busyChild.hasPendingInteraction ? ", Needs you" : ", Working"}`,
        }),
      );

      const archive = within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive");
      expect(archive.getAttribute("data-disabled")).not.toBeNull();
    });
  }

  it("shows one collapsed grandchild level without changing the parent count", () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "child",
        title: "Child",
        parentThreadId: "parent",
      }),
      thread({
        id: "grandchild",
        title: "Grandchild",
        parentThreadId: "child",
      }),
      thread({
        id: "great-grandchild",
        title: "Great-grandchild",
        parentThreadId: "grandchild",
      }),
    ]);

    const parentBadge = screen.getByRole("button", {
      name: "1 child thread",
    });
    fireEvent.click(parentBadge);

    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(within(childList).getByText("Child")).toBeDefined();
    expect(screen.queryByText("Grandchild")).toBeNull();
    expect(screen.queryByText("Great-grandchild")).toBeNull();

    const disclosure = within(childList).getByRole("button", {
      name: "Show 1 grandchild thread for Child",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();

    fireEvent.click(disclosure);

    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Child",
    });
    expect(grandchildList.getAttribute("data-grandchild-thread-list")).toBe("sidebar");
    expect(within(grandchildList).getByText("Grandchild")).toBeDefined();
    expect(screen.queryByText("Great-grandchild")).toBeNull();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.querySelector('[data-icon="ChevronUp"]')).not.toBeNull();

    fireEvent.click(
      within(grandchildList).getByRole("button", {
        name: "Open grandchild thread: Grandchild",
      }),
    );
    expect(rendered.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "grandchild",
      options: { split: false },
    });
  });

  it("removes archived children from the sidebar badge and list", () => {
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "visible-child",
        title: "Visible child",
        parentThreadId: "parent",
      }),
      thread({
        id: "archived-child",
        title: "Archived child",
        parentThreadId: "parent",
        isArchived: true,
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    expect(screen.getByText("Visible child")).toBeDefined();
    expect(screen.queryByText("Archived child")).toBeNull();
  });
});
