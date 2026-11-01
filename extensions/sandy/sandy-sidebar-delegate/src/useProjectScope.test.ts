// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useProjectScope } from "./useProjectScope";
import { STORAGE_KEYS } from "./lib/storage-keys";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

it("preserves saved projects during loading and errors, then removes only missing IDs", () => {
  sessionStorage.setItem(STORAGE_KEYS.projectScope.key, '["a","removed","b"]');
  const hook = renderHook((props: Parameters<typeof useProjectScope>[0]) => useProjectScope(props), {
    initialProps: { projects: [], status: "loading" },
  });
  expect(hook.result.current[0]).toEqual(["a", "removed", "b"]);
  hook.rerender({ projects: [], status: "error" });
  expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.projectScope.key)!)).toEqual(["a", "removed", "b"]);
  hook.rerender({
    status: "ready",
    projects: ["a", "b"].map((id) => ({ id, name: id, isPersonal: false, href: "", settingsHref: "" })),
  });
  expect(hook.result.current[0]).toEqual(["a", "b"]);
  expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.projectScope.key)!)).toEqual(["a", "b"]);
  hook.rerender({ status: "ready", projects: [] });
  expect(hook.result.current[0]).toEqual([]);
});
