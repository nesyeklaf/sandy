// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("shows active threads in a collapsible Active shelf", () => {
    render([thread({ id: "a", title: "First active" }), thread({ id: "b", title: "Second active" })]);

    const activeShelf = screen.getByRole("region", { name: "Waiting" });
    expect(within(activeShelf).getByRole("button", { expanded: true })).toBeDefined();
    fireEvent.click(within(activeShelf).getByRole("button", { expanded: true }));
    expect(within(activeShelf).getByText("Waiting (2)")).toBeDefined();
    expect(within(activeShelf).queryByText("First active")).toBeNull();
    expect(within(activeShelf).queryByText("Second active")).toBeNull();
  });

  it("keeps the currently open active row visible while collapsed", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "open" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "open", title: "Open active" }), thread({ id: "other", title: "Other active" })],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const activeShelf = screen.getByRole("region", { name: "Waiting" });
    fireEvent.click(within(activeShelf).getByRole("button", { expanded: true }));
    expect(within(activeShelf).getByText("Open active")).toBeDefined();
    expect(within(activeShelf).queryByText("Other active")).toBeNull();
  });

  it("sorts active threads from the subtle header menu", async () => {
    render(
      [
        thread({
          id: "alpha-new",
          projectId: "proj_alpha",
          title: "Alpha new",
          createdAt: 3,
          updatedAt: 10,
        }),
        thread({
          id: "beta-new",
          projectId: "proj_beta",
          title: "Beta new",
          createdAt: 4,
          updatedAt: 30,
        }),
        thread({
          id: "alpha-old",
          projectId: "proj_alpha",
          title: "Alpha old",
          createdAt: 1,
          updatedAt: 40,
        }),
        thread({
          id: "beta-old",
          projectId: "proj_beta",
          title: "Beta old",
          createdAt: 2,
          updatedAt: 20,
        }),
      ],
      [
        { id: "proj_alpha", name: "Alpha", isPersonal: false, href: "", settingsHref: "" },
        { id: "proj_beta", name: "Beta", isPersonal: false, href: "", settingsHref: "" },
      ],
    );

    const activeShelf = screen.getByRole("region", { name: "Waiting" });
    const sortMenu = within(activeShelf).getByRole("button", {
      name: "Sort active threads: Manual order",
    });
    expect(sortMenu.querySelector('[data-icon="ArrowUpDown"]')).not.toBeNull();
    expect(sortMenu.classList.contains("focus:ring-0")).toBe(true);
    expect(sortMenu.classList.contains("focus-visible:ring-1")).toBe(true);
    expect(sortMenu.classList.contains("focus:ring-1")).toBe(false);
    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Beta new"),
      expect.stringContaining("Alpha new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha old"),
    ]);

    fireEvent.keyDown(sortMenu, { key: "Enter" });
    expect(screen.getByRole("radio", { name: "Manual order" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Recent activity" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Date created" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Repo" })).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: "Recent activity" }), { detail: 1 });

    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Alpha old"),
      expect.stringContaining("Beta new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha new"),
    ]);
    expect(
      within(activeShelf)
        .getAllByRole("link")
        .every((link) => link.getAttribute("aria-keyshortcuts") === null),
    ).toBe(true);

    fireEvent.keyDown(
      within(activeShelf).getByRole("button", {
        name: "Sort active threads: Recent activity",
      }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("radio", { name: "Date created" }), { detail: 1 });
    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Beta new"),
      expect.stringContaining("Alpha new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha old"),
    ]);

    fireEvent.keyDown(
      within(activeShelf).getByRole("button", {
        name: "Sort active threads: Date created",
      }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("radio", { name: "Repo" }), { detail: 1 });
    // Projects sit where their first thread is in manual order.
    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .filter((row) => !row.hasAttribute("data-reorder-unit"))
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Beta new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha new"),
      expect.stringContaining("Alpha old"),
    ]);
    expect(
      within(activeShelf).getByRole("list", {
        name: "Alpha active threads",
      }),
    ).toBeDefined();
    expect(within(activeShelf).getByRole("button", { name: "Alpha (2)", expanded: true })).toBeDefined();
    expect(
      within(activeShelf)
        .getAllByRole("link")
        .every((link) => link.getAttribute("aria-keyshortcuts") === "Alt+ArrowUp Alt+ArrowDown"),
    ).toBe(true);
    await waitFor(() => expect(window.localStorage.getItem("sandy-sidebar:active-sort:v1")).toBe("project"));
  });

  it("migrates the previous project grouping preference", async () => {
    window.localStorage.setItem("sandy-sidebar:active-grouping:v1", "true");
    render([thread({ id: "saved", title: "Saved grouping" })]);

    expect(
      screen.getByRole("button", {
        name: "Sort active threads: Repo",
      }),
    ).toBeDefined();
    await waitFor(() => expect(window.localStorage.getItem("sandy-sidebar:active-sort:v1")).toBe("project"));
  });

  it("names a project once in a header when it has two or more threads", () => {
    window.localStorage.setItem("sandy-sidebar:active-sort:v1", "project");
    window.localStorage.setItem(
      "sandy-sidebar:inbox-order-cache:v1",
      JSON.stringify(["web-1", "zed-1", "web-2", "api-1"]),
    );
    render(
      [
        thread({ id: "web-1", projectId: "web", title: "First" }),
        thread({ id: "zed-1", projectId: "zed", title: "Loose Z" }),
        thread({ id: "web-2", projectId: "web", title: "Second" }),
        thread({ id: "api-1", projectId: "api", title: "Loose A" }),
      ],
      [
        { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
        { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
        { id: "zed", name: "Zed", isPersonal: false, href: "", settingsHref: "" },
      ],
    );

    const headers = screen.getAllByRole("button", { name: /\(\d+\)$/ });
    expect(headers.map((header) => header.getAttribute("aria-label"))).toEqual(["Web (2)"]);
    // One-thread projects stay ordinary cards. Everything keeps manual
    // order, with a project drawn where its first thread is.
    expect(
      screen
        .getAllByRole("listitem")
        .filter((row) => !row.hasAttribute("data-reorder-unit"))
        .map((row) => row.textContent),
    ).toEqual([
      expect.not.stringContaining("Web"),
      expect.not.stringContaining("Web"),
      expect.stringMatching(/^Zed.*Loose Z/),
      expect.stringMatching(/^Api.*Loose A/),
    ]);
  });

  it("hides project headers while Active is collapsed", async () => {
    window.localStorage.setItem("sandy-sidebar:active-sort:v1", "project");
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "web-2" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "web-1", projectId: "web", title: "First" }),
            thread({ id: "web-2", projectId: "web", title: "Second" }),
          ],
          projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const active = await screen.findByRole("region", { name: "Waiting" });
    expect(within(active).getByRole("button", { name: "Web (2)" })).toBeDefined();
    fireEvent.click(within(active).getByRole("button", { name: "Waiting", expanded: true }));
    expect(within(active).queryByRole("button", { name: "Web (2)" })).toBeNull();
    expect(
      within(active)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringMatching(/^Web.*Second/)]);
  });

  it("looks like manual order when no project has a second thread", () => {
    window.localStorage.setItem("sandy-sidebar:active-sort:v1", "project");
    render(
      [
        thread({ id: "zed-1", projectId: "zed", title: "Zed thread", createdAt: 2 }),
        thread({ id: "api-1", projectId: "api", title: "Api thread", createdAt: 1 }),
      ],
      [
        { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
        { id: "zed", name: "Zed", isPersonal: false, href: "", settingsHref: "" },
      ],
    );

    expect(screen.queryAllByRole("button", { name: /\(\d+\)$/ })).toEqual([]);
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Zed.*Zed thread/),
      expect.stringMatching(/^Api.*Api thread/),
    ]);
  });

  it("collapses a project, keeping the open thread and the choice", async () => {
    window.localStorage.setItem("sandy-sidebar:active-sort:v1", "project");
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "web-2" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "web-1", projectId: "web", title: "First" }),
            thread({ id: "web-2", projectId: "web", title: "Second" }),
            thread({ id: "api-1", projectId: "api", title: "Third" }),
          ],
          projects: [
            { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
            { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Web (2)" }));
    expect(screen.getByRole("button", { name: "Web (2)" }).getAttribute("aria-expanded")).toBe("false");
    const web = screen.getByRole("list", { name: "Web active threads" });
    expect(
      within(web)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Second")]);
    expect(screen.getByText("Third")).toBeDefined();
    await waitFor(() =>
      expect(window.localStorage.getItem("sandy-sidebar:project-collapse:v1")).toBe(JSON.stringify(["web"])),
    );
  });

  it("lists threads newest first", () => {
    render([thread({ id: "a", title: "Older", createdAt: 1 }), thread({ id: "b", title: "Newer", createdAt: 2 })]);
    // The anchor is a full-bleed overlay, so read the row containers.
    const titles = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(titles[0]).toContain("Newer");
    expect(titles[1]).toContain("Older");
  });
});
