import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InternalDoNotUsePluginRequestPeer } from "@sandy-sdk/plugin-sdk";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { registerCli } from "./cli.js";
import {
  REQUEST_SOURCE_ID,
  createRequestPeerCollector,
} from "./request-peers.js";
import { createStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sandy-request-peers-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = createFakePluginHost({
    pluginId: "sandy--connection-overview",
    dataDir,
  });
  const store = createStore(
    host.sandy.storage.database(),
    host.sandy.storage.migrate,
  );
  const collector = createRequestPeerCollector({
    store,
    read: (after) => host.sandy.server.internal_DO_NOT_USE_requestPeers({ after }),
    bindSubnets: () => [],
    serverPid: 4242,
  });
  return {
    host,
    store,
    collector,
    add: (
      peers: Array<Partial<Omit<InternalDoNotUsePluginRequestPeer, "seq">>>,
    ) =>
      host.harness.inspection.internal_DO_NOT_USE_addRequestPeers(
        peers.map((peer) => ({
          at: 1_000_000,
          address: "127.0.0.1",
          port: 50_000,
          localPort: 3000,
          method: "GET",
          status: 200,
          websocket: false,
          ...peer,
        })),
      ),
  };
}

describe("request peer collector", () => {
  it("stores each request as an incoming row with its state", async () => {
    const { store, collector, add } = await harness();
    add([
      { address: "127.0.0.1" },
      { address: "::ffff:100.101.102.103" },
      { address: "fd7a:115c:a1e0::1" },
      { address: "192.168.1.20" },
      { address: "203.0.113.9" },
      { address: "10.0.0.5" },
    ]);
    expect(collector.pull()).toBe(6);
    const rows = store.list({ since: 0, direction: "in" });
    const byIp = new Map<string, (typeof rows)[number]>(
      rows.map((row) => [`${row.ip}|${row.port}`, row]),
    );
    expect(rows.every((row) => row.sourceId === REQUEST_SOURCE_ID)).toBe(true);
    expect(byIp.get("127.0.0.1|3000")?.state).toBe("unverifiable");
    expect(byIp.get("100.101.102.103|3000")?.state).toBe("allowed");
    expect(byIp.get("fd7a:115c:a1e0::1|3000")?.state).toBe("allowed");
    expect(byIp.get("192.168.1.20|3000")).toMatchObject({
      state: "red",
      reason: "external peer",
    });
    expect(byIp.get("10.0.0.5|3000")?.state).toBe("red");
    expect(byIp.get("203.0.113.9|3000")).toMatchObject({
      state: "red",
      reason: "external peer",
    });
  });

  it("counts every request once across pulls", async () => {
    const { store, collector, add } = await harness();
    add([{}, { websocket: true }]);
    collector.pull();
    expect(collector.pull()).toBe(0);
    add([{ status: 403 }]);
    expect(collector.pull()).toBe(1);
    const rows = store.list({ since: 0, direction: "in" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(store.gaps(0)).toEqual([]);
  });

  it("records a gap when the ring overwrote unread requests", async () => {
    const { store, collector, add } = await harness();
    add([{ at: 1_000 }]);
    collector.pull();
    add(Array.from({ length: 8193 }, (_, index) => ({ at: 2_000 + index })));
    collector.pull();
    expect(store.gaps(0)).toMatchObject([
      {
        sourceId: REQUEST_SOURCE_ID,
        start: 1_000,
        end: 2_001,
        reason: "request ring overwrote unread entries",
      },
    ]);
    expect(store.list({ since: 0, direction: "in" })[0]?.count).toBe(8193);
  });
});

describe("request peer collector without a saved read", () => {
  it("records a gap when the ring overwrote requests before the first read", async () => {
    const { store, collector, add } = await harness();
    add(Array.from({ length: 8195 }, (_, index) => ({ at: 5_000 + index })));
    expect(collector.pull()).toBe(8192);
    expect(store.gaps(0)).toMatchObject([
      {
        sourceId: REQUEST_SOURCE_ID,
        start: 5_003,
        end: 5_003,
        reason: "request ring overwrote 3 unread entries before the first read",
      },
    ]);
  });

  it("commits rows and the cursor together", async () => {
    const { store, collector, add, host } = await harness();
    const failing = createRequestPeerCollector({
      store: {
        ...store,
        saveCursor: () => {
          throw new Error("interrupted");
        },
      },
      read: (after) =>
        host.sandy.server.internal_DO_NOT_USE_requestPeers({ after }),
      bindSubnets: () => [],
      serverPid: 4242,
    });
    add([{}]);
    expect(() => failing.pull()).toThrow("interrupted");
    expect(store.list({ since: 0, direction: "in" })).toEqual([]);
    expect(collector.pull()).toBe(1);
    expect(store.list({ since: 0, direction: "in" })[0]?.count).toBe(1);
  });
});

describe("sandy connections incoming", () => {
  it("lists request peers and leaves them out of the outgoing list", async () => {
    const { host, store, collector, add } = await harness();
    registerCli(host.sandy, {
      store,
      health: () => [],
      now: () => 1_000_000 + 60_000,
    });
    add([{ address: "203.0.113.9" }, { address: "100.80.1.2" }]);
    collector.pull();
    const incoming = await host.harness.runCli(["incoming", "--json"]);
    expect(incoming.exitCode).toBe(0);
    const rows: unknown = JSON.parse(incoming.stdout);
    expect(rows).toMatchObject([
      { direction: "in", sourceId: REQUEST_SOURCE_ID },
      { direction: "in", sourceId: REQUEST_SOURCE_ID },
    ]);
    const red = await host.harness.runCli(["incoming", "--red", "--json"]);
    expect(JSON.parse(red.stdout)).toMatchObject([
      { ip: "203.0.113.9", state: "red" },
    ]);
    const outgoing = await host.harness.runCli(["list", "--json"]);
    expect(JSON.parse(outgoing.stdout)).toEqual([]);
  });
});
