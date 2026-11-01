import { describe, expect, it } from "vitest";

import { createBackoff, hasProviderErrors, mergeSamples } from "./limit-poll.js";
import type { LimitSample } from "./limits.js";

const MIN = 60_000;

function sample(over: Partial<LimitSample> = {}): LimitSample {
  return {
    providerId: "claude-code",
    accountKey: "anthropic:account:1",
    label: "Weekly",
    kind: "weekly",
    model: null,
    sampledAt: 1000,
    usedPercent: 54,
    resetsAt: 5000,
    ...over,
  };
}

describe("mergeSamples", () => {
  it("keeps one account's window once when two hosts report it", () => {
    const merged = mergeSamples([[sample({ usedPercent: 54 })], [sample({ usedPercent: 55 })]]);
    expect(merged).toEqual([expect.objectContaining({ usedPercent: 54 })]);
  });

  it("keeps different accounts, windows and models apart", () => {
    const merged = mergeSamples([
      [sample()],
      [sample({ accountKey: "anthropic:account:2" }), sample({ label: "Current session" }), sample({ model: "fable" })],
    ]);
    expect(merged).toHaveLength(4);
  });

  it("takes the other host's reading when the first one has none", () => {
    expect(mergeSamples([[], [sample()]])).toHaveLength(1);
  });
});

describe("hasProviderErrors", () => {
  it("is true when any provider failed", () => {
    expect(hasProviderErrors({ codex: { status: "ok" }, "claude-code": { status: "error" } })).toBe(true);
  });
  it("is false when all are ok or the response is empty", () => {
    expect(hasProviderErrors({ codex: { status: "ok" } })).toBe(false);
    expect(hasProviderErrors(null)).toBe(false);
  });
});

describe("createBackoff", () => {
  it("waits 2, then 4 minutes after failures and resets on success", () => {
    const backoff = createBackoff();
    expect(backoff.ready("h", 0)).toBe(true);
    backoff.failed("h", 0);
    expect(backoff.ready("h", MIN)).toBe(false);
    expect(backoff.ready("h", 2 * MIN)).toBe(true);
    backoff.failed("h", 2 * MIN);
    expect(backoff.ready("h", 5 * MIN)).toBe(false);
    expect(backoff.ready("h", 6 * MIN)).toBe(true);
    backoff.succeeded("h");
    backoff.failed("h", 10 * MIN);
    expect(backoff.ready("h", 12 * MIN)).toBe(true);
  });

  it("caps the wait at 30 minutes and tracks hosts separately", () => {
    const backoff = createBackoff();
    for (let i = 0; i < 10; i += 1) backoff.failed("h", 0);
    expect(backoff.ready("h", 29 * MIN)).toBe(false);
    expect(backoff.ready("h", 30 * MIN)).toBe(true);
    expect(backoff.ready("other", 0)).toBe(true);
  });
});
