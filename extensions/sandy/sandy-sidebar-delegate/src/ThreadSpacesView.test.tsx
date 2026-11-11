// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { thread, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

import { prThreads, setup } from "./test-spaces";

describe("Spaces view", () => {
  it("[closed-disclosure] [independent-collapse] discloses no session while collapsed and keeps Spaces expanded independently", async () => {
    setup({ threads: prThreads() });
    expect(await screen.findByRole("button", { name: "Launch (3)" })).toBeTruthy();
    expect(screen.queryByText("Calm one")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Launch (3)" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Launch (3)" }));
    expect(screen.queryByText("Calm one")).toBeNull();
    expect(screen.getByText("Other Space")).toBeTruthy();
  });

  it("[overlapping-counter-navigation] renders status shelves with labels and keeps overlapping PR roots in their primary shelves", async () => {
    setup({ threads: prThreads() });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (3)" }));
    const launch = screen.getByRole("region", { name: "Launch" });
    const labels = () =>
      [...launch.querySelectorAll("[data-space-shelf]")].map((node) => node.getAttribute("data-space-shelf"));
    expect(labels()).toEqual(["needs", "working", "idle"]);
    await waitFor(() => expect(within(launch).getByRole("button", { name: "2 open PR in Launch" })).toBeTruthy());
    fireEvent.click(within(launch).getByRole("button", { name: "2 open PR in Launch" }));
    expect(labels()).toEqual(["needs", "working"]);
    expect(launch.querySelector('[data-space-shelf="needs"]')?.textContent).toContain("Needs you");
    expect(within(launch).getAllByText("Asks and PR")).toHaveLength(1);
    expect(within(launch).getAllByText("Works and PR")).toHaveLength(1);
    expect(within(launch).queryByText("Calm one")).toBeNull();
    fireEvent.click(within(launch).getByRole("button", { name: "2 open PR in Launch" }));
    expect(within(launch).getByText("Calm one")).toBeTruthy();
  });

  it("labels the catch-all shelf Idle and has no Ideas shelf", async () => {
    setup({ threads: prThreads() });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (3)" }));
    const launch = screen.getByRole("region", { name: "Launch" });
    expect(launch.querySelector('[data-space-shelf="idle"]')?.textContent).toContain("Idle");
    expect(within(launch).queryByText("Ready")).toBeNull();
    expect(launch.querySelector('[data-space-shelf="ideas"]')).toBeNull();
    expect(within(launch).queryByText("Ideas")).toBeNull();
  });

  it("sorts the sessions inside every shelf by the persisted Spaces sort mode", async () => {
    const now = Date.now();
    const idle = (id: string, projectId: string, createdAt: number, updatedAt: number) =>
      thread({ id, title: id, projectId, sectionId: "sec_a", createdAt, updatedAt, latestAttentionAt: updatedAt });
    setup({
      threads: [
        idle("old-busy", "proj_1", now - 3000, now - 10),
        idle("new-quiet", "proj_2", now - 1000, now - 2000),
        idle("mid-busy", "proj_1", now - 2000, now - 20),
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (3)" }));
    const order = () =>
      within(screen.getByRole("region", { name: "Launch" }))
        .getAllByRole("link", { name: /^(old-busy|mid-busy|new-quiet)/ })
        .map((node) => node.getAttribute("aria-label")?.split(/[ ,]/)[0]);
    expect(screen.getByRole("button", { name: "Sort sessions in Spaces: Recent activity" })).toBeTruthy();
    expect(order()).toEqual(["old-busy", "mid-busy", "new-quiet"]);

    const pick = (name: string) => {
      fireEvent.keyDown(screen.getByRole("button", { name: /^Sort sessions in Spaces/ }), { key: "Enter" });
      fireEvent.click(screen.getByRole("radio", { name }), { detail: 1 });
    };
    pick("Date created");
    expect(order()).toEqual(["new-quiet", "mid-busy", "old-busy"]);
    expect(window.localStorage.getItem("sandy-sidebar:space-sort:v1")).toBe("created");
    expect(window.localStorage.getItem("sandy-sidebar:active-sort:v1")).toBe("manual");
    pick("Repo");
    expect(order()).toEqual(["old-busy", "mid-busy", "new-quiet"]);
    pick("Manual order");
    expect(order()).toEqual(["old-busy", "new-quiet", "mid-busy"]);
  });

  it("[minimal-header] shows only the urgent floor in Minimal headers", async () => {
    setup({ threads: prThreads(), settings: { spaceHeaderDensity: "minimal" } });
    const launch = await screen.findByRole("region", { name: "Launch" });
    await waitFor(() => expect(launch.querySelector('[data-space-header="minimal"]')).toBeTruthy());
    expect(within(launch).queryByRole("button", { name: /working in Launch/ })).toBeNull();
    expect(within(launch).queryByRole("button", { name: /open PR in Launch/ })).toBeNull();
  });

  it("[create-empty-space] creates an empty Space and shows the validation error on failure", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 409: Name already exists"))
      .mockResolvedValue({ id: "sec_c" });
    setup({ threads: prThreads(), sdk: { threadSections: { create } } });
    fireEvent.click(await screen.findByRole("button", { name: /New Space/ }));
    const input = screen.getByLabelText("New Space name");
    fireEvent.change(input, { target: { value: "Plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Name already exists");
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByLabelText("New Space name")).toBeNull());
  });

  it("[delete-space-only] renames a Space and deletes only after named confirmation", async () => {
    const update = vi.fn().mockResolvedValue({});
    const del = vi.fn().mockResolvedValue({});
    setup({ threads: prThreads(), sdk: { threadSections: { update, delete: del } } });
    fireEvent.click(await screen.findByRole("button", { name: "Rename Launch" }));
    const input = screen.getByLabelText("Rename Launch");
    fireEvent.change(input, { target: { value: "Ship" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ id: "sec_a", name: "Ship" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Plan" }));
    expect(del).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("group", { name: "Delete Space Plan" });
    expect(within(confirm).getByText("Delete Space “Plan”?")).toBeTruthy();
    expect(confirm.textContent).toContain("ideas and scratchpad are kept");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(screen.getByRole("region", { name: "Plan" }).closest("[aria-hidden=true]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete Space" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith({ id: "sec_b" }));
  });

  it("[compact-header] keeps the four standard positions including zeroes and names them", async () => {
    setup({ threads: prThreads() });
    const other = await screen.findByRole("region", { name: "Plan" });
    for (const label of ["needs you", "working", "open PR", "dormant"]) {
      expect(within(other).getByRole("button", { name: new RegExp(`\\d+ ${label} in Plan`) })).toBeTruthy();
    }
    expect((within(other).getByRole("button", { name: "0 working in Plan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(other).queryByRole("button", { name: /failed in Plan/ })).toBeNull();
  });

  it("[detailed-header] adds idle and repository counts without session data", async () => {
    setup({ threads: prThreads(), settings: { spaceHeaderDensity: "detailed" } });
    const launch = await screen.findByRole("region", { name: "Launch" });
    await waitFor(() => expect(within(launch).getByText("2 repositories · 1 idle")).toBeTruthy());
    expect(within(launch).queryByText("Asks and PR")).toBeNull();
  });

  it("[density-matrix] keeps five unique rows for every header and row density", async () => {
    for (const header of ["minimal", "compact", "detailed"]) {
      for (const density of ["dense", "compact", "comfortable"]) {
        const five = Array.from({ length: 5 }, (_, index) =>
          thread({ id: `t${index}`, title: `Row ${index}`, projectId: "proj_1", sectionId: "sec_a" }),
        );
        const view = setup({ threads: five, settings: { spaceHeaderDensity: header, threadDensity: density } });
        fireEvent.click(await screen.findByRole("button", { name: "Launch (5)" }));
        const launch = screen.getByRole("region", { name: "Launch" });
        await waitFor(() => expect(launch.querySelector(`[data-space-header="${header}"]`)).toBeTruthy());
        for (let index = 0; index < 5; index += 1) expect(within(launch).getAllByText(`Row ${index}`)).toHaveLength(1);
        view.unmount();
      }
    }
  });

  it("[global-filter-counts] counts only the filtered roots and keeps every Space header", async () => {
    setup({ threads: prThreads(), sessionStore: { "sandy-sidebar:project-scope:v1": JSON.stringify(["proj_2"]) } });
    expect(await screen.findByRole("button", { name: "Launch (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan (0)" })).toBeTruthy();
    expect(screen.getAllByText("filtered").length).toBeGreaterThan(0);
  });

  it("[zero-and-transient-filter] ignores zero counters and drops the filter on reload", async () => {
    const view = setup({ threads: prThreads() });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (3)" }));
    const launch = screen.getByRole("region", { name: "Launch" });
    fireEvent.click(within(launch).getByRole("button", { name: "0 dormant in Launch" }));
    expect(within(launch).getByText("Calm one")).toBeTruthy();
    fireEvent.click(within(launch).getByRole("button", { name: "1 needs you in Launch" }));
    expect(within(launch).queryByText("Calm one")).toBeNull();
    view.unmount();
    setup({ threads: prThreads(), storage: { "sandy-sidebar:space-expansion:v1": JSON.stringify(["sec_a"]) } });
    const reloaded = await screen.findByRole("region", { name: "Launch" });
    expect(within(reloaded).getByText("Calm one")).toBeTruthy();
    expect(within(reloaded).getByRole("button", { name: "1 needs you in Launch" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("[keyboard-focus] keeps focus on the toggle while aria-expanded tracks state", async () => {
    setup({ threads: prThreads() });
    const toggle = await screen.findByRole("button", { name: "Launch (3)" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    const chip = within(screen.getByRole("region", { name: "Launch" })).getByRole("button", {
      name: "1 needs you in Launch",
    });
    chip.focus();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(chip);
  });

  it("[stable-realtime-update] updates counts live while order and expansion stay put", async () => {
    let rows: unknown[] = [];
    const rendered = setup({ threads: prThreads(), lifecycleRows: () => rows });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (3)" }));
    const order = () => screen.getAllByRole("region").map((node) => node.getAttribute("aria-label"));
    const before = order();
    expect(screen.getByText("Calm one")).toBeTruthy();
    rows = [{ threadId: "calm", settledAt: null, snoozedUntil: Date.now() + 3_600_000, snoozedAt: Date.now() }];
    await rendered.emitRealtime("lifecycle", { threadIds: ["calm"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Launch (3)" })).toBeTruthy());
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Launch" })).getByText("Snoozed")).toBeTruthy(),
    );
    expect(order()).toEqual(before);
    expect(screen.getByRole("button", { name: "Launch (3)" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("[move-root-tree] moves a root between Spaces through threads.update", async () => {
    const update = vi.fn().mockResolvedValue({});
    setup({ threads: prThreads(), sdk: { threads: { update } } });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (3)" }));
    fireEvent.contextMenu(await screen.findByText("Calm one"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Space…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Plan" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId: "calm", sectionId: "sec_b" }));
  });

  it("[mutation-reconciliation] reports a failed delete and keeps the Space", async () => {
    const del = vi.fn().mockRejectedValue(new Error("HTTP 404: gone"));
    setup({ threads: prThreads(), sdk: { threadSections: { delete: del } } });
    fireEvent.click(await screen.findByRole("button", { name: "Delete Plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Space" }));
    await waitFor(() => expect(del).toHaveBeenCalled());
    expect((await screen.findByRole("alert")).textContent).toBe("gone");
    expect(screen.getByRole("group", { name: "Delete Space Plan" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Plan (1)" })).toBeTruthy();
  });

  it("cancels the delete confirmation with Escape or Cancel and returns focus to the trigger", async () => {
    const del = vi.fn().mockResolvedValue({});
    setup({ threads: prThreads(), sdk: { threadSections: { delete: del } } });
    const trigger = await screen.findByRole("button", { name: "Delete Plan" });
    fireEvent.click(trigger);
    const confirm = await screen.findByRole("group", { name: "Delete Space Plan" });
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Delete Space Plan" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Delete Space Plan" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes once when the confirm button is clicked twice", async () => {
    let finish: () => void = () => {};
    const del = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    setup({ threads: prThreads(), sdk: { threadSections: { delete: del } } });
    fireEvent.click(await screen.findByRole("button", { name: "Delete Plan" }));
    const confirmButton = await screen.findByRole("button", { name: "Delete Space" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(del).toHaveBeenCalledTimes(1);
    finish();
  });

  it("[create-failure] shows the server's rejection and retains no phantom Space", async () => {
    const create = vi.fn().mockRejectedValue(new Error("HTTP 400: Name is required"));
    setup({ threads: prThreads(), sdk: { threadSections: { create } } });
    fireEvent.click(await screen.findByRole("button", { name: /New Space/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Name is required");
    expect(screen.getAllByRole("region")).toHaveLength(2);
  });
});
