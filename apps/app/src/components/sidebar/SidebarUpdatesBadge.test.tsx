// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@sandy/shared-ui/tooltip";
import type { Host } from "@sandy/domain";
import { makeHost } from "@sandy/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UpdateInventory,
  UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makePluginListItem } from "@/test/fixtures/plugins";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";

const useUpdateInventoryMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useUpdateInventory", () => ({
  useUpdateInventory: useUpdateInventoryMock,
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useUpdateInventoryMock.mockReset();
});

function host(id: string): Host {
  return makeHost({
    id,
    name: id,
  });
}

function machine(
  overrides: Partial<UpdateInventoryMachine>,
): UpdateInventoryMachine {
  return {
    host: host("host-1"),
    isPrimary: true,
    canRetryDaemonUpdate: false,
    ...overrides,
  };
}

const NO_PLUGIN_UPDATES: UpdateInventory["plugins"] = {
  trackedCount: 0,
  items: [],
};

function renderBadge(inventory: Partial<UpdateInventory>) {
  useUpdateInventoryMock.mockReturnValue({
    isLoading: false,
    machines: [],
    plugins: NO_PLUGIN_UPDATES,
    actionableCount: 0,
    hasAttention: false,
    ...inventory,
  });
  const { wrapper } = createQueryClientTestHarness();
  return render(<BadgeHarness />, { wrapper });
}

function BadgeHarness() {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <SidebarUpdatesBadge />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe("SidebarUpdatesBadge", () => {
  it("renders nothing when no update needs attention", () => {
    const result = renderBadge({});
    expect(result.container.innerHTML).toBe("");
  });

  it("counts plugin updates but not blocked plugin candidates", () => {
    const plugin = (id: string) =>
      makePluginListItem({ id, source: `npm:@acme/${id}@^1.0.0` });
    renderBadge({
      plugins: {
        trackedCount: 3,
        items: [
          { kind: "update", plugin: plugin("notes"), version: "1.1.0" },
          { kind: "update", plugin: plugin("linear"), version: "1.2.0" },
          {
            kind: "blocked",
            plugin: plugin("legacy"),
            version: "2.0.0",
            reasons: ["engines.sandy requires >=9.0.0"],
          },
        ],
      },
    });

    const chip = screen.getByRole("link", {
      name: "2 plugin updates available",
    });
    expect(chip.getAttribute("href")).toBe("/settings/updates");
    expect(chip.textContent).toBe("2");
  });

  it("acknowledges offline machines across reloads without suppressing real updates", () => {
    const offline = machine({
      host: makeHost({
        id: "offline",
        name: "Work laptop",
        status: "disconnected",
        lastSeenAt: 100,
        lastRejectedProtocolVersion: 1,
      }),
      canRetryDaemonUpdate: true,
    });
    renderBadge({ machines: [offline] });
    const warning = screen.getByRole("link", {
      name: "Work laptop is offline",
    });
    expect(warning.getAttribute("href")).toBe("/settings/machines");
    fireEvent.click(warning);
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
    cleanup();

    const reloaded = renderBadge({ isLoading: true });
    useUpdateInventoryMock.mockReturnValue({
      isLoading: false,
      plugins: NO_PLUGIN_UPDATES,
      machines: [
        {
          ...offline,
          host: { ...offline.host, lastRejectedProtocolVersion: 2 },
        },
      ],
    });
    reloaded.rerender(<BadgeHarness />);
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
    cleanup();

    renderBadge({
      machines: [{ ...offline, host: { ...offline.host, lastSeenAt: 200 } }],
    });
    expect(screen.getByTestId("sidebar-machines-attention-badge")).toBeTruthy();
  });

  it("keeps acknowledged hosts quiet when peers recover and reports new issues", () => {
    const first = machine({
      host: makeHost({ id: "first", status: "disconnected" }),
    });
    const second = machine({
      host: makeHost({ id: "second", status: "disconnected" }),
    });
    const result = renderBadge({ machines: [first, second] });
    fireEvent.click(screen.getByRole("link", { name: "Machines offline" }));
    useUpdateInventoryMock.mockReturnValue({
      isLoading: false,
      plugins: NO_PLUGIN_UPDATES,
      machines: [first],
    });
    result.rerender(<BadgeHarness />);
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();

    useUpdateInventoryMock.mockReturnValue({
      isLoading: false,
      plugins: NO_PLUGIN_UPDATES,
      machines: [
        first,
        { ...second, host: { ...second.host, status: "connected" } },
      ],
    });
    result.rerender(<BadgeHarness />);
    useUpdateInventoryMock.mockReturnValue({
      isLoading: false,
      plugins: NO_PLUGIN_UPDATES,
      machines: [first, second],
    });
    result.rerender(<BadgeHarness />);
    expect(screen.getByRole("link", { name: "Machines offline" })).toBeTruthy();
  });

  it("does not warn about intentionally paused machines or ephemeral hosts", () => {
    const paused = makeHost({ status: "disconnected" });
    paused.lifecycle.phase = "suspended";
    renderBadge({
      machines: [
        machine({ host: paused }),
        machine({
          host: makeHost({ status: "disconnected", type: "ephemeral" }),
        }),
      ],
    });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
  });
});
