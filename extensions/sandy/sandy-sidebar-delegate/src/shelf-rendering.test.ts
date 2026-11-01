// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

describe("shelf render isolation", () => {
  it("leaves active and other shelved rows alone while toggling a large settled list, including with project colors", async () => {
    const reads = new Map<string, ReturnType<typeof vi.fn>>();
    const observedThread = (id: string, title: string) => {
      const candidate = thread({ id, title });
      const readTitle = vi.fn(() => title);
      Object.defineProperty(candidate, "title", { get: readTitle, enumerable: true });
      reads.set(id, readTitle);
      return candidate;
    };
    const titleReads = (id: string) => reads.get(id)!.mock.calls.length;
    const settled = Array.from({ length: 60 }, (_, index) => observedThread(`settled-${index}`, `Finished ${index}`));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [observedThread("active", "Active work"), observedThread("parked", "Parked work"), ...settled],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          inactiveThreadsEnabled: false,
          projectColorsEnabled: true,
        }),
        getProjectColors: () => ({ colors: { proj_1: "#123456" } }),
        listLifecycle: () => ({
          rows: [
            { threadId: "parked", parkedAt: 100, settledAt: null, snoozedUntil: null, snoozedAt: null },
            ...settled.map((candidate, index) => ({
              threadId: candidate.id,
              settledAt: 1000 - index,
              snoozedUntil: null,
              snoozedAt: null,
            })),
          ],
        }),
      },
    });
    const parked = await screen.findByRole("region", { name: "Parked" });
    fireEvent.click(within(parked).getByRole("button", { expanded: false }));
    await screen.findByRole("link", { name: /Parked work/ });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    await waitFor(() => expect(titleReads("active")).toBeGreaterThan(0));
    const activeRenders = titleReads("active");
    const parkedRenders = titleReads("parked");
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 25 more" }));
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 25 more" }));
    expect(within(shelf).getAllByRole("link")).toHaveLength(60);
    for (let i = 0; i < 3; i++) {
      fireEvent.click(within(shelf).getByRole("button", { expanded: true }));
      expect(within(shelf).queryAllByRole("link")).toHaveLength(0);
      fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
      expect(within(shelf).getAllByRole("link")).toHaveLength(60);
    }
    expect(titleReads("active")).toBe(activeRenders);
    expect(titleReads("parked")).toBe(parkedRenders);
    // An active-shelf toggle must also leave the loaded settled rows alone.
    const settledRenders = titleReads("settled-0");
    fireEvent.click(
      within(screen.getByRole("region", { name: "Needs you" })).getByRole("button", {
        name: /^Needs you/,
        expanded: true,
      }),
    );
    expect(titleReads("settled-0")).toBe(settledRenders);
  });
});
