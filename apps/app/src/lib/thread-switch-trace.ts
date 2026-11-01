import { useLayoutEffect } from "react";
import {
  afterNextPaint,
  installPerfTraceInputClock,
  perfTraceInputStart,
  startPerfTraceSpan,
  type PerfTraceSpan,
} from "@sandy/shared-ui/lib/perf-trace";

const THREAD_PATH = /\/threads\/([^/?#]+)/;
const SWITCH_TIMEOUT_MS = 15_000;

interface ActiveSwitch {
  readonly threadId: string;
  readonly span: PerfTraceSpan;
  readonly timeout: ReturnType<typeof setTimeout>;
  rendered: boolean;
}

interface NavigateEventTarget {
  addEventListener(type: "navigate", listener: (event: unknown) => void): void;
}

let active: ActiveSwitch | null = null;

function threadIdOf(pathname: string): string | null {
  return THREAD_PATH.exec(pathname)?.[1] ?? null;
}

function isNavigateEventTarget(value: unknown): value is NavigateEventTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}

function destinationPath(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const destination: unknown = Reflect.get(event, "destination");
  if (typeof destination !== "object" || destination === null) return null;
  const url: unknown = Reflect.get(destination, "url");
  if (typeof url !== "string") return null;
  return new URL(url).pathname;
}

function clearActive(): void {
  if (active === null) return;
  clearTimeout(active.timeout);
  active = null;
}

export function beginThreadSwitchTrace(threadId: string): void {
  active?.span.abandon();
  clearActive();
  const span = startPerfTraceSpan(
    "switch",
    threadId,
    perfTraceInputStart(performance.now()),
  );
  span.mark("input");
  const timeout = setTimeout(() => {
    if (active?.span !== span) return;
    span.abandon();
    active = null;
  }, SWITCH_TIMEOUT_MS);
  active = { threadId, span, timeout, rendered: false };
}

export function installThreadSwitchTrace(target: Window): void {
  installPerfTraceInputClock(target);
  const navigation: unknown = Reflect.get(target, "navigation");
  if (!isNavigateEventTarget(navigation)) return;
  navigation.addEventListener("navigate", (event) => {
    const path = destinationPath(event);
    if (path === null) return;
    const next = threadIdOf(path);
    if (next !== null && next !== threadIdOf(target.location.pathname)) {
      beginThreadSwitchTrace(next);
    }
  });
}

function activeSwitchFor(threadId: string): ActiveSwitch | null {
  return active !== null && active.threadId === threadId ? active : null;
}

export function useThreadSwitchTrace(
  threadId: string,
  timelineReady: boolean,
): void {
  useLayoutEffect(() => {
    const current = activeSwitchFor(threadId);
    if (current === null || current.rendered) return;
    current.rendered = true;
    current.span.mark("render");
  }, [threadId]);
  useLayoutEffect(() => {
    const current = activeSwitchFor(threadId);
    if (current === null || !current.rendered || !timelineReady) return;
    current.span.mark("timeline");
    clearActive();
    afterNextPaint(() => current.span.end("paint"));
  }, [threadId, timelineReady]);
}
