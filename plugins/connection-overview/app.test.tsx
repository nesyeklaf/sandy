// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionOverviewContract,
  type Overview,
  type OverviewRow,
} from "./src/contract.js";

const app = await loadPluginApp(() => import("./app.js"));
const NOW = 1_000_000_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function row(
  name: string,
  state: OverviewRow["state"],
  direction: OverviewRow["direction"] = "out",
): OverviewRow {
  return {
    key: `server|${direction}|tcp|443|host:${name}`,
    sourceId: "server",
    direction,
    proto: "tcp",
    port: 443,
    hostname: name,
    ip: "203.0.113.7",
    state,
    reason: `${state} reason`,
    firstSeen: NOW - 120_000,
    lastSeen: NOW - 30_000,
    count: 3,
    attributions: [{ pid: 7, startTime: 1, comm: "node" }],
  };
}

const freshSource: Overview["sources"][number] = {
  sourceId: "server",
  label: "server",
  collector: "fresh",
  transport: "fresh",
  supported: true,
  treeSize: 5,
  unreadablePids: 0,
  error: null,
};

function overview(patch: Partial<Overview> = {}): Overview {
  const rows = patch.rows ?? [];
  const counts: Record<string, number> = {};
  for (const entry of rows)
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
  return {
    now: NOW,
    since: NOW - 86_400_000,
    exitCode: 0,
    problems: [],
    counts,
    sources: [freshSource],
    gaps: [],
    capReached: false,
    notMeasured: ["unreadable pids", "the clients themselves"],
    totalRows: rows.length,
    rows,
    ...patch,
  };
}

function render(get: (input: unknown) => Overview | Promise<Overview>) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: { "overview.get": get },
      experimental_rpcContract: connectionOverviewContract,
    },
  );
}

const ALL_STATES: OverviewRow["state"][] = [
  "red",
  "yellow",
  "undetermined",
  "unverifiable",
  "inferred",
  "third-party",
  "allowed",
];

describe("connection overview page", () => {
  it("shows every state in the outgoing and incoming tables", async () => {
    const rows = [
      ...ALL_STATES.map((state) => row(`${state}.example`, state)),
      row("peer.example", "allowed", "in"),
      row("stranger.example", "red", "in"),
    ];
    const view = render(() => overview({ rows, exitCode: 2 }));
    const outgoing = await view.findByRole("table", { name: "Outgoing" });
    for (const state of ALL_STATES)
      expect(within(outgoing).getByText(`${state}.example`)).toBeTruthy();
    expect(within(outgoing).getAllByText("third-party").length).toBeGreaterThan(
      0,
    );
    const incoming = view.getByRole("table", { name: "Incoming" });
    expect(within(incoming).getByText("peer.example")).toBeTruthy();
    expect(within(incoming).getByText("stranger.example")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain(
      "2 red destinations",
    );
  });

  it("filters by state", async () => {
    const view = render(() =>
      overview({
        rows: [row("a.example", "red"), row("b.example", "third-party")],
        exitCode: 2,
      }),
    );
    await view.findByText("a.example");
    fireEvent.click(view.getByRole("button", { name: "third-party (1)" }));
    expect(view.queryByText("a.example")).toBeNull();
    expect(view.getByText("b.example")).toBeTruthy();
  });

  it("shows both freshness clocks per host and never calls stale data clean", async () => {
    const view = render(() =>
      overview({
        exitCode: 1,
        problems: ["server: collector stale, transport stale"],
        sources: [
          { ...freshSource, collector: "stale", transport: "stale" },
          {
            ...freshSource,
            sourceId: "host-2",
            label: "laptop",
            collector: "unknown",
            transport: "disconnected",
            unreadablePids: 2,
          },
        ],
      }),
    );
    const sources = await view.findByRole("table", { name: "Sources" });
    expect(
      within(sources).getByText("stale", { selector: "td:nth-child(2)" }),
    ).toBeTruthy();
    expect(
      within(sources).getByText("stale", { selector: "td:nth-child(3)" }),
    ).toBeTruthy();
    expect(within(sources).getByText("unknown")).toBeTruthy();
    expect(within(sources).getByText("disconnected")).toBeTruthy();
    const banner = view.getByRole("status").textContent ?? "";
    expect(banner).toContain("Measurement incomplete");
    expect(banner).toContain("collector stale, transport stale");
    expect(banner).not.toMatch(/Measured:/);
  });

  it("says not measured when no source is connected or a platform is unsupported", async () => {
    const none = render(() =>
      overview({
        sources: [],
        exitCode: 1,
        problems: ["no measurement source"],
      }),
    );
    await waitFor(() =>
      expect(none.getByRole("status").textContent).toContain(
        "Not measured: no measurement source is connected",
      ),
    );
    expect(none.getByRole("status").textContent).toContain(
      "Not measured: unreadable pids",
    );
    cleanup();
    const unsupported = render(() =>
      overview({
        exitCode: 1,
        sources: [{ ...freshSource, supported: false }],
      }),
    );
    await unsupported.findByText("not measured on this platform");
    expect(unsupported.getByRole("status").textContent).toContain(
      "Measurement incomplete",
    );
  });

  it("reports a failed read as not measured", async () => {
    const view = render(() => {
      throw new Error("boom");
    });
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        "Not measured: the overview could not be read",
      ),
    );
  });

  it("states what is measured and what is not when coverage is healthy", async () => {
    const view = render(() =>
      overview({ rows: [row("ok.example", "allowed")] }),
    );
    await view.findByText("ok.example");
    const banner = view.getByRole("status").textContent ?? "";
    expect(banner).toContain("Measured: no red destination");
    expect(banner).toContain(
      "Not measured: unreadable pids; the clients themselves",
    );
  });

  it("stops calling a healthy read measured once it is a minute old, without another invalidation", async () => {
    vi.setSystemTime(NOW + 59_800);
    const view = render(() =>
      overview({ rows: [row("ok.example", "allowed")] }),
    );
    await view.findByText("ok.example");
    expect(view.getByRole("status").textContent).toContain(
      "Measured: no red destination",
    );
    vi.setSystemTime(NOW + 61_000);
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        "Measurement incomplete",
      ),
    );
    const banner = view.getByRole("status").textContent ?? "";
    expect(banner).not.toMatch(/Measured:/);
    expect(banner).toContain("No update for 1 min; this is older data");
  });

  it("calls fresh clocks with unreadable pids incomplete, like the CLI", async () => {
    const view = render(() =>
      overview({
        exitCode: 1,
        problems: ["server: 4 unreadable pids"],
        sources: [{ ...freshSource, unreadablePids: 4 }],
      }),
    );
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        "Measurement incomplete",
      ),
    );
    expect(view.getByRole("status").textContent).toContain(
      "server: 4 unreadable pids",
    );
  });

  it("says a red count is incomplete when coverage problems remain", async () => {
    const view = render(() =>
      overview({
        rows: [row("bad.example", "red")],
        exitCode: 2,
        problems: ["1 red destination(s)", "2 gap(s) over 10 s in the window"],
      }),
    );
    await view.findByText("bad.example");
    const banner = view.getByRole("status").textContent ?? "";
    expect(banner).toContain(
      "1 red destination in this window; measurement incomplete",
    );
    expect(banner).not.toContain("1 red destination(s)");
  });

  it("flags yellow and undetermined rows that need an explanation", async () => {
    const view = render(() =>
      overview({
        rows: [row("y.example", "yellow"), row("u.example", "undetermined")],
      }),
    );
    await view.findByText("y.example");
    expect(view.getByRole("status").textContent).toContain(
      "2 yellow or undetermined rows need an explanation",
    );
  });

  it("picks up a new red row after the server invalidates the read", async () => {
    let current = overview({ rows: [row("ok.example", "allowed")] });
    const view = render(() => current);
    await view.findByText("ok.example");
    current = overview({
      rows: [row("new.example", "red"), row("ok.example", "allowed")],
      exitCode: 2,
    });
    await view.behavior.experimental_invalidateRpc(["overview"]);
    await view.findByText("new.example");
    expect(view.getByRole("status").textContent).toContain("1 red destination");
  });

  it("reads the chosen window and says when rows were cut", async () => {
    const get = vi.fn((_input: unknown) =>
      overview({
        rows: [row("a.example", "red")],
        totalRows: 5000,
        exitCode: 2,
      }),
    );
    const view = render(get);
    await view.findByText("a.example");
    expect(view.getByText(/Showing the 1 most urgent of/)).toBeTruthy();
    fireEvent.change(view.getByRole("combobox"), { target: { value: "7d" } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ window: "7d" }));
  });
});
