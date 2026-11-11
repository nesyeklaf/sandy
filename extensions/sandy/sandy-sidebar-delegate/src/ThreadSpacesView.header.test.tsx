// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { thread, loadInboxApp } from "./test-inbox";
import { prThreads, recent, setup } from "./test-spaces";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("Space headers", () => {
  it("shows compact stats as fixed icon-and-count slots with accessible names and no words", async () => {
    setup({ threads: prThreads() });
    const launch = await screen.findByRole("region", { name: "Launch" });
    const slots = ["needs you", "working", "open PR", "dormant"].map((label) =>
      within(launch).getByRole("button", { name: new RegExp("^\\d+ " + label + " in Launch$") }),
    );
    for (const slot of slots) {
      expect(slot.querySelector("svg")).toBeTruthy();
      expect(slot.textContent).toMatch(/^\d+$/);
    }
    expect(slots.map((slot) => slot.getAttribute("aria-label"))).toEqual([
      "1 needs you in Launch",
      "1 working in Launch",
      "2 open PR in Launch",
      "0 dormant in Launch",
    ]);
  });

  it("names minimal urgent badges and keeps them out of the toggle button", async () => {
    setup({ threads: prThreads(), settings: { spaceHeaderDensity: "minimal" } });
    const badge = await screen.findByRole("button", { name: "1 needs you in Launch" });
    expect(badge.querySelector("svg")).toBeTruthy();
    expect(badge.closest("[aria-expanded]")).toBeNull();
    fireEvent.click(badge);
    expect(within(screen.getByRole("region", { name: "Launch" })).queryByText("Calm one")).toBeNull();
  });

  it("shows words in detailed stats and a visible clear control for a local filter", async () => {
    setup({ threads: prThreads(), settings: { spaceHeaderDensity: "detailed" } });
    const chip = await screen.findByRole("button", { name: "1 needs you in Launch" });
    expect(chip.textContent).toContain("needs you");
    fireEvent.click(chip);
    const launch = screen.getByRole("region", { name: "Launch" });
    expect(within(launch).getByText("Filter: needs you")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Plan" })).queryByText(/Filter:/)).toBeNull();
    fireEvent.click(within(launch).getByRole("button", { name: "Show all in Launch" }));
    expect(within(launch).queryByText(/Filter:/)).toBeNull();
    expect(within(launch).getByText("Calm one")).toBeTruthy();
  });

  it("counts a ready session once and a dormant one separately in the detailed line", async () => {
    const old = { updatedAt: 0, latestAttentionAt: 0 };
    setup({
      threads: [
        thread({ id: "w", title: "Waiting", projectId: "proj_1", sectionId: "sec_a", ...recent() }),
        thread({ id: "d", title: "Old", projectId: "proj_2", sectionId: "sec_a", ...old }),
      ],
      settings: { spaceHeaderDensity: "detailed" },
    });
    await waitFor(() => expect(screen.getByText("2 repositories · 1 ready")).toBeTruthy());
    expect(screen.getByRole("button", { name: "1 dormant in Launch" })).toBeTruthy();
  });

  it("keeps archived sessions out until Show archived is on and never counts them as signals", async () => {
    const archived = thread({
      id: "gone",
      title: "Gone",
      projectId: "proj_1",
      sectionId: "sec_a",
      isArchived: true,
      ...recent(),
    });
    const first = setup({ threads: [...prThreads(), archived] });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (3)" }));
    expect(screen.queryByText("Gone")).toBeNull();
    first.unmount();
    setup({ threads: [...prThreads(), archived], storage: { "sandy-sidebar:show-archived:v1": "true" } });
    fireEvent.click(await screen.findByRole("button", { name: "Launch (4)" }));
    expect(screen.getByText("Gone")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 needs you in Launch" })).toBeTruthy();
  });

  it("renders zero counts in neutral muted text and urgent counts on tinted plates", async () => {
    setup({ threads: prThreads() });
    const launch = await screen.findByRole("region", { name: "Launch" });
    const zero = within(launch).getByRole("button", { name: "0 dormant in Launch" });
    expect(zero.className).toContain("text-muted-foreground");
    expect(zero.className).not.toContain("opacity");
    const needs = within(launch).getByRole("button", { name: "1 needs you in Launch" });
    expect(needs.className).toContain("bg-amber-500/15");
    expect(needs.className).toContain("text-amber-500");
    const open = within(launch).getByRole("button", { name: "2 open PR in Launch" });
    expect(open.className).not.toContain("violet");
  });

  it("keeps mobile touch sizes on the toggle and the count chips and an amber needs shelf", async () => {
    setup({ threads: prThreads() });
    const launch = await screen.findByRole("region", { name: "Launch" });
    expect(within(launch).getByRole("button", { name: /^Launch \(/ }).className).toContain("max-md:min-h-11");
    expect(within(launch).getByRole("button", { name: "1 working in Launch" }).className).toContain("max-md:min-h-8");
    expect(within(launch).getByRole("button", { name: "1 working in Launch" }).className).toContain("max-md:min-w-8");
    fireEvent.click(within(launch).getByRole("button", { name: /^Launch \(/ }));
    const label = launch.querySelector('[data-space-shelf="needs"] p');
    expect(label?.className).toContain("text-amber-500");
  });

  it("keeps a visible Pinned marker on a pinned Space row at every row density and none on unpinned rows", async () => {
    for (const threadDensity of ["dense", "compact", "comfortable"]) {
      const pinned = thread({ id: "pin", title: "Pinned one", sectionId: "sec_b", isPinned: true, ...recent() });
      const plain = thread({ id: "plain", title: "Plain one", sectionId: "sec_b", ...recent() });
      const view = setup({ threads: [...prThreads(), pinned, plain], settings: { threadDensity } });
      const plan = await screen.findByRole("region", { name: "Plan" });
      const toggle = within(plan).getByRole("button", { name: /^Plan \(/ });
      if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
      const marks = within(plan).getAllByRole("img", { name: "Pinned" });
      expect(marks).toHaveLength(1);
      expect(marks[0]?.className).not.toContain("opacity-0");
      expect(marks[0]?.closest("[data-space-pinned-row]")?.textContent).toContain("Pinned one");
      expect(within(plan).getByText("Plain one").closest("[data-space-pinned-row]")).toBeNull();
      view.unmount();
    }
  });

  it("places the delete confirmation after the whole header, outside it and inside the Space", async () => {
    setup({ threads: prThreads(), settings: { spaceHeaderDensity: "detailed" } });
    const plan = await screen.findByRole("region", { name: "Plan" });
    fireEvent.click(within(plan).getByRole("button", { name: "Delete Plan" }));
    const group = within(plan).getByRole("group", { name: "Delete Space Plan" });
    const header = plan.querySelector("[data-space-header]") as HTMLElement;
    expect(header.contains(group)).toBe(false);
    expect(header.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plan.contains(group)).toBe(true);
    expect(within(header).getByRole("button", { name: /^Plan \(/ })).toBeTruthy();
    expect(within(header).getByRole("button", { name: /working in Plan$/ })).toBeTruthy();
  });
});
