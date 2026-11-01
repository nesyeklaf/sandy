let streamTraceEnabled = false;

export function setStreamTraceEnabled(enabled: boolean): void {
  streamTraceEnabled = enabled;
}

export function markStreamTrace(
  name: "sandy:timeline-applied" | "sandy:stream-row-commit",
  detail: Record<string, number | string | null>,
): void {
  if (streamTraceEnabled) {
    performance.mark(name, { detail });
  }
}
