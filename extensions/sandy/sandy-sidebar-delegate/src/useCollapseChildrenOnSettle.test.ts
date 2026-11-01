// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { useCollapseChildrenOnSettle } from "./useCollapseChildrenOnSettle";

afterEach(cleanup);

const thread = (id: string) => ({ id }) as PluginSidebarThread;

function setup(initial: { settled: string[]; settledAt: Record<string, number | null>; expanded: string[] }) {
  return renderHook(
    ({ settled, settledAt }: { settled: string[]; settledAt: Record<string, number | null> }) => {
      const [expanded, setExpanded] = useState(() => new Set(initial.expanded));
      useCollapseChildrenOnSettle(
        settled.map(thread),
        { settledAtFor: (item) => settledAt[item.id] ?? null },
        setExpanded,
      );
      return { expanded, setExpanded };
    },
    { initialProps: { settled: initial.settled, settledAt: initial.settledAt } },
  );
}

it("keeps children expanded for threads that were already settled when the sidebar loaded", () => {
  const hook = setup({ settled: ["old"], settledAt: { old: Date.now() - 86_400_000 }, expanded: ["old"] });
  expect([...hook.result.current.expanded]).toEqual(["old"]);
});

it("collapses children when a thread is settled, and keeps them expanded again afterwards", () => {
  const settledAt = Date.now();
  const hook = setup({ settled: [], settledAt: {}, expanded: ["parent", "other"] });
  hook.rerender({ settled: ["parent"], settledAt: { parent: settledAt } });
  expect([...hook.result.current.expanded]).toEqual(["other"]);
  act(() => hook.result.current.setExpanded((current) => new Set([...current, "parent"])));
  hook.rerender({ settled: ["parent"], settledAt: { parent: settledAt } });
  expect(hook.result.current.expanded.has("parent")).toBe(true);
});

it("treats a settle from just before the sidebar loaded as new", () => {
  const hook = setup({ settled: ["parent"], settledAt: { parent: Date.now() - 5_000 }, expanded: ["parent"] });
  expect(hook.result.current.expanded.has("parent")).toBe(false);
});

it("collapses a thread settled again after being un-settled", () => {
  const settledAt = Date.now() - 86_400_000;
  const hook = setup({ settled: ["parent"], settledAt: { parent: settledAt }, expanded: ["parent"] });
  hook.rerender({ settled: [], settledAt: {} });
  hook.rerender({ settled: ["parent"], settledAt: { parent: Date.now() } });
  expect(hook.result.current.expanded.has("parent")).toBe(false);
});
