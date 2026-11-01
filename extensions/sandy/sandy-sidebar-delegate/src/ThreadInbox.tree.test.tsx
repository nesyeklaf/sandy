// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const sections = [{ id: "sec_a", name: "Launch", createdAt: 0, updatedAt: 0 }];
const projects = [
  {
    id: "proj_1",
    name: "Alpha",
    isPersonal: false,
    href: "/projects/proj_1",
    settingsHref: "/projects/proj_1/settings",
  },
];

function renderTree(update = vi.fn(async () => ({})), create = vi.fn(async () => ({ id: "sec_new" }))) {
  window.localStorage.clear();
  return {
    update,
    create,
    ...renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "In launch", projectId: "proj_1", sectionId: "sec_a" }),
          thread({ id: "b", title: "Loose one", projectId: "proj_1", sectionId: null }),
        ],
        projects,
        sections,
      },
      threadActions: () => [],
      sdk: { threads: { update }, threadSections: { create } } as never,
    }),
  };
}

describe("tree layout", () => {
  it("groups sessions by section, then repo, and remembers the layout", async () => {
    renderTree();
    fireEvent.click(await screen.findByRole("radio", { name: "Tree" }));
    const launch = await screen.findByRole("region", { name: "Launch" });
    expect(within(launch).getByRole("button", { name: "Alpha (1)" })).toBeTruthy();
    expect(within(launch).getByText("In launch")).toBeTruthy();
    const loose = screen.getByRole("region", { name: "No project" });
    expect(within(loose).getByText("Loose one")).toBeTruthy();
    fireEvent.click(within(launch).getByRole("button", { name: "Launch (1)" }));
    expect(screen.queryByText("In launch")).toBeNull();
    expect(screen.getByRole("radio", { name: "Tree" }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves a session into a section from the context menu", async () => {
    const { update } = renderTree();
    fireEvent.contextMenu(await screen.findByText("Loose one"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to project…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Launch" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId: "b", sectionId: "sec_a" }));
  });

  it("creates a project from the menu and moves the session into it", async () => {
    const { update, create } = renderTree();
    fireEvent.contextMenu(await screen.findByText("Loose one"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to project…" }));
    const input = await screen.findByLabelText("New project");
    fireEvent.change(input, { target: { value: "  Umzug  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Umzug" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId: "b", sectionId: "sec_new" }));
  });
});
