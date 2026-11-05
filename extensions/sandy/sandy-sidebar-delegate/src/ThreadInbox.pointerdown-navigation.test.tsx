// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const projects = [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }];
const mouse = { pointerType: "mouse", button: 0, pointerId: 1 };

function renderRows(threads: ReturnType<typeof thread>[], density?: "dense") {
  const counts = { onNavigate: 0 };
  const rendered = renderSlot(
    inbox,
    { ...listProps, onNavigate: () => (counts.onNavigate += 1) },
    {
      sidebarThreads: { status: "ready", threads, projects },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          ...(density ? { threadDensity: density, compactWorkingThreads: true } : {}),
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    },
  );
  const opened = () => rendered.navigateCalls.filter((call) => call.method === "toThread");
  return { rendered, counts, opened };
}

describe("ThreadInbox pointerdown navigation", () => {
  it.each(["mouse", "pen"])(
    "opens a row once on a primary %s press and ignores the click that follows",
    (pointerType) => {
      const { counts, opened } = renderRows([thread({ id: "thr_a", title: "Thread A" })]);
      const row = screen.getByRole("link", { name: "Thread A" });

      fireEvent.pointerDown(row, { ...mouse, pointerType });
      expect(opened()).toEqual([{ method: "toThread", threadId: "thr_a", options: { split: false } }]);
      expect(counts.onNavigate).toBe(1);

      fireEvent.pointerUp(row, { ...mouse, pointerType });
      fireEvent.click(row, { detail: 1 });
      expect(opened()).toHaveLength(1);
      expect(counts.onNavigate).toBe(1);
    },
  );

  it("opens a dense row on the press as well", async () => {
    const { counts, opened } = renderRows([thread({ id: "thr_d", title: "Dense A" })], "dense");
    const folded = () =>
      screen.getByRole("link", { name: "Dense A" }).closest("[data-parent-card]")!.classList.contains("h-8");
    await waitFor(() => expect(folded()).toBe(true));
    const row = screen.getByRole("link", { name: "Dense A" });

    fireEvent.pointerDown(row, mouse);
    expect(opened()).toHaveLength(1);
    fireEvent.click(row, { detail: 1 });
    expect(opened()).toHaveLength(1);
    expect(counts.onNavigate).toBe(1);
  });

  it("waits for the click on touch", () => {
    const { opened } = renderRows([thread({ id: "thr_t", title: "Thread T" })]);
    const row = screen.getByRole("link", { name: "Thread T" });

    fireEvent.pointerDown(row, { ...mouse, pointerType: "touch" });
    expect(opened()).toHaveLength(0);
    fireEvent.click(row, { detail: 1 });
    expect(opened()).toHaveLength(1);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }])(
    "leaves a press with %o to the click",
    (modifier) => {
      const { opened } = renderRows([thread({ id: "thr_m", title: "Thread M" })]);
      const row = screen.getByRole("link", { name: "Thread M" });

      fireEvent.pointerDown(row, { ...mouse, ...modifier });
      expect(opened()).toHaveLength(0);
      fireEvent.click(row, { detail: 1, ...modifier });
      expect(opened()).toHaveLength(1);
    },
  );

  it.each([1, 2])("does not open a row on a button %i press", (button) => {
    const { opened } = renderRows([thread({ id: "thr_b", title: "Thread B" })]);
    fireEvent.pointerDown(screen.getByRole("link", { name: "Thread B" }), { ...mouse, button });
    expect(opened()).toHaveLength(0);
  });

  it("still opens from the keyboard after a press whose click never came", () => {
    const { opened } = renderRows([thread({ id: "thr_k", title: "Thread K" })]);
    const row = screen.getByRole("link", { name: "Thread K" });

    fireEvent.pointerDown(row, mouse);
    expect(opened()).toHaveLength(1);
    fireEvent.click(row, { detail: 0 });
    expect(opened()).toHaveLength(2);
  });

  it("opens from Enter and Space clicks alone", () => {
    const { opened } = renderRows([thread({ id: "thr_e", title: "Thread E" })]);
    const row = screen.getByRole("link", { name: "Thread E" });

    fireEvent.click(row, { detail: 0 });
    fireEvent.click(row, { detail: 0 });
    expect(opened()).toHaveLength(2);
  });

  it("opens a row once for the two presses of a double click", () => {
    const { opened } = renderRows([thread({ id: "thr_x", title: "Thread X" })]);
    const row = screen.getByRole("link", { name: "Thread X" });

    fireEvent.pointerDown(row, mouse);
    fireEvent.click(row, { detail: 1 });
    fireEvent.pointerDown(row, mouse);
    fireEvent.click(row, { detail: 2 });
    expect(opened()).toHaveLength(1);
  });

  it("opens a child row on the press", () => {
    const { opened } = renderRows([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    const child = screen.getByRole("button", { name: "Open child thread: Child" });

    fireEvent.pointerDown(child, mouse);
    expect(opened().map((call) => call.threadId)).toEqual(["child"]);
    fireEvent.click(child, { detail: 1 });
    expect(opened()).toHaveLength(1);

    fireEvent.pointerDown(child, { ...mouse, pointerType: "touch" });
    expect(opened()).toHaveLength(1);
  });

  it("completes a reorder that began with a press that already opened the row", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "a", title: "Row A" }), thread({ id: "b", title: "Row B" })],
        projects,
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["a", "b"] }),
        reorderInbox: () => ({ inboxThreadIds: ["b", "a"] }),
      },
    });
    const cardA = screen.getByRole("link", { name: "Row A" });
    const target = screen.getByRole("link", { name: "Row B" }).closest("li")!;
    vi.mocked(document.elementFromPoint).mockReturnValue(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const opened = () => rendered.navigateCalls.filter((call) => call.method === "toThread");

    fireEvent.pointerDown(cardA, { ...mouse, clientX: 20, clientY: 0 });
    expect(opened().map((call) => call.threadId)).toEqual(["a"]);
    fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
    expect(cardA.closest("ul")!.hasAttribute("data-drag-preview")).toBe(true);
    fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });
    await waitFor(() =>
      expect(rendered.rpcCalls.find((call) => call.method === "reorderInbox")?.input).toEqual({
        inboxThreadIds: ["b", "a"],
      }),
    );
    fireEvent.click(cardA, { detail: 1 });
    expect(opened()).toHaveLength(1);
  });
});
