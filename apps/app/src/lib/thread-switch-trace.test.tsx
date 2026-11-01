// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginThreadSwitchTrace,
  installThreadSwitchTrace,
  useThreadSwitchTrace,
} from "./thread-switch-trace";

const CLOCK_KEY = Symbol.for("sandy.perf-trace.clock.v1");

function recordMeasureNames(): string[] {
  const names: string[] = [];
  const original = performance.measure.bind(performance);
  vi.spyOn(performance, "measure").mockImplementation((name, options) => {
    const label =
      typeof options === "object" && options !== null
        ? (options.detail as { sandy: { label: string } }).sandy.label
        : "";
    names.push(`${name}@${label}`);
    return original(name, options);
  });
  return names;
}

function Screen({ threadId, ready }: { threadId: string; ready: boolean }) {
  useThreadSwitchTrace(threadId, ready);
  return null;
}

function fakeWindow(pathname: string) {
  const navigation = new EventTarget();
  const target = Object.assign(new EventTarget(), {
    location: { pathname },
    navigation,
  });
  const navigate = (url: string) => {
    const event = Object.assign(new Event("navigate"), {
      destination: { url: `https://sandy.test${url}` },
    });
    navigation.dispatchEvent(event);
  };
  return { window: target as unknown as Window, navigate };
}

describe("thread switch trace", () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, CLOCK_KEY);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, CLOCK_KEY);
  });

  it("measures a navigation to another thread through render, timeline and paint", async () => {
    const names = recordMeasureNames();
    const { window: target, navigate } = fakeWindow("/threads/thr_old");
    installThreadSwitchTrace(target);

    navigate("/threads/thr_new");
    const view = render(<Screen threadId="thr_new" ready={false} />);
    expect(names).toEqual(["sandy:switch:input@thr_new", "sandy:switch:render@thr_new"]);

    view.rerender(<Screen threadId="thr_new" ready />);
    await vi.waitFor(() => expect(names).toHaveLength(5));
    expect(names.slice(2)).toEqual([
      "sandy:switch:timeline@thr_new",
      "sandy:switch:paint@thr_new",
      "sandy:switch@thr_new",
    ]);
  });

  it("ignores navigations that stay on the same thread", () => {
    const names = recordMeasureNames();
    const { window: target, navigate } = fakeWindow("/threads/thr_same");
    installThreadSwitchTrace(target);

    navigate("/threads/thr_same/files");
    navigate("/settings");

    expect(names).toEqual([]);
  });

  it("drops a switch that a newer switch overtakes before it rendered", async () => {
    const names = recordMeasureNames();
    beginThreadSwitchTrace("thr_first");
    beginThreadSwitchTrace("thr_second");
    render(<Screen threadId="thr_first" ready />);
    render(<Screen threadId="thr_second" ready />);

    await vi.waitFor(() => expect(names).toContain("sandy:switch@thr_second"));
    expect(names.filter((name) => name.endsWith("@thr_first"))).toEqual([
      "sandy:switch:input@thr_first",
    ]);
  });
});
