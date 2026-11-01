import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPerfTraceInputClock,
  perfTraceInputStart,
  startPerfTraceSpan,
  traceOverlayOpen,
} from "./perf-trace";

const CLOCK_KEY = Symbol.for("sandy.perf-trace.clock.v1");

interface RecordedMeasure {
  name: string;
  start: number;
  end: number;
  phase: string;
  track: string;
}

function recordMeasures(): RecordedMeasure[] {
  const recorded: RecordedMeasure[] = [];
  const original = performance.measure.bind(performance);
  vi.spyOn(performance, "measure").mockImplementation((name, options) => {
    if (typeof options === "object" && options !== null) {
      const detail = options.detail as {
        sandy: { phase: string };
        devtools: { track: string };
      };
      recorded.push({
        name,
        start: Number(options.start),
        end: Number(options.end),
        phase: detail.sandy.phase,
        track: detail.devtools.track,
      });
    }
    return original(name, options);
  });
  return recorded;
}

function pointerDown(target: EventTarget): number {
  const event = new Event("pointerdown");
  target.dispatchEvent(event);
  return event.timeStamp;
}

describe("perf trace spans", () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, CLOCK_KEY);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, CLOCK_KEY);
  });

  it("measures each phase from the end of the previous one and a total from the start", () => {
    const measures = recordMeasures();
    const span = startPerfTraceSpan("switch", "thr_a", performance.now() - 50);
    span.mark("input");
    span.mark("render");
    span.end("paint");

    expect(measures.map((m) => [m.name, m.phase])).toEqual([
      ["sandy:switch:input", "input"],
      ["sandy:switch:render", "render"],
      ["sandy:switch:paint", "paint"],
      ["sandy:switch", "total"],
    ]);
    expect(measures[1]?.start).toBe(measures[0]?.end);
    expect(measures[3]?.start).toBe(span.startedAt);
    expect(measures[3]?.end).toBe(measures[2]?.end);
    expect(measures[3]?.track).toBe("Interactions");
    expect(performance.getEntriesByName("sandy:switch")).toHaveLength(0);
  });

  it("emits nothing after a span is abandoned", () => {
    const measures = recordMeasures();
    const span = startPerfTraceSpan("switch", "thr_a", performance.now());
    span.mark("input");
    span.abandon();
    span.mark("render");
    span.end("paint");

    expect(measures.map((m) => m.name)).toEqual(["sandy:switch:input"]);
  });

  it("starts an interaction at the last input only while that input is recent", () => {
    const target = new EventTarget();
    installPerfTraceInputClock(target);
    const inputAt = pointerDown(target);

    expect(perfTraceInputStart(inputAt + 400)).toBe(inputAt);
    expect(perfTraceInputStart(inputAt + 1500)).toBe(inputAt + 1500);
  });

  it("times an overlay open from the pointer press through the next paint", async () => {
    const target = new EventTarget();
    installPerfTraceInputClock(target);
    const inputAt = pointerDown(target);
    const measures = recordMeasures();

    traceOverlayOpen("menu");
    await vi.waitFor(() => expect(measures).toHaveLength(3));

    expect(measures.map((m) => m.name)).toEqual([
      "sandy:open:render",
      "sandy:open:paint",
      "sandy:open",
    ]);
    expect(measures[0]?.start).toBe(inputAt);
    expect(measures[2]?.start).toBe(inputAt);
  });
});
