import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  INFERENCE_PROCESSES,
  THIRD_PARTY_PROCESSES,
  allowedHostSet,
} from "./allowlist.js";
import {
  createCollector,
  type Cursor,
  type SampleResult,
} from "./collector.js";
import type { SocketRow } from "./contract.js";
import { evaluateStatus, sourceHealth } from "./coverage.js";
import { createHostnameBook } from "./hostnames.js";
import { KEY_LIMIT, createStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sandy-connections-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = createFakePluginHost({
    pluginId: "sandy--connection-overview",
    dataDir,
  });
  const store = createStore(
    host.sandy.storage.database(),
    host.sandy.storage.migrate,
  );
  const book = createHostnameBook();
  let now = 1_000_000;
  const cursors = new Map<string, Cursor>();
  const added: string[] = [];
  const collector = createCollector({
    store,
    book,
    now: () => now,
    context: () => ({
      allowedHosts: allowedHostSet(""),
      resolvers: new Set(),
      bindSubnets: [],
      inferenceProcesses: INFERENCE_PROCESSES,
      thirdPartyProcesses: THIRD_PARTY_PROCESSES,
    }),
    loadCursor: (sourceId) => cursors.get(sourceId) ?? null,
    saveCursor: (sourceId, cursor) => cursors.set(sourceId, cursor),
    onNewDestinations: (rows) =>
      added.push(...rows.map((row) => row.hostname ?? row.ip)),
  });
  return {
    store,
    book,
    collector,
    cursors,
    added,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

let seq = 0;
function row(overrides: Partial<SocketRow>): SocketRow {
  seq += 1;
  return {
    seq,
    pid: 10,
    startTime: 1,
    comm: "node",
    inode: seq,
    proto: "tcp",
    localIp: "100.115.228.74",
    localPort: 40_000 + seq,
    remoteIp: "203.0.113.5",
    remotePort: 443,
    tcpState: 1,
    localListening: false,
    continued: false,
    sampledAt: 999_000,
    ...overrides,
  };
}

function reply(
  rows: SocketRow[],
  extra: Partial<Extract<SampleResult, { supported: true }>> = {},
): SampleResult {
  return {
    supported: true,
    generation: "g1",
    cursor: rows.at(-1)?.seq ?? 0,
    gapCursor: 0,
    reset: false,
    more: false,
    rows,
    gaps: [],
    sampledAt: 999_000,
    hostNow: 999_500,
    treeSize: 3,
    unreadablePids: 0,
    rootPid: 10,
    ...extra,
  };
}

describe("collector and store", () => {
  it("aggregates sockets per destination and counts new sockets only", async () => {
    const { store, collector, added } = await harness();
    const first = row({});
    const second = row({});
    await collector.pull({
      sourceId: "h1",
      label: "ai",
      ownPid: null,
      sample: async () =>
        reply([first, second, { ...first, seq: 99, continued: true }]),
    });
    const rows = store.list({ since: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ip: "203.0.113.5",
      port: 443,
      state: "red",
      count: 2,
      sourceId: "h1",
    });
    expect(added).toEqual(["203.0.113.5"]);
  });

  it("binds server hostnames to the exact socket and reclassifies when the list changes", async () => {
    const { store, book, collector } = await harness();
    const socket = row({
      pid: 77,
      remoteIp: "140.82.121.6",
      localPort: 51_748,
    });
    book.bind(51_748, "140.82.121.6", 443, "api.github.com");
    const other = row({ pid: 77, remoteIp: "104.18.1.1", localPort: 51_749 });
    book.bind(51_749, "104.18.1.1", 443, "intranet.example.org");
    await collector.pull({
      sourceId: "server",
      label: "server",
      ownPid: 77,
      sample: async () => reply([socket, other]),
    });
    const states = Object.fromEntries(
      store.list({ since: 0 }).map((entry) => [entry.hostname, entry.state]),
    );
    expect(states).toEqual({
      "api.github.com": "allowed",
      "intranet.example.org": "red",
    });
    store.reclassify({
      isAllowed: (hostname) =>
        allowedHostSet("intranet.example.org").has(hostname),
      thirdPartyProcesses: new Set(),
    });
    expect(store.list({ since: 0, states: ["red"] })).toEqual([]);
  });

  it("records a gap when the worker restarted since the last pull", async () => {
    const { store, collector } = await harness();
    const driver = (result: SampleResult) => ({
      sourceId: "h1",
      label: "ai",
      ownPid: null,
      sample: async () => result,
    });
    await collector.pull(driver(reply([row({})], { sampledAt: 999_000 })));
    await collector.pull(
      driver(
        reply([row({ sampledAt: 1_060_000 })], {
          reset: true,
          generation: "g2",
          sampledAt: 1_060_000,
        }),
      ),
    );
    expect(store.gaps(0)).toEqual([
      {
        sourceId: "h1",
        start: 999_000,
        end: 1_060_000,
        reason: "collector restarted",
      },
    ]);
  });

  it("follows pages until the host has no more rows", async () => {
    const { store, collector } = await harness();
    const pages = [
      reply([row({ remoteIp: "198.51.100.1" })], { more: true }),
      reply([row({ remoteIp: "198.51.100.2" })]),
    ];
    const inputs: number[] = [];
    await collector.pull({
      sourceId: "h1",
      label: "ai",
      ownPid: null,
      sample: async (input) => {
        inputs.push(input.cursor);
        return pages.shift()!;
      },
    });
    expect(store.list({ since: 0 })).toHaveLength(2);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toBeGreaterThan(inputs[0]!);
  });

  it("reports unsupported platforms and errors in source health", async () => {
    const { collector } = await harness();
    await collector.pull({
      sourceId: "mac",
      label: "mac",
      ownPid: null,
      sample: async () => ({ supported: false, platform: "darwin" }),
    });
    await collector.pull({
      sourceId: "h1",
      label: "ai",
      ownPid: null,
      sample: async () => {
        throw new Error("worker gone");
      },
    });
    const health = collector.health(new Set(["mac", "h1"]));
    expect(health.find((entry) => entry.sourceId === "mac")).toMatchObject({
      supported: false,
    });
    expect(health.find((entry) => entry.sourceId === "h1")).toMatchObject({
      error: "worker gone",
      transport: "disconnected",
    });
    expect(
      evaluateStatus({
        sources: health,
        gaps: [],
        redCount: 0,
        capReached: false,
      }).exitCode,
    ).toBe(1);
  });

  it("marks coverage incomplete once the key cap is reached", async () => {
    const { store } = await harness();
    const observations = Array.from({ length: KEY_LIMIT + 1 }, (_, index) => ({
      sourceId: "h1",
      direction: "out" as const,
      proto: "tcp" as const,
      port: 443,
      hostname: null,
      ip: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`,
      state: "allowed" as const,
      reason: "local network",
      seenAt: 1,
      newSocket: true,
      attribution: { pid: 1, startTime: 1, comm: "node" },
    }));
    store.record(observations);
    expect(store.capReached()).toBe(true);
    expect(store.list({ since: 0 })).toHaveLength(KEY_LIMIT);
  }, 30_000);
});

describe("aggregation edge cases", () => {
  it("keeps one key across pid and local port changes, and attributes each process once", async () => {
    const { store, collector } = await harness();
    const rows = [
      row({ pid: 10, startTime: 1 }),
      row({ pid: 10, startTime: 1 }),
      row({ pid: 11, startTime: 2 }),
      row({ pid: 10, startTime: 9 }),
    ];
    await collector.pull({
      sourceId: "h1",
      label: "ai",
      ownPid: null,
      sample: async () => reply(rows),
    });
    const [only] = store.list({ since: 0 });
    expect(store.list({ since: 0 })).toHaveLength(1);
    expect(only!.count).toBe(4);
    expect(
      only!.attributions.map((entry) => [entry.pid, entry.startTime]),
    ).toEqual([
      [10, 9],
      [11, 2],
      [10, 1],
    ]);
  });

  it("does not let a hostname cover a second socket to the same IP", async () => {
    const { store, book, collector } = await harness();
    book.bind(50_001, "140.82.121.6", 443, "api.github.com");
    const named = row({ pid: 77, remoteIp: "140.82.121.6", localPort: 50_001 });
    const unnamed = row({
      pid: 77,
      remoteIp: "140.82.121.6",
      localPort: 50_002,
    });
    await collector.pull({
      sourceId: "server",
      label: "server",
      ownPid: 77,
      sample: async () => reply([named, unnamed]),
    });
    const byTarget = Object.fromEntries(
      store
        .list({ since: 0 })
        .map((entry) => [entry.hostname ?? entry.ip, entry.state]),
    );
    expect(byTarget).toEqual({
      "api.github.com": "allowed",
      "140.82.121.6": "red",
    });
  });

  it("counts a reused inode under a new process as a new socket", async () => {
    const { store, collector } = await harness();
    const first = row({ pid: 10, startTime: 1, inode: 4242 });
    const reused = row({ pid: 10, startTime: 5, inode: 4242 });
    await collector.pull({
      sourceId: "h1",
      label: "ai",
      ownPid: null,
      sample: async () => reply([first, reused]),
    });
    expect(store.list({ since: 0 })[0]!.count).toBe(2);
  });

  it("keeps one row for a socket held open for a simulated week", async () => {
    const { store, collector } = await harness();
    const socket = row({ inode: 777 });
    const heartbeats = Array.from(
      { length: (7 * 24 * 3600) / 30 },
      (_, index) => ({
        ...socket,
        seq: socket.seq + index,
        continued: index > 0,
        sampledAt: socket.sampledAt + index * 30_000,
      }),
    );
    for (let start = 0; start < heartbeats.length; start += 1_000)
      await collector.pull({
        sourceId: "h1",
        label: "ai",
        ownPid: null,
        sample: async () => reply(heartbeats.slice(start, start + 1_000)),
      });
    const rows = store.list({ since: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(1);
    expect(rows[0]!.lastSeen).toBe(heartbeats.at(-1)!.sampledAt);
  });
});

describe("freshness clocks", () => {
  const base = {
    sourceId: "h1",
    label: "ai",
    supported: true,
    platform: null,
    treeSize: 1,
    unreadablePids: 0,
    error: null,
  };

  it("judges the collector on the host's own clock, so clock skew does not matter", () => {
    const skewed = {
      ...base,
      lastSampledAt: 5_000_000,
      lastHostNow: 5_004_000,
      lastReplyAt: 1_000,
    };
    expect(sourceHealth(skewed, 1_000 + 29_000)).toMatchObject({
      collector: "fresh",
      transport: "fresh",
    });
    expect(
      sourceHealth({ ...skewed, lastHostNow: 5_006_000 }, 1_000),
    ).toMatchObject({ collector: "stale" });
  });

  it("goes stale after 30 s and disconnected after 60 s without a reply", () => {
    const source = {
      ...base,
      lastSampledAt: 1,
      lastHostNow: 1,
      lastReplyAt: 0,
    };
    expect(sourceHealth(source, 30_001).transport).toBe("stale");
    expect(sourceHealth(source, 60_001).transport).toBe("disconnected");
  });
});

describe("evaluateStatus", () => {
  const fresh = {
    sourceId: "h1",
    label: "ai",
    collector: "fresh" as const,
    transport: "fresh" as const,
    supported: true,
    treeSize: 3,
    unreadablePids: 0,
    error: null,
  };

  it("exits 0 only with fresh sources, no long gaps and no red rows", () => {
    expect(
      evaluateStatus({
        sources: [fresh],
        gaps: [{ start: 0, end: 10_000 }],
        redCount: 0,
        capReached: false,
      }),
    ).toEqual({ exitCode: 0, problems: [] });
  });

  it("exits 1 when fresh sources still have unreadable pids", () => {
    expect(
      evaluateStatus({
        sources: [{ ...fresh, unreadablePids: 4 }],
        gaps: [],
        redCount: 0,
        capReached: false,
      }),
    ).toEqual({ exitCode: 1, problems: ["ai: 4 unreadable pids"] });
  });

  it("exits 1 on stale collectors, long gaps, the cap or no sources", () => {
    expect(
      evaluateStatus({
        sources: [{ ...fresh, collector: "stale" }],
        gaps: [],
        redCount: 0,
        capReached: false,
      }).exitCode,
    ).toBe(1);
    expect(
      evaluateStatus({
        sources: [fresh],
        gaps: [{ start: 0, end: 10_001 }],
        redCount: 0,
        capReached: false,
      }).exitCode,
    ).toBe(1);
    expect(
      evaluateStatus({
        sources: [fresh],
        gaps: [],
        redCount: 0,
        capReached: true,
      }).exitCode,
    ).toBe(1);
    expect(
      evaluateStatus({ sources: [], gaps: [], redCount: 0, capReached: false })
        .exitCode,
    ).toBe(1);
  });

  it("exits 2 when red rows exist, even with unhealthy coverage", () => {
    const result = evaluateStatus({
      sources: [{ ...fresh, transport: "stale" }],
      gaps: [],
      redCount: 3,
      capReached: false,
    });
    expect(result.exitCode).toBe(2);
    expect(result.problems[0]).toBe("3 red destination(s)");
  });
});
