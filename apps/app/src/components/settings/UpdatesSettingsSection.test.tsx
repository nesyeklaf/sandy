// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "@sandy/domain";
import { makeHost as makeHostFixture } from "@sandy/test-helpers/domain-fixtures";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@sandy/host-daemon-contract";
import { TooltipProvider } from "@sandy/shared-ui/tooltip";
import { appToast } from "@/components/ui/app-toast";
import { makePluginListItem } from "@/test/fixtures/plugins";
import { buildUpdateInventoryPlugins } from "@/hooks/useUpdateInventory";
import {
  useUpdateInventory,
  type UpdateInventory,
  type UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import {
  UpdateActionButton,
  UpdatesSettingsSection,
} from "./UpdatesSettingsSection";

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/sdk", async () => {
  const { makeSystemConfig } = await import("@/test/fixtures/system-config");
  return {
    sdk: {
      system: {
        config: vi.fn(async () =>
          makeSystemConfig({ primaryHostId: "host_primary" }),
        ),
      },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock("@/hooks/useUpdateInventory", async (original) => ({
  ...(await original<typeof import("@/hooks/useUpdateInventory")>()),
  useUpdateInventory: vi.fn(),
}));

const hostDaemon = vi.hoisted(() => ({
  localDaemonHostId: null as string | null,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: hostDaemon.localDaemonHostId,
  }),
}));

const retryHostUpdateMutateMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/mutations/host-mutations", () => ({
  useRetryHostUpdate: () => ({
    isPending: false,
    mutate: retryHostUpdateMutateMock,
    variables: undefined,
  }),
}));

const startPluginUpdateMock = vi.hoisted(() => vi.fn());
const pluginUpdateJobs = vi.hoisted(() => ({
  current: [] as import("@sandy/server-contract").PluginUpdateJob[],
}));

vi.mock("@/hooks/queries/plugin-catalog-queries", () => ({
  usePluginUpdateCheck: () => ({ isFetching: false }),
}));

vi.mock("@/hooks/queries/plugin-update-job-queries", async (original) => ({
  ...(await original<
    typeof import("@/hooks/queries/plugin-update-job-queries")
  >()),
  startPluginUpdate: startPluginUpdateMock,
  usePluginUpdateJobs: () => ({ data: pluginUpdateJobs.current }),
}));

function makeHost(overrides: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return makeHostFixture({
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });
}

function makeMachine(args: {
  host: Host;
  isPrimary?: boolean;
  canRetryDaemonUpdate?: boolean;
}): UpdateInventoryMachine {
  return {
    host: args.host,
    isPrimary: args.isPrimary ?? false,
    canRetryDaemonUpdate: args.canRetryDaemonUpdate ?? false,
  };
}

function makeInventory(overrides: Partial<UpdateInventory>): UpdateInventory {
  return {
    isLoading: false,
    machines: [
      makeMachine({
        host: makeHost({ id: "host_primary", name: "workstation" }),
        isPrimary: true,
      }),
    ],
    plugins: { trackedCount: 0, items: [] },
    pluginAttentionCount: 0,
    actionableCount: 0,
    hasAttention: false,
    ...overrides,
  };
}

function renderSection(): void {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <UpdatesSettingsSection />
        </QueryClientProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const useUpdateInventoryMock = vi.mocked(useUpdateInventory);

function useWebApp(): void {
  useUpdateInventoryMock.mockReturnValue(makeInventory({}));
}

beforeEach(() => {
  hostDaemon.localDaemonHostId = null;
  pluginUpdateJobs.current = [];
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("UpdatesSettingsSection", () => {
  it("does not call an offline fleet all in sync", async () => {
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: makeHost({
              id: "host_1",
              name: "homelab",
              status: "disconnected",
            }),
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("homelab is offline.")).toBeDefined();
    expect(screen.queryByText(/Nothing to update/)).toBeNull();
    expect(screen.queryByText(/all in sync/)).toBeNull();
    expect(document.querySelector("[data-updates-machine]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show machines" }));
    const row = document.querySelector<HTMLElement>(
      '[data-updates-machine="host_1"]',
    );
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Offline")).toBeDefined();
    expect(
      within(row as HTMLElement).queryByRole("button", { name: "homelab" }),
    ).toBeNull();
  });

  it("lists only machines that need attention and folds the rest into the footer", () => {
    const stalledHost = makeHost({
      id: "host_3",
      name: "homelab",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      updatedAt: Date.now() - 3 * 60 * 1000,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: makeHost({ id: "host_1", name: "workstation" }),
          }),
          makeMachine({
            host: makeHost({
              id: "host_2",
              name: "studio-mac",
              status: "disconnected",
            }),
          }),
          makeMachine({
            host: stalledHost,
            canRetryDaemonUpdate: true,
          }),
        ],
      }),
    );

    renderSection();

    expect(document.querySelectorAll("[data-updates-machine]")).toHaveLength(1);
    expect(screen.getByText("homelab")).toBeDefined();
    expect(screen.queryByText("workstation")).toBeNull();
    expect(screen.queryByText("studio-mac")).toBeNull();
    expect(
      screen.getByText("2 other machines have nothing to update"),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /^Failed · Retry on/ }),
    ).toBeDefined();

    const showAll = screen.getByRole("button", { name: "Show all" });
    expect(showAll.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(showAll);

    expect(
      [...document.querySelectorAll("[data-updates-machine]")].map((row) =>
        row.getAttribute("data-updates-machine"),
      ),
    ).toEqual(["host_3", "host_1", "host_2"]);
    expect(screen.getByText("Offline")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(document.querySelectorAll("[data-updates-machine]")).toHaveLength(1);
  });

  it("treats a recent daemon protocol mismatch as an automatic update", () => {
    const host = makeHost({
      id: "host_1",
      name: "homelab",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host,
            canRetryDaemonUpdate: true,
          }),
        ],
      }),
    );

    renderSection();

    const row = document.querySelector<HTMLElement>(
      '[data-updates-machine="host_1"]',
    );
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("homelab")).toBeDefined();
    expect(within(row as HTMLElement).getByText("Updating sandy")).toBeDefined();
    expect(
      row?.querySelector('[data-update-state="in-progress"]'),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.queryByText(/can't connect/i)).toBeNull();
    expect(screen.queryByText("Offline")).toBeNull();
  });

  it("explains and retries a daemon update that has stalled", () => {
    const host = makeHost({
      id: "host_1",
      name: "homelab",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      updatedAt: Date.now() - 3 * 60 * 1000,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host,
            canRetryDaemonUpdate: true,
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("homelab")).toBeDefined();
    expect(screen.queryByText("1 needs attention")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Failed · Retry on homelab now" }),
    ).toBeDefined();
    expect(screen.queryByText("1 machine needs attention")).toBeNull();
    expect(screen.queryByText(/daemon protocol/)).toBeNull();
    expect(
      document.querySelector('[data-updates-machine="host_1"]')?.innerHTML,
    ).not.toContain("bg-surface-destructive");
    expect(screen.queryByText(/^Up to date/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Update didn't finish").className).toContain(
      "text-destructive",
    );
    expect(
      screen.getAllByRole("button", { name: /^Failed · Retry on/ }),
    ).toHaveLength(1);

    expect(
      screen.queryByRole("button", { name: /Update all .* machines now/ }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Failed · Retry on homelab now",
      }),
    );
    expect(retryHostUpdateMutateMock).toHaveBeenCalledWith(
      host.id,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("names a machine running a newer sandy than the server", () => {
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: makeHost({
              id: "host_1",
              name: "homelab",
              status: "disconnected",
              lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
            }),
            canRetryDaemonUpdate: false,
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("Update this app to reconnect")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Update homelab now/ }),
    ).toBeNull();
  });

  it("sweeps every machine stalled on the same sandy update", () => {
    const stalled = ["workstation", "studio-mac", "homelab"].map(
      (name, index) =>
        makeHost({
          id: `host_${index}`,
          name,
          status: "disconnected",
          lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
          updatedAt: Date.now() - 3 * 60 * 1000,
        }),
    );
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: stalled.map((host) =>
          makeMachine({ host, canRetryDaemonUpdate: true }),
        ),
      }),
    );

    renderSection();

    expect(screen.queryByText(/^Up to date/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Update all 3 machines now",
      }),
    );
    expect(retryHostUpdateMutateMock).toHaveBeenCalledTimes(3);
    for (const host of stalled) {
      expect(retryHostUpdateMutateMock).toHaveBeenCalledWith(host.id);
    }
    expect(
      screen.getByRole("button", {
        name: "Failed · Retry on studio-mac now",
      }),
    ).toBeDefined();
  });

  it("badges the client-local daemon independently from the server machine", async () => {
    const primary = makeHost({ id: "host_primary", name: "workstation" });
    const local = makeHost({ id: "host_local", name: "studio-mac" });
    hostDaemon.localDaemonHostId = local.id;
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: primary,
            isPrimary: true,
          }),
          makeMachine({
            host: local,
          }),
        ],
      }),
    );

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Show machines" }));

    const primaryHeading = document.querySelector<HTMLElement>(
      '[data-updates-machine="host_primary"]',
    )!;
    const localHeading = document.querySelector<HTMLElement>(
      '[data-updates-machine="host_local"]',
    )!;
    await waitFor(() => {
      expect(
        within(primaryHeading)
          .getByText("Server")
          .hasAttribute("data-machine-tag"),
      ).toBe(true);
    });
    expect(primaryHeading.textContent).not.toContain("This machine");
    expect(localHeading.textContent).toContain("This machine");
    expect(within(localHeading).queryByText("Server")).toBeNull();
  });

  it("badges a lone server machine without marking it as this machine", async () => {
    const primary = makeHost({ id: "host_primary", name: "workstation" });
    hostDaemon.localDaemonHostId = primary.id;
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: primary,
            isPrimary: true,
          }),
        ],
      }),
    );

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Show machines" }));

    const primaryHeading = document.querySelector<HTMLElement>(
      '[data-updates-machine="host_primary"]',
    )!;
    await waitFor(() => {
      expect(
        within(primaryHeading)
          .getByText("Server")
          .hasAttribute("data-machine-tag"),
      ).toBe(true);
    });
    expect(primaryHeading.textContent).not.toContain("This machine");
  });

  it("ignores repeat Retry clicks while the retry is running", () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <UpdateActionButton
          label="Retry on homelab now"
          icon="RotateCcw"
          loading
          onClick={onClick}
        />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry on homelab now" }),
    );

    expect(onClick).not.toHaveBeenCalled();
  });

  it("updates tracking plugins from the Plugins section and leaves blocked ones alone", async () => {
    useWebApp();
    startPluginUpdateMock.mockImplementation(async (pluginId: string) => ({
      id: `job_${pluginId}`,
      pluginId,
      displayName: pluginId,
      state: "queued",
    }));
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        plugins: buildUpdateInventoryPlugins([
          makePluginListItem({
            id: "notes",
            name: "Notes",
            source: "npm:@acme/notes@^1.0.0",
            version: "1.0.0",
            updateState: {
              outcome: "update-available",
              availableVersion: "1.2.0",
              availableLabel: "1.2.0",
            },
          }),
          makePluginListItem({
            id: "linear",
            name: "Linear",
            source: "git:github.com/acme/linear@^0.8.0",
            version: "0.8.0",
            updateState: {
              outcome: "update-available",
              availableVersion: "0.8.4",
              availableLabel: "0.8.4",
            },
          }),
          makePluginListItem({
            id: "legacy",
            name: "Legacy",
            source: "npm:@acme/legacy@^2.0.0",
            version: "2.0.0",
            updateState: {
              outcome: "incompatible",
              blockedVersion: "3.0.0",
              blockedLabel: "3.0.0",
              blockedReasons: ["engines.sandy requires >=9.0.0"],
            },
          }),
        ]),
      }),
    );

    renderSection();

    const legacy = document.querySelector('[data-plugin-update-row="legacy"]');
    expect(legacy?.textContent).toContain("3.0.0: engines.sandy requires >=9.0.0");
    expect(within(legacy as HTMLElement).queryByRole("button")).toBeNull();
    expect(
      within(legacy as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/settings/plugins/legacy?view=installed");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Update available · Update Notes to 1.2.0",
      }),
    );
    expect(startPluginUpdateMock).toHaveBeenCalledTimes(1);
    expect(startPluginUpdateMock).toHaveBeenLastCalledWith("notes");

    fireEvent.click(
      screen.getByRole("button", { name: "Update all 2 plugins" }),
    );
    expect(startPluginUpdateMock.mock.calls.slice(1)).toEqual([
      ["linear"],
      ["notes"],
    ]);
  });

  it("tracks plugin update jobs on their rows and counts through the batch", () => {
    useWebApp();
    const plugin = (id: string) =>
      makePluginListItem({
        id,
        name: id,
        source: `npm:@acme/${id}@^1.0.0`,
        updateState: {
          outcome: "update-available",
          availableVersion: "1.1.0",
          availableLabel: "1.1.0",
        },
      });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        plugins: buildUpdateInventoryPlugins([
          plugin("alpha"),
          plugin("beta"),
          plugin("gamma"),
        ]),
      }),
    );
    const job = (
      pluginId: string,
      state: "queued" | "running",
    ): import("@sandy/server-contract").PluginUpdateJob =>
      state === "queued"
        ? { id: `job_${pluginId}`, pluginId, displayName: pluginId, state }
        : {
            id: `job_${pluginId}`,
            pluginId,
            displayName: pluginId,
            state,
            phase: "preparing",
          };
    const queryClient = new QueryClient();
    const tree = () => (
      <MemoryRouter>
        <TooltipProvider>
          <QueryClientProvider client={queryClient}>
            <UpdatesSettingsSection />
          </QueryClientProvider>
        </TooltipProvider>
      </MemoryRouter>
    );
    const section = () =>
      document.querySelector('[data-updates-domain="plugins"]') as HTMLElement;
    const progress = () =>
      section().querySelector("[data-updates-progress]")?.textContent ?? null;
    const rowState = (id: string) =>
      section()
        .querySelector(`[data-plugin-update-row="${id}"] [data-update-state]`)
        ?.getAttribute("data-update-state") ?? null;

    pluginUpdateJobs.current = [
      job("alpha", "running"),
      job("beta", "queued"),
      job("gamma", "queued"),
    ];
    const view = render(tree());
    expect(progress()).toBe("Updating 1 of 3");
    expect(rowState("alpha")).toBe("in-progress");
    expect(rowState("gamma")).toBe("in-progress");
    expect(
      within(section()).queryByRole("button", { name: /Update all/u }),
    ).toBeNull();

    pluginUpdateJobs.current = [job("gamma", "running")];
    view.rerender(tree());
    expect(progress()).toBe("Updating 3 of 3");
    expect(rowState("alpha")).toBeNull();
    expect(
      within(section()).getByRole("button", {
        name: "Update available · Update alpha to 1.1.0",
      }),
    ).toBeDefined();

    pluginUpdateJobs.current = [];
    view.rerender(tree());
    expect(progress()).toBeNull();
    expect(
      within(section()).getByRole("button", { name: "Update all 3 plugins" }),
    ).toBeDefined();
  });

  it("toasts a plugin update the server refuses to start", async () => {
    useWebApp();
    startPluginUpdateMock.mockRejectedValue(
      new Error("server move in progress"),
    );
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        plugins: buildUpdateInventoryPlugins([
          makePluginListItem({
            id: "notes",
            name: "Notes",
            source: "npm:@acme/notes@^1.0.0",
            updateState: {
              outcome: "update-available",
              availableVersion: "1.2.0",
              availableLabel: "1.2.0",
            },
          }),
        ]),
      }),
    );

    renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: "Update all 1 plugin" }),
    );

    await waitFor(() => {
      expect(appToast.error).toHaveBeenCalledWith("Plugin update failed", {
        description: "Notes — server move in progress",
      });
    });
  });

  it("omits an empty machine container", async () => {
    useUpdateInventoryMock.mockReturnValue(makeInventory({ machines: [] }));

    renderSection();

    expect(document.querySelector("[data-updates-machine]")).toBeNull();
    expect(screen.queryByText("No machines yet.")).toBeNull();
    expect(screen.getByText("No machines available.")).toBeDefined();
  });
});
