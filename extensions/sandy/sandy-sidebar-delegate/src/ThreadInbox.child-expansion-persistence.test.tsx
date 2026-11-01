// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { thread, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("retains the newest child expansions after saving and remounting", async () => {
    const key = "sandy-sidebar:child-expansion:v1";
    const oldIds = Array.from({ length: 100 }, (_, index) => `z${String(index).padStart(3, "0")}`);
    const allThreads = [...oldIds, "a-newest", "b-next"].flatMap((id) => [
      thread({ id, title: id }),
      thread({ id: `${id}-child`, title: `${id}-child`, parentThreadId: id }),
    ]);
    localStorage.setItem(key, JSON.stringify(oldIds));
    const first = render(allThreads);
    const expand = (id: string) => {
      // Keep the accessible link check, scoped to its card instead of all 200 rows.
      const card = screen.getByText(id).closest("li")!;
      expect(within(card).getByRole("link", { name: id })).toBeDefined();
      fireEvent.click(within(card).getByRole("button", { name: "1 child thread" }));
    };
    expand("a-newest");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(100));
    first.lifecycle.unmount();

    render(allThreads);
    expand("b-next");
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual([...oldIds.slice(2), "a-newest", "b-next"]),
    );
  });

  it("restores child expansion outside the parent card body", () => {
    window.localStorage.setItem("sandy-sidebar:child-expansion:v1", JSON.stringify(["parent"]));
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);

    expect(screen.getByRole("list", { name: "Child threads" })).toBeDefined();
    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(childList.closest("[data-parent-card]")).toBeNull();
  });

  it("prunes expansion state for parents that no longer have children", async () => {
    window.localStorage.setItem("sandy-sidebar:child-expansion:v1", JSON.stringify(["parent", "deleted-parent"]));
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("sandy-sidebar:child-expansion:v1") ?? "[]")).toEqual(["parent"]),
    );
  });
});
