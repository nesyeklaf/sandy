// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const threads = [
  thread({ id: "busy", title: "Busy work", indicator: "runtime", indicatorLabel: "Working" }),
  thread({ id: "asking", title: "Asking work", hasPendingInteraction: true }),
  thread({ id: "idle", title: "Idle work" }),
  thread({ id: "pinned", title: "Pinned work", isPinned: true }),
];

function renderInbox(initial: Partial<typeof defaultSidebarSettings> = {}) {
  let saved = { ...defaultSidebarSettings, ...initial };
  const writes: unknown[] = [];
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads,
      projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      getSidebarSettings: () => saved,
      updateSidebarSettings: (input) => {
        writes.push(input);
        saved = { ...saved, ...(input as Partial<typeof saved>) };
        return saved;
      },
      listLifecycle: () => ({ rows: [] }),
    },
  });
  return { writes };
}

const density = (title: string) =>
  screen.getByRole("link", { name: title }).closest("[data-parent-card]")?.getAttribute("data-row-density");

describe("density", () => {
  it.each([
    ["comfortable", { busy: "comfortable", asking: "comfortable", idle: "comfortable" }],
    ["compact", { busy: "compact", asking: "compact", idle: "compact" }],
    ["dense", { busy: "dense", asking: "dense", idle: "dense" }],
    ["auto", { busy: "comfortable", asking: "comfortable", idle: "compact" }],
  ] as const)("draws every row at %s density", async (threadDensity, expected) => {
    renderInbox({ threadDensity });
    await screen.findByRole("link", { name: "Busy work" });
    await waitFor(() => expect(density("Busy work")).toBe(expected.busy));
    expect(density("Asking work")).toBe(expected.asking);
    expect(density("Idle work")).toBe(expected.idle);
  });

  it("switches density from the View sheet and saves it", async () => {
    const { writes } = renderInbox();
    await screen.findByRole("link", { name: "Busy work" });
    expect(density("Idle work")).toBe("comfortable");
    fireEvent.click(screen.getByRole("button", { name: "View options: Comfortable" }));
    const group = await screen.findByRole("radiogroup", { name: "Density" });
    expect([...group.querySelectorAll("label")].map((label) => label.textContent)).toEqual([
      "Auto",
      "Comfortable",
      "Compact",
      "Dense",
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "Dense" }));
    await waitFor(() => expect(density("Idle work")).toBe("dense"));
    expect(writes).toEqual([{ threadDensity: "dense" }]);
    expect(screen.getByRole("button", { name: "View options: Dense" })).toBeDefined();
  });

  it("overrides one shelf's density from its menu and leaves the others alone", async () => {
    const { writes } = renderInbox();
    await screen.findByRole("link", { name: "Idle work" });
    fireEvent.click(screen.getByRole("button", { name: "Density for Waiting: Default" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Compact" }));
    await waitFor(() => expect(density("Idle work")).toBe("compact"));
    expect(density("Pinned work")).toBe("comfortable");
    expect(writes).toEqual([
      {
        shelfDensities: {
          pinned: "default",
          needs: "default",
          failed: "default",
          working: "default",
          review: "default",
          waiting: "compact",
          merged: "default",
        },
      },
    ]);
    expect(screen.getByRole("button", { name: "Density for Waiting: Compact" })).toBeDefined();
  });

  it("keeps pinned threads full below Comfortable when asked to", async () => {
    renderInbox({ threadDensity: "dense", keepPinnedThreadsFull: true });
    await screen.findByRole("link", { name: "Pinned work" });
    await waitFor(() => expect(density("Idle work")).toBe("dense"));
    expect(density("Pinned work")).toBe("comfortable");
  });
});
