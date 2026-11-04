// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useLifecycle } from "./useLifecycle";
import { renderSlot } from "./test-slot";
import { deferred } from "./test-fixtures";

function Probe() {
  useLifecycle([]);
  return null;
}

function TwoSidebars() {
  return createElement(Fragment, null, createElement(Probe), createElement(Probe));
}

afterEach(cleanup);

describe("useLifecycle automatic settle trigger", () => {
  it("does not start a second evaluation while one is still running", async () => {
    const evaluation = deferred<{ changedThreadIds: string[] }>();
    let calls = 0;
    const rendered = renderSlot(
      { component: TwoSidebars },
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
    rendered.rerender(createElement(TwoSidebars, { key: "again" }));
    expect(calls).toBe(1);
    evaluation.resolve({ changedThreadIds: [] });
    await evaluation.promise;
  });
});
