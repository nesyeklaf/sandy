// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  activeSortCodec,
  childExpansionCodec,
  projectCollapseCodec,
  projectScopeCodec,
  shelfExpansionCodec,
} from "./inbox-preference-codecs";
import { decodeStoredValue } from "./storage-codec";
import { STORAGE_KEYS } from "./storage-keys";

afterEach(() => localStorage.clear());

it("validates saved project selections and removes duplicate IDs", () => {
  expect(projectScopeCodec.decode('["b","a","b"]')).toEqual(["b", "a"]);
  expect(projectScopeCodec.decode("[]")).toEqual([]);
  for (const raw of [null, "invalid", "null", "{}", '["a",1]', '[""]', '[" "]']) {
    expect(decodeStoredValue(raw, projectScopeCodec)).toBeNull();
  }
});

it("retains permissive set filtering and the existing array formats", () => {
  for (const codec of [childExpansionCodec, projectCollapseCodec]) {
    const decoded = decodeStoredValue('["a", 1, "b", "a"]', codec)!;
    expect([...decoded]).toEqual(["a", "b"]);
    expect(codec.encode(decoded)).toBe('["a","b"]');
    for (const input of [null, "", "null", "{}", "invalid"]) expect(decodeStoredValue(input, codec)).toBeNull();
  }
});

it("caps child expansion before deduplication on read and only on storage prune", () => {
  const ids = ["old", ...Array.from({ length: 100 }, () => "new")];
  expect([...childExpansionCodec.decode(JSON.stringify(ids))!]).toEqual(["new"]);
  const live = new Set(Array.from({ length: 102 }, (_, i) => String(i)));
  expect(childExpansionCodec.prune!(live)).toEqual(new Set([...live].slice(-100)));
  expect(live.size).toBe(102);
});

it("fills older shelf shapes and drops unknown keys without stricter primitive rejection", () => {
  expect(shelfExpansionCodec.decode('{"settled":true,"unknown":true}')).toEqual({
    active: true,
    pinned: true,
    working: true,
    review: true,
    inactive: false,
    parked: false,
    snoozed: false,
    settled: true,
  });
  for (const value of [true, 1, [], "old"]) {
    expect(shelfExpansionCodec.decode(JSON.stringify(value))).toEqual(shelfExpansionCodec.fallback());
  }
  expect(shelfExpansionCodec.decode('{"active":0,"working":false,"inactive":"true"}')).toEqual({
    ...shelfExpansionCodec.fallback(),
    working: false,
  });
  expect(decodeStoredValue("null", shelfExpansionCodec)).toBeNull();
});

it("uses legacy grouping only for missing or invalid sort modes without rewriting it", () => {
  localStorage.setItem(STORAGE_KEYS.activeGrouping.key, "true");
  expect(activeSortCodec.decode(null)).toBe("project");
  expect(activeSortCodec.decode("invalid")).toBe("project");
  for (const mode of ["manual", "project", "created", "activity"] as const) {
    expect(activeSortCodec.decode(mode)).toBe(mode);
    expect(activeSortCodec.encode(mode)).toBe(mode);
  }
  expect(localStorage.getItem(STORAGE_KEYS.activeGrouping.key)).toBe("true");
  localStorage.setItem(STORAGE_KEYS.activeGrouping.key, "false");
  expect(activeSortCodec.decode(null)).toBe("manual");
});
