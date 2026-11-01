import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { overviewSchema } from "./contract.js";
import type { ConnectionState } from "./classify.js";
import type { SourceHealth } from "./coverage.js";
import { registerOverviewRpc } from "./overview-rpc.js";
import { createStore, type Observation } from "./store.js";

const NOW = 10 * 3_600_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness(health: SourceHealth[]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sandy-overview-rpc-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = createFakePluginHost({
    pluginId: "sandy--connection-overview",
    dataDir,
  });
  const store = createStore(
    host.sandy.storage.database(),
    host.sandy.storage.migrate,
  );
  registerOverviewRpc(host.sandy, { store, health: () => health, now: () => NOW });
  return { host, store };
}

function observation(
  name: string,
  state: ConnectionState,
  seenAt: number,
  direction: Observation["direction"] = "out",
): Observation {
  return {
    sourceId: "server",
    direction,
    proto: "tcp",
    port: 443,
    hostname: name,
    ip: "203.0.113.7",
    state,
    reason: "test",
    seenAt,
    newSocket: true,
    attribution: { pid: 10, startTime: 1, comm: "node" },
  };
}

const freshServer: SourceHealth = {
  sourceId: "server",
  label: "server",
  collector: "fresh",
  transport: "fresh",
  supported: true,
  treeSize: 4,
  unreadablePids: 0,
  error: null,
};

describe("overview.get", () => {
  it("orders rows by urgency, counts every state and reports the same exit code as sandy connections status", async () => {
    const { host, store } = await harness([freshServer]);
    const states: ConnectionState[] = [
      "allowed",
      "third-party",
      "inferred",
      "undetermined",
      "yellow",
      "red",
    ];
    store.record(
      states.map((state, index) =>
        observation(`${state}.example`, state, NOW - 60_000 - index),
      ),
    );
    store.record([observation("peer.example", "red", NOW - 1_000, "in")]);
    const overview = overviewSchema.parse(
      await host.harness.callRpc("overview.get", { window: "24h" }),
    );
    expect(overview.rows.map((row) => row.state)).toEqual([
      "red",
      "red",
      "yellow",
      "undetermined",
      "inferred",
      "third-party",
      "allowed",
    ]);
    expect(overview.counts).toMatchObject({
      red: 2,
      yellow: 1,
      "third-party": 1,
    });
    expect(overview.totalRows).toBe(7);
    expect(overview.exitCode).toBe(2);
    expect(overview.now).toBe(NOW);
  });

  it("applies the window and reports stale clocks instead of a clean result", async () => {
    const stale: SourceHealth = {
      ...freshServer,
      collector: "stale",
      transport: "stale",
    };
    const { host, store } = await harness([stale]);
    store.record([observation("old.example", "allowed", NOW - 2 * 3_600_000)]);
    const hour = overviewSchema.parse(
      await host.harness.callRpc("overview.get", { window: "1h" }),
    );
    expect(hour.rows).toEqual([]);
    expect(hour.exitCode).toBe(1);
    expect(hour.sources[0]).toMatchObject({
      collector: "stale",
      transport: "stale",
    });
    const day = overviewSchema.parse(
      await host.harness.callRpc("overview.get", { window: "24h" }),
    );
    expect(day.rows).toHaveLength(1);
  });

  it("rejects a window it does not know", async () => {
    const { host } = await harness([freshServer]);
    await expect(
      host.harness.callRpc("overview.get", { window: "90d" }),
    ).rejects.toThrow();
  });
});
