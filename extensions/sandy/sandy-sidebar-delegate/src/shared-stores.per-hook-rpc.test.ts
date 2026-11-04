// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELEGATE_CHILDREN_CHANNEL, IDEAS_CHANNEL } from "./realtime-channels";
import { deferred } from "./test-fixtures";
import { giveEachHookItsOwnRpcClient, renderSlot } from "./test-slot";
import { useDelegateChildren } from "./useDelegateChildren";
import { useIsIdea } from "./useIdeas";
import { useLifecycle } from "./useLifecycle";

const MOUNTED = 25;

function manyOf(Probe: () => null) {
  return () =>
    createElement(Fragment, null, ...Array.from({ length: MOUNTED }, (_, key) => createElement(Probe, { key })));
}

let restoreRpc = () => {};
beforeEach(() => {
  restoreRpc = giveEachHookItsOwnRpcClient();
});
afterEach(() => {
  cleanup();
  restoreRpc();
});

describe("stores shared between components with a client per hook, as in core", () => {
  it("reads the delegate children once for all readers and coalesces a realtime burst", async () => {
    const answers: Array<ReturnType<typeof deferred<{ children: [] }>>> = [];
    const Probe = () => {
      useDelegateChildren();
      return null;
    };
    const rendered = renderSlot(
      { component: manyOf(Probe) },
      {},
      {
        rpc: {
          listDelegateChildren: () => {
            const pending = deferred<{ children: [] }>();
            answers.push(pending);
            return pending.promise;
          },
        },
      },
    );
    await waitFor(() => expect(answers).toHaveLength(1));
    for (let burst = 0; burst < 10; burst += 1) await rendered.emitRealtime(DELEGATE_CHILDREN_CHANNEL, {});
    expect(answers).toHaveLength(1);
    answers[0]!.resolve({ children: [] });
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!.resolve({ children: [] });
    await rendered.emitRealtime(DELEGATE_CHILDREN_CHANNEL, {});
    await waitFor(() => expect(answers).toHaveLength(3));
  });

  it("reads the ideas once for all readers and coalesces a realtime burst", async () => {
    const answers: Array<ReturnType<typeof deferred<{ threadIds: string[] }>>> = [];
    const Probe = () => {
      useIsIdea("thr_1");
      return null;
    };
    const rendered = renderSlot(
      { component: manyOf(Probe) },
      {},
      {
        rpc: {
          listIdeas: () => {
            const pending = deferred<{ threadIds: string[] }>();
            answers.push(pending);
            return pending.promise;
          },
        },
      },
    );
    await waitFor(() => expect(answers).toHaveLength(1));
    for (let burst = 0; burst < 10; burst += 1) await rendered.emitRealtime(IDEAS_CHANNEL, {});
    expect(answers).toHaveLength(1);
    answers[0]!.resolve({ threadIds: [] });
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!.resolve({ threadIds: [] });
    await rendered.emitRealtime(IDEAS_CHANNEL, {});
    await waitFor(() => expect(answers).toHaveLength(3));
  });

  it("runs one automatic settle evaluation while several sidebars mount", async () => {
    const evaluation = deferred<{ changedThreadIds: string[] }>();
    let calls = 0;
    const Probe = () => {
      useLifecycle([]);
      return null;
    };
    renderSlot(
      { component: manyOf(Probe) },
      {},
      {
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          evaluateAutoSettle: () => {
            calls += 1;
            return evaluation.promise;
          },
        },
      },
    );
    await waitFor(() => expect(calls).toBe(1));
    evaluation.resolve({ changedThreadIds: [] });
    await evaluation.promise;
    expect(calls).toBe(1);
  });
});
