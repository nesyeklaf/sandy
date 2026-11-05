// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { shareArray, shareArrayMap, useLatestCallback } from "./stable-identity";

describe("shareArray", () => {
  it("keeps the previous array while every element is the same object", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const previous = [a, b];
    expect(shareArray(previous, [a, b])).toBe(previous);
  });

  it("takes the next array when an element or the length differs", () => {
    const a = { id: "a" };
    const previous = [a];
    const replaced = [{ id: "a" }];
    expect(shareArray(previous, replaced)).toBe(replaced);
    const longer = [a, { id: "b" }];
    expect(shareArray(previous, longer)).toBe(longer);
  });
});

describe("shareArrayMap", () => {
  it("keeps the previous map when every key holds an equal array", () => {
    const child = { id: "c" };
    const previous = new Map([["p", [child]]]);
    expect(shareArrayMap(previous, new Map([["p", [child]]]))).toBe(previous);
  });

  it("builds a new map but keeps the arrays that did not change", () => {
    const first = { id: "c1" };
    const second = { id: "c2" };
    const unchanged = [first];
    const previous = new Map([
      ["p", unchanged],
      ["q", [second]],
    ]);
    const result = shareArrayMap(
      previous,
      new Map([
        ["p", [first]],
        ["q", [second, { id: "c3" }]],
      ]),
    );
    expect(result).not.toBe(previous);
    expect(result.get("p")).toBe(unchanged);
    expect(result.get("q")).toHaveLength(2);
  });

  it("takes the next map when a key disappears", () => {
    const child = { id: "c" };
    const previous = new Map([
      ["p", [child]],
      ["q", [child]],
    ]);
    const next = new Map([["p", [child]]]);
    expect(shareArrayMap(previous, next).size).toBe(1);
  });
});

describe("useLatestCallback", () => {
  it("returns one function that calls the callback of the latest render", () => {
    const { result, rerender } = renderHook(({ value }) => useLatestCallback(() => value), {
      initialProps: { value: 1 },
    });
    const first = result.current;
    expect(first()).toBe(1);
    rerender({ value: 2 });
    expect(result.current).toBe(first);
    expect(first()).toBe(2);
  });
});
