// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";
import { STORAGE_KEYS } from "./lib/storage-keys";

await loadInboxApp();

const projects = ["Alpha", "Beta", "Empty"].map((name) => ({
  id: name,
  name,
  isPersonal: false,
  href: "",
  settingsHref: "",
}));

function renderProjects() {
  return renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      projects,
      threads: ["Alpha", "Beta"].map((id) => thread({ id, projectId: id, title: `${id} thread` })),
    },
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}

function openPicker() {
  fireEvent.keyDown(screen.getByRole("button", { name: /^Repo scope:/ }), { key: "Enter" });
}

it("pins independently of selection, persists shortcuts, and toggles multiple project filters", () => {
  const rendered = renderProjects();
  expect(screen.queryByRole("group", { name: "Pinned repos" })).toBeNull();
  openPicker();
  fireEvent.click(screen.getByRole("button", { name: "Pin Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Pin Alpha" }));
  expect(screen.getByRole("button", { name: "Repo scope: All repos" })).toBeDefined();
  expect(screen.getByRole("grid", { name: "Repos" })).toBeDefined();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual(["Beta", "Alpha"]);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  const shortcuts = screen.getByRole("group", { name: "Pinned repos" });
  expect(
    within(shortcuts)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Beta", "Alpha"]);
  fireEvent.click(within(shortcuts).getByRole("button", { name: "Filter by Beta" }));
  expect(screen.queryByText("Alpha thread")).toBeNull();
  expect(screen.getByText("Beta thread")).toBeDefined();
  expect(within(shortcuts).getByRole("button", { name: "Filter by Beta", pressed: true })).toBeDefined();
  expect(screen.getByRole("button", { name: "Repo scope: 1 repo" })).toBeDefined();
  fireEvent.click(within(shortcuts).getByRole("button", { name: "Filter by Alpha" }));
  expect(screen.getByText("Beta thread")).toBeDefined();
  expect(screen.getByText("Alpha thread")).toBeDefined();
  expect(screen.getByRole("button", { name: "Repo scope: 2 repos" })).toBeDefined();
  expect(within(shortcuts).getAllByRole("button", { pressed: true })).toHaveLength(2);
  openPicker();
  expect(screen.getByRole("row", { name: "Alpha", selected: true })).toBeDefined();
  expect(screen.getByRole("row", { name: "Beta", selected: true })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(within(shortcuts).getByRole("button", { name: "Filter by Alpha" }));
  expect(screen.getByText("Beta thread")).toBeDefined();
  expect(screen.queryByText("Alpha thread")).toBeNull();

  rendered.lifecycle.unmount();
  renderProjects();
  expect(within(screen.getByRole("group", { name: "Pinned repos" })).getAllByRole("button")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Filter by Beta", pressed: true })).toBeDefined();
  openPicker();
  fireEvent.click(screen.getByRole("button", { name: "Unpin Beta" }));
  expect(screen.queryByRole("button", { name: "Filter by Beta" })).toBeNull();
  expect(screen.getByRole("button", { name: "Repo scope: Beta" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Reset to all repos" }));
  expect(screen.getByRole("button", { name: "Filter by Alpha" })).toBeDefined();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual(["Alpha"]);
});

it("names unpinned selections before the pinned count and resets without removing pins", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, JSON.stringify(["Beta"]));
  renderProjects();
  fireEvent.click(screen.getByRole("button", { name: "Filter by Beta" }));
  openPicker();
  fireEvent.click(screen.getByRole("row", { name: "Alpha" }));
  expect(screen.getByRole("button", { name: "Repo scope: Alpha + 1 repo" })).toBeDefined();
  fireEvent.click(screen.getByRole("row", { name: "Empty" }));
  expect(screen.getByRole("button", { name: "Repo scope: Alpha + Empty + 1 repo" })).toBeDefined();
  fireEvent.click(screen.getByRole("row", { name: "Beta" }));
  expect(screen.getByRole("button", { name: "Filter by Beta", pressed: false })).toBeDefined();
  expect(screen.getByRole("button", { name: "Repo scope: Alpha + Empty" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Filter by Beta" }));
  expect(screen.getByRole("button", { name: "Repo scope: Alpha + Empty + 1 repo" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Reset repo filter" }));
  expect(screen.getByRole("button", { name: "Repo scope: All repos" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Reset repo filter" })).toBeNull();
  expect(screen.getByRole("button", { name: "Filter by Beta", pressed: false })).toBeDefined();
  expect(screen.getByText("Alpha thread")).toBeDefined();
  expect(screen.getByText("Beta thread")).toBeDefined();
  openPicker();
  expect(screen.getByRole("row", { name: "All repos", selected: true })).toBeDefined();
  expect(screen.getByRole("row", { name: "Beta", selected: false })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Filter by Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Filter by Beta" }));
  expect(screen.getByRole("button", { name: "Repo scope: All repos" })).toBeDefined();
});

it("keeps shortcuts outside the scroller even with collapsed shelves or no threads", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, JSON.stringify(["Alpha", "Empty"]));
  localStorage.setItem(STORAGE_KEYS.shelfExpansion.key, JSON.stringify({ active: false }));
  renderProjects();
  const shortcuts = screen.getByRole("group", { name: "Pinned repos" });
  expect(shortcuts.closest("[data-list-motion-scroller]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filter by Empty" }));
  expect(screen.getByRole("button", { name: "Filter by Empty", pressed: true })).toBeDefined();
  expect(screen.queryByText("Alpha thread")).toBeNull();
  expect(within(screen.getByRole("group", { name: "Pinned repos" })).getAllByRole("button")).toHaveLength(2);
});

it("keeps pinning usable when storage is blocked and keyboard navigation can leave the pin button", () => {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  try {
    renderProjects();
    openPicker();
    const filter = screen.getByRole("combobox", { name: "Filter repos" });
    fireEvent.change(filter, { target: { value: "Alpha" } });
    const pin = screen.getByRole("button", { name: "Pin Alpha" });
    expect(pin.tabIndex).toBe(0);
    pin.focus();
    fireEvent.click(pin);
    expect(screen.getByRole("button", { name: "Unpin Alpha" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Repo scope: All repos" })).toBeDefined();
    fireEvent.keyDown(pin, { key: "ArrowDown" });
    expect(document.activeElement).toBe(filter);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(screen.getByRole("row", { name: "Alpha", selected: true })).toBeDefined();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Filter by Alpha", pressed: true })).toBeDefined();
  } finally {
    spy.mockRestore();
  }
});
