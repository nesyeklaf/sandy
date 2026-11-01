import { describe, expect, it } from "vitest";

import { costOf, DEFAULT_PRICES, normalizeModel, parsePrices, priceOf } from "./pricing.js";

describe("priceOf", () => {
  it("finds a model through provider prefix, region suffix and case", () => {
    expect(normalizeModel("OpenAI-Codex/GPT-5.6-Sol@eu")).toBe("gpt-5.6-sol");
    expect(priceOf("openai-codex/gpt-5.6-sol")).toBe(DEFAULT_PRICES["gpt-5.6-sol"]);
  });

  it("knows nothing about an unknown or missing model, which is not the same as free", () => {
    expect(priceOf("gpt-9-mystery")).toBeNull();
    expect(priceOf(null)).toBeNull();
  });

  it("doubles a known model's rates for its fast variant", () => {
    const base = priceOf("gpt-6-astra")!;
    const fast = priceOf("gpt-6-astra-fast")!;
    expect(fast.output).toBe(base.output * 2);
    expect(fast.tier?.cacheRead).toBe(base.tier!.cacheRead * 2);
    expect(priceOf("claude-opus-5-5-fast")).toBeNull();
  });

  it("lets a custom table override", () => {
    expect(priceOf("gpt-6-sol", { "gpt-6-sol": { input: 1, cacheRead: 1, output: 1 } })!.input).toBe(1);
  });
});

describe("models added from the price pages", () => {
  it("prices GPT-6.1 Sol and Haiku 5.5 with their own long-context thresholds", () => {
    const sol = priceOf("gpt-6.1-sol")!;
    expect(costOf({ input: 100_000, cacheRead: 100_000, output: 10_000 }, sol)).toBeCloseTo(0.2 + 0.01 + 0.1);
    expect(costOf({ input: 200_000, cacheRead: 100_000, output: 10_000 }, sol)).toBeCloseTo(0.8 + 0.02 + 0.15);
    const haiku = priceOf("claude-haiku-5-5")!;
    expect(costOf({ input: 60_000, cacheRead: 30_000, output: 1_000 }, haiku)).toBeCloseTo(0.006 + 0.0003 + 0.0005);
    expect(costOf({ input: 80_000, cacheRead: 30_000, output: 1_000 }, haiku)).toBeCloseTo(0.04 + 0.0015 + 0.0025);
  });
});

describe("claude-sonnet-5-5", () => {
  it("is priced, with or without the provider prefix", () => {
    const expected = costOf({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }, priceOf("claude-sonnet-5-5")!);
    expect(expected).toBeCloseTo(2 + 0.1 + 10);
    expect(priceOf("anthropic/claude-sonnet-5-5")).toEqual(priceOf("claude-sonnet-5-5"));
  });
});

describe("parsePrices", () => {
  it("reads one model per line and reports the lines it cannot read", () => {
    const { prices, invalid } = parsePrices("# mine\nOpenAI/GPT-9 1 0.1 5\nbroken 1 2\n\nx 1 -2 3");
    expect(prices).toEqual({ "gpt-9": { input: 1, cacheRead: 0.1, output: 5 } });
    expect(invalid).toEqual(["broken 1 2", "x 1 -2 3"]);
  });
});

describe("costOf", () => {
  it("prices input, cache reads and output apart", () => {
    // 100k input at 4, 150k cache reads at 0.4, 0.5M output at 20 dollars per million.
    const cost = costOf({ input: 100_000, cacheRead: 150_000, output: 500_000 }, priceOf("gpt-5.6-sol")!);
    expect(cost).toBeCloseTo(0.4 + 0.06 + 10);
  });

  it("switches to the long-context rates above the threshold", () => {
    const rate = priceOf("gpt-5.6-sol")!;
    expect(costOf({ input: 100_000, cacheRead: 100_000, output: 0 }, rate)).toBeCloseTo(0.4 + 0.04);
    expect(costOf({ input: 100_000, cacheRead: 200_000, output: 0 }, rate)).toBeCloseTo(0.8 + 0.16);
  });
});
