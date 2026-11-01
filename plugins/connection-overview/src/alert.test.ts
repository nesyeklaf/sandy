import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALERT_BODY, ALERT_TITLE, alertBody, createAlerter } from "./alert.js";
import type { ConnectionState } from "./classify.js";
import { createStore, type Observation } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sandy-alert-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = createFakePluginHost({
    pluginId: "sandy--connection-overview",
    dataDir,
  });
  const open = () =>
    createStore(host.sandy.storage.database(), host.sandy.storage.migrate);
  return { open };
}

function observation(
  hostname: string | null,
  state: ConnectionState,
  seenAt = 1_000,
  comm = "node",
): Observation {
  return {
    sourceId: "server",
    direction: "out",
    proto: "tcp",
    port: 443,
    hostname,
    ip: "203.0.113.7",
    state,
    reason: "test",
    seenAt,
    newSocket: true,
    attribution: { pid: 10, startTime: 1, comm },
  };
}

describe("red destination alert", () => {
  it("sends once for a red key seen again in later sweeps", async () => {
    const { open } = await harness();
    const store = open();
    const send = vi.fn(async () => {});
    const alerter = createAlerter({ store, send });
    store.record([observation("bad.example", "red")]);
    expect(await alerter.sweep()).toBe(1);
    store.record([observation("bad.example", "red", 2_000)]);
    expect(await alerter.sweep()).toBe(0);
    expect(await alerter.sweep()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: ALERT_TITLE, body: ALERT_BODY });
  });

  it("keeps hostnames and addresses out of the notification", async () => {
    const { open } = await harness();
    const store = open();
    const send = vi.fn(async () => {});
    store.record([observation("secret-host.example", "red")]);
    await createAlerter({ store, send }).sweep();
    expect(JSON.stringify(send.mock.calls)).not.toMatch(
      /secret-host|203\.0\.113/,
    );
  });

  it("sends zero after a crash between claim and send, also after restart", async () => {
    const { open } = await harness();
    const first = open();
    first.record([observation("bad.example", "red")]);
    expect(first.claimUnclaimedRed(1_500)).toHaveLength(1);
    const send = vi.fn(async () => {});
    const restarted = open();
    expect(await createAlerter({ store: restarted, send }).sweep()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(restarted.list({ since: 0, states: ["red"] })).toHaveLength(1);
  });

  it("starts at most one delivery at a time and claims before the send resolves", async () => {
    const { open } = await harness();
    const store = open();
    let release: () => void = () => {};
    const send = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const alerter = createAlerter({ store, send });
    store.record([observation("a.example", "red")]);
    const first = alerter.start();
    expect(first).not.toBeNull();
    store.record([observation("b.example", "red", 2_000)]);
    expect(alerter.start()).toBeNull();
    expect(store.claimUnclaimedRed(3_000)).toEqual([
      "server|out|tcp|443|host:b.example",
    ]);
    release();
    expect(await first).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries next sweep when the notifications plugin is not running yet, then sends once", async () => {
    const { open } = await harness();
    const store = open();
    const notRunning = Object.assign(new Error("HTTP 503"), { status: 503 });
    const send = vi
      .fn<(notification: { title: string; body: string }) => Promise<void>>()
      .mockRejectedValueOnce(notRunning)
      .mockResolvedValue(undefined);
    const deferred: unknown[] = [];
    const alerter = createAlerter({
      store,
      send,
      onSendDeferred: (error) => deferred.push(error),
    });
    store.record([observation("bad.example", "red")]);
    expect(await alerter.sweep()).toBe(0);
    expect(await alerter.sweep()).toBe(1);
    expect(await alerter.sweep()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(deferred).toEqual([notRunning]);
  });

  it("does not repeat after a failed send and keeps the row red", async () => {
    const { open } = await harness();
    const store = open();
    const failures: unknown[] = [];
    const send = vi.fn(async () => {
      throw new Error("unreachable");
    });
    const alerter = createAlerter({
      store,
      send,
      onSendFailed: (error) => failures.push(error),
    });
    store.record([observation("bad.example", "red")]);
    await alerter.sweep();
    await alerter.sweep();
    expect(send).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(store.list({ since: 0, states: ["red"] })).toHaveLength(1);
  });

  it("re-evaluates rows after an allowlist edit but never sends the same key twice", async () => {
    const { open } = await harness();
    const store = open();
    const send = vi.fn(async () => {});
    const alerter = createAlerter({ store, send });
    store.record([observation("bad.example", "red")]);
    await alerter.sweep();
    store.reclassify({ isAllowed: () => true, thirdPartyProcesses: new Set() });
    expect(store.list({ since: 0 })[0]?.state).toBe("allowed");
    await alerter.sweep();
    store.reclassify({
      isAllowed: () => false,
      thirdPartyProcesses: new Set(),
    });
    expect(store.list({ since: 0 })[0]?.state).toBe("red");
    await alerter.sweep();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never alerts for third-party, yellow, inferred, undetermined or allowed rows", async () => {
    const { open } = await harness();
    const store = open();
    const send = vi.fn(async () => {});
    store.record(
      (
        [
          "third-party",
          "yellow",
          "inferred",
          "undetermined",
          "unverifiable",
          "allowed",
        ] as const
      ).map((state) => observation(`${state}.example`, state)),
    );
    expect(await createAlerter({ store, send }).sweep()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends one notification per sweep that counts the new red keys", async () => {
    const { open } = await harness();
    const store = open();
    const send = vi.fn(async () => {});
    const alerter = createAlerter({ store, send });
    store.record([
      observation("a.example", "red"),
      observation("b.example", "red"),
      observation("c.example", "allowed"),
    ]);
    expect(await alerter.sweep()).toBe(2);
    store.record([observation("d.example", "red", 2_000)]);
    expect(await alerter.sweep()).toBe(1);
    expect(send.mock.calls).toEqual([
      [{ title: ALERT_TITLE, body: alertBody(2) }],
      [{ title: ALERT_TITLE, body: ALERT_BODY }],
    ]);
  });

  it("turns stored red rows of third-party programs into third-party on reclassify and never alerts for them", async () => {
    const { open } = await harness();
    const store = open();
    const send = vi.fn(async () => {});
    store.record([
      observation("google.example", "red", 1_000, "chromium"),
      observation(null, "red", 1_000, "opencode"),
      observation("mixed.example", "red", 1_000, "chromium"),
      observation("mixed.example", "red", 1_100, "node"),
    ]);
    store.reclassify({
      isAllowed: () => false,
      thirdPartyProcesses: new Set(["chromium", "opencode"]),
    });
    const states = store
      .list({ since: 0 })
      .map((entry) => [entry.hostname, entry.state, entry.reason]);
    expect(states).toEqual(
      expect.arrayContaining([
        ["google.example", "third-party", "chromium is not sandy: unlisted host"],
        [null, "third-party", "opencode is not sandy: test"],
        ["mixed.example", "red", "unlisted host"],
      ]),
    );
    await createAlerter({ store, send }).sweep();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: ALERT_TITLE, body: ALERT_BODY });
  });
});
