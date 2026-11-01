// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { app, inbox, sidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("SANDY Sidebar registration", () => {
  it("opens project settings and confirms project edits from the card menu", async () => {
    const renameProject = vi.fn(() => ({ ok: true }));
    const removeProject = vi.fn(() => ({ ok: true }));
    const addProjectPath = vi.fn(() => ({ ok: true }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ title: "Project card" })],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      context: { projectId: "proj_other", threadId: "thr_other" },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        projectPathHosts: () => ({ hosts: [{ id: "host_2", name: "Laptop" }] }),
        renameProject,
        removeProject,
        addProjectPath,
      },
    });
    const openMenu = async () => {
      fireEvent.contextMenu(await screen.findByText("Project card"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Repo" }));
      return (await screen.findByText("Repo settings")).closest<HTMLElement>('[role="menu"]')!;
    };
    const settingsMenu = await openMenu();
    expect(settingsMenu.hasAttribute("data-sandy-plugin-root")).toBe(true);
    expect(within(settingsMenu).getByText("Repo settings").getAttribute("href")).toBe("/projects/proj_1/settings");
    fireEvent.keyDown(settingsMenu, { key: "Escape" });

    fireEvent.click(within(await openMenu()).getByText("Rename repo"));
    let dialog = await screen.findByRole("dialog", { name: "Rename repo" });
    expect(dialog.hasAttribute("data-sandy-plugin-root")).toBe(true);
    expect(dialog.hasAttribute("data-sandy-portaled-overlay")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Repo name"), { target: { value: "Renamed" } });
    fireEvent.click(within(dialog).getByText("Save"));
    await waitFor(() => expect(renameProject).toHaveBeenCalledWith({ projectId: "proj_1", name: "Renamed" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const menu = await openMenu();
    await waitFor(() => expect(within(menu).getByText("Add local path").getAttribute("data-disabled")).toBeNull());
    fireEvent.click(within(menu).getByText("Add local path"));
    dialog = await screen.findByRole("dialog", { name: "Add local path" });
    fireEvent.change(within(dialog).getByLabelText("Folder path"), { target: { value: "/workspace/sandy" } });
    fireEvent.click(within(dialog).getByText("Save"));
    await waitFor(() =>
      expect(addProjectPath).toHaveBeenCalledWith({ projectId: "proj_1", hostId: "host_2", path: "/workspace/sandy" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(await openMenu()).getByText("Remove repo"));
    dialog = await screen.findByRole("dialog", { name: "Remove repo" });
    expect((within(dialog).getByRole("button", { name: "Remove repo" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(removeProject).not.toHaveBeenCalled();
    fireEvent.click(within(await openMenu()).getByText("Remove repo"));
    dialog = await screen.findByRole("dialog", { name: "Remove repo" });
    fireEvent.change(within(dialog).getByLabelText("Repo name"), { target: { value: "sandy" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove repo" }));
    await waitFor(() => expect(removeProject).toHaveBeenCalledWith({ projectId: "proj_1", confirmation: "sandy" }));
    expect(rendered.navigateCalls).toEqual([]);
  });

  it("registers exactly one thread list", () => {
    expect(app.threadLists).toHaveLength(1);
    expect(inbox.id).toBe("inbox");
    expect(inbox.title).toBe("SANDY Sidebar");
  });

  it("registers one custom settings page", () => {
    expect(app.settingsSections).toHaveLength(1);
    expect(sidebarSettings.id).toBe("sidebar-settings");
    expect(sidebarSettings.title).toBeUndefined();
  });
});
