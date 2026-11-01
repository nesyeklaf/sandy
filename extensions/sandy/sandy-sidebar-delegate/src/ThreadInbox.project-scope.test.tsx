// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, defaultSidebarSettings } from "./test-inbox";
import { STORAGE_KEYS } from "./lib/storage-keys";

await loadInboxApp();

const projects = ["Alpha", "Beta", "Gamma"].map((name) => ({
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
      threads: projects.map(({ id }) => thread({ id, projectId: id, title: `${id} thread` })),
    },
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}

function openPicker() {
  fireEvent.keyDown(screen.getByRole("button", { name: /^Repo scope:/ }), { key: "Enter" });
  return screen.getByRole("grid", { name: "Repos" });
}

it("toggles multiple projects without closing, remembers them on remount, and resets to all", async () => {
  const rendered = renderProjects();
  const picker = openPicker();
  expect(picker.getAttribute("aria-multiselectable")).toBe("true");
  expect(screen.getByText("Select one or more repos")).toBeDefined();
  expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("All repos");
  fireEvent.click(within(picker).getByRole("row", { name: "Alpha" }));
  expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("1 repo selected");
  fireEvent.click(within(picker).getByRole("row", { name: "Gamma" }));
  expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("2 repos selected");
  expect(screen.getByRole("button", { name: "Repo scope: Alpha + Gamma" })).toBeDefined();
  expect(
    within(picker)
      .getAllByRole("row", { selected: true })
      .map((option) => option.textContent),
  ).toEqual(["Alpha", "Gamma"]);
  expect(screen.getByText("Alpha thread")).toBeDefined();
  expect(screen.getByText("Gamma thread")).toBeDefined();
  expect(screen.queryByText("Beta thread")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Filter repos" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("grid", { name: "Repos" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Repo scope:/ })));

  rendered.lifecycle.unmount();
  renderProjects();
  expect(screen.getByRole("button", { name: "Repo scope: Alpha + Gamma" })).toBeDefined();
  expect(screen.queryByText("Beta thread")).toBeNull();
  const restored = openPicker();
  fireEvent.click(within(restored).getByRole("row", { name: "Alpha" }));
  expect(screen.queryByText("Alpha thread")).toBeNull();
  expect(screen.getByText("Gamma thread")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Filter repos"), { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset to all repos" }));
  expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("All repos");
  for (const { name } of projects) expect(screen.getByText(`${name} thread`)).toBeDefined();
  expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.projectScope.key)!)).toEqual([]);
});

it("lets the keyboard select multiple filtered projects, toggle off the last one, and dismiss with Escape", () => {
  renderProjects();
  openPicker();
  const input = screen.getByRole("combobox", { name: "Filter repos" });
  for (const name of ["Alpha", "Beta"]) {
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: "Enter" });
  }
  expect(screen.queryByText("Gamma thread")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.queryByText("Beta thread")).toBeNull();
  fireEvent.change(input, { target: { value: "Alpha" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("button", { name: "Repo scope: All repos" })).toBeDefined();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("grid", { name: "Repos" })).toBeNull();
});

it("keeps selection usable when session storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  try {
    renderProjects();
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole("row", { name: "Beta" }));
    fireEvent.click(within(picker).getByRole("row", { name: "Gamma" }));
    expect(screen.getByText("Beta thread")).toBeDefined();
    expect(screen.queryByText("Alpha thread")).toBeNull();
  } finally {
    vi.restoreAllMocks();
  }
});

it("filters every shelf without changing lifecycle or order", async () => {
  const shelves = ["Pinned", "Needs you", "Working", "Inactive", "Snoozed", "Parked", "Settled"];
  const now = Date.now();
  localStorage.setItem(
    STORAGE_KEYS.shelfExpansion.key,
    JSON.stringify(Object.fromEntries(shelves.map((s) => [s.toLowerCase(), true]))),
  );
  sessionStorage.setItem(STORAGE_KEYS.projectScope.key, JSON.stringify(["Alpha", "Gamma"]));
  const threads = projects.flatMap(({ id }) =>
    shelves.map((shelf) =>
      thread({
        id: `${id}-${shelf}`,
        projectId: id,
        title: `${id} ${shelf}`,
        isPinned: shelf === "Pinned",
        indicator: shelf === "Working" ? "runtime" : "none",
        updatedAt: shelf === "Inactive" ? now - 24 * 60 * 60_000 : now,
      }),
    ),
  );
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", projects, threads },
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, workingShelf: true }),
      listLifecycle: () => ({
        rows: projects.flatMap(({ id }) => [
          { threadId: `${id}-Snoozed`, snoozedAt: now, snoozedUntil: now + 60_000, settledAt: null },
          { threadId: `${id}-Parked`, parkedAt: now, snoozedAt: null, snoozedUntil: null, settledAt: null },
          { threadId: `${id}-Settled`, snoozedAt: null, snoozedUntil: null, settledAt: now },
        ]),
      }),
    },
  });
  for (const shelf of shelves) {
    const region = await screen.findByRole("region", { name: shelf });
    await waitFor(() => expect(within(region).getAllByRole("link")).toHaveLength(2));
    expect(within(region).getByText(`Alpha ${shelf}`)).toBeDefined();
    expect(within(region).getByText(`Gamma ${shelf}`)).toBeDefined();
    expect(screen.queryByText(`Beta ${shelf}`)).toBeNull();
  }
  expect(rendered.rpcCalls.filter(({ method }) => /^(reorder|settle|snooze|park|setThread)/.test(method))).toEqual([]);
});

it("keeps the on-screen keyboard down on touch devices", async () => {
  // Reduced motion keeps list animations off; jsdom has no Element.animate.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" || query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  renderProjects();
  const picker = openPicker();
  const filter = screen.getByRole("combobox", { name: "Filter repos" });
  await waitFor(() => expect(within(picker).getByRole("row", { name: "Alpha" })).toBeDefined());
  expect(document.activeElement).not.toBe(filter);
  fireEvent.click(within(picker).getByRole("row", { name: "Alpha" }));
  expect(screen.getByRole("button", { name: "Repo scope: Alpha" })).toBeDefined();
  expect(document.activeElement).not.toBe(filter);
});
