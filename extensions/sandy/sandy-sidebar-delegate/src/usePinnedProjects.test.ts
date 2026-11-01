// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { usePinnedProjects } from "./usePinnedProjects";
import { STORAGE_KEYS } from "./lib/storage-keys";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const projects = ["a", "b"].map((id) => ({ id, name: id, isPersonal: false, href: "", settingsHref: "" }));

it("preserves pins through loading and errors, then removes deleted projects without changing pin order", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, '["b","removed","a","b"]');
  const hook = renderHook((props: Parameters<typeof usePinnedProjects>[0]) => usePinnedProjects(props), {
    initialProps: { projects: [], status: "loading" },
  });
  expect(hook.result.current.pinnedProjects).toEqual(["b", "removed", "a"]);
  hook.rerender({ projects: [], status: "error" });
  expect(hook.result.current.pinnedProjects).toEqual(["b", "removed", "a"]);
  hook.rerender({ projects, status: "ready" });
  expect(hook.result.current.pinnedProjects).toEqual(["b", "a"]);
  act(() => hook.result.current.toggleProjectPin("b"));
  act(() => hook.result.current.toggleProjectPin("b"));
  expect(hook.result.current.pinnedProjects).toEqual(["a", "b"]);
  hook.rerender({ projects: [], status: "ready" });
  expect(hook.result.current.pinnedProjects).toEqual([]);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual([]);
});

it.each(['{"id":"a"}', '["a",1]', '[" "]', "invalid json"])("ignores invalid saved pins: %s", (saved) => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, saved);
  const hook = renderHook(() => usePinnedProjects({ projects, status: "ready" }));
  expect(hook.result.current.pinnedProjects).toEqual([]);
});
