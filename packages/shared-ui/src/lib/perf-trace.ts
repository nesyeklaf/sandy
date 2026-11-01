export type PerfTraceKind = "switch" | "open";

export interface PerfTraceDetail {
  readonly interaction: PerfTraceKind;
  readonly id: number;
  readonly label: string;
  readonly phase: string;
}

export interface PerfTraceSpan {
  readonly id: number;
  readonly kind: PerfTraceKind;
  readonly label: string;
  readonly startedAt: number;
  isOpen(): boolean;
  mark(phase: string): void;
  end(phase: string): void;
  abandon(): void;
}

const INPUT_WINDOW_MS = 1000;
const TRACK_GROUP = "sandy";
const PHASE_TRACKS: Record<PerfTraceKind, string> = {
  switch: "Thread switch",
  open: "Overlay open",
};
const TOTAL_TRACK = "Interactions";

interface PerfTraceClock {
  lastInputAt: number | null;
  installed: boolean;
  nextSpanId: number;
}

const CLOCK_KEY = Symbol.for("sandy.perf-trace.clock.v1");

function isPerfTraceClock(value: unknown): value is PerfTraceClock {
  return (
    typeof value === "object" &&
    value !== null &&
    "nextSpanId" in value &&
    typeof value.nextSpanId === "number"
  );
}

function sharedClock(): PerfTraceClock {
  const existing: unknown = Reflect.get(globalThis, CLOCK_KEY);
  if (isPerfTraceClock(existing)) return existing;
  const clock: PerfTraceClock = {
    lastInputAt: null,
    installed: false,
    nextSpanId: 1,
  };
  Reflect.set(globalThis, CLOCK_KEY, clock);
  return clock;
}

function canMeasure(): boolean {
  return (
    typeof performance !== "undefined" &&
    typeof performance.measure === "function" &&
    typeof performance.now === "function"
  );
}

function noteInput(event: Event): void {
  sharedClock().lastInputAt = event.timeStamp;
}

export function installPerfTraceInputClock(target: EventTarget): void {
  const clock = sharedClock();
  if (clock.installed) return;
  clock.installed = true;
  const options = { capture: true, passive: true };
  target.addEventListener("pointerdown", noteInput, options);
  target.addEventListener("keydown", noteInput, options);
}

export function perfTraceInputStart(now: number): number {
  const { lastInputAt } = sharedClock();
  if (lastInputAt === null) return now;
  const age = now - lastInputAt;
  return age >= 0 && age <= INPUT_WINDOW_MS ? lastInputAt : now;
}

function emit(
  name: string,
  start: number,
  end: number,
  track: string,
  detail: PerfTraceDetail,
): void {
  performance.measure(name, {
    start,
    end: Math.max(start, end),
    detail: {
      sandy: detail,
      devtools: {
        dataType: "track-entry",
        track,
        trackGroup: TRACK_GROUP,
        color: detail.interaction === "switch" ? "primary" : "secondary",
        properties: [["label", detail.label]],
        tooltipText: `${detail.label}: ${detail.phase}`,
      },
    },
  });
  performance.clearMeasures(name);
}

export function startPerfTraceSpan(
  kind: PerfTraceKind,
  label: string,
  startedAt: number,
): PerfTraceSpan {
  const clock = sharedClock();
  const id = clock.nextSpanId++;
  const enabled = canMeasure();
  let last = startedAt;
  let open = true;
  const phaseName = (phase: string) => `sandy:${kind}:${phase}`;
  const detail = (phase: string): PerfTraceDetail => ({
    interaction: kind,
    id,
    label,
    phase,
  });
  const mark = (phase: string) => {
    if (!open) return;
    const now = performance.now();
    if (enabled) emit(phaseName(phase), last, now, PHASE_TRACKS[kind], detail(phase));
    last = now;
  };
  return {
    id,
    kind,
    label,
    startedAt,
    isOpen: () => open,
    mark,
    end(phase) {
      if (!open) return;
      mark(phase);
      open = false;
      if (enabled) emit(`sandy:${kind}`, startedAt, last, TOTAL_TRACK, detail("total"));
    },
    abandon() {
      open = false;
    },
  };
}

export function traceOverlayOpen(label: string): void {
  if (!sharedClock().installed || !canMeasure()) return;
  const span = startPerfTraceSpan(
    "open",
    label,
    perfTraceInputStart(performance.now()),
  );
  span.mark("render");
  afterNextPaint(() => span.end("paint"));
}

export function afterNextPaint(callback: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    queueMicrotask(callback);
    return;
  }
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      callback();
    };
    channel.port2.postMessage(null);
  });
}
