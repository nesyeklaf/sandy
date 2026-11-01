// How long a thread's turns took: one dot per turn on a log scale from ten
// seconds to an hour, with a bar at the median. Most turns take under a
// minute and a few take far longer, so a linear scale would pile the short
// ones at zero. Display only.
import { useState, type MouseEvent } from "react";

import { cn } from "@/lib/utils";

import { HoverTip, type TipPosition } from "./hover-tip";
import { formatSpan } from "./thread-token-count";

const MIN_MS = 10_000;
const MAX_MS = 3_600_000;

export const DOTS_WIDTH = 170;

/** Where `ms` falls on the log scale, from 0 to `width`; outside the range it sits at an end. */
export function logPosition(ms: number, width: number): number {
  const clamped = Math.min(MAX_MS, Math.max(MIN_MS, ms));
  return ((Math.log(clamped) - Math.log(MIN_MS)) / (Math.log(MAX_MS) - Math.log(MIN_MS))) * width;
}

export interface TurnStats {
  median: number;
  longest: number;
  total: number;
}

export function turnStats(durations: readonly number[]): TurnStats | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    longest: sorted.at(-1)!,
    total: sorted.reduce((sum, ms) => sum + ms, 0),
  };
}

export interface TurnTime {
  /** When the turn started. */
  at: number;
  ms: number;
}

function startedLabel(at: number): string {
  return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** The index of the dot nearest `x`, or null when none is within a few pixels. */
export function nearestDot(positions: readonly number[], x: number, reach = 8): number | null {
  let best: number | null = null;
  for (const [index, position] of positions.entries()) {
    const distance = Math.abs(position - x);
    if (distance <= reach && (best === null || distance < Math.abs(positions[best]! - x))) best = index;
  }
  return best;
}

export function TurnDots({ turns, width = DOTS_WIDTH }: { turns: readonly TurnTime[]; width?: number }) {
  const [hovered, setHovered] = useState<{ index: number; at: TipPosition } | null>(null);
  const stats = turnStats(turns.map((turn) => turn.ms));
  const height = 22;
  const middle = height / 2;
  const positions = turns.map((turn) => logPosition(turn.ms, width));
  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = nearestDot(positions, event.clientX - box.left);
    setHovered(index === null ? null : { index, at: { x: box.left + positions[index]!, y: box.top } });
  };
  const turn = hovered === null ? undefined : turns[hovered.index];
  return (
    <>
      <svg width={width} height={height} className="shrink-0 overflow-visible" onMouseMove={onMove} onMouseLeave={() => setHovered(null)}>
        <line x1={0} x2={width} y1={middle} y2={middle} stroke="currentColor" opacity={0.15} />
        {turns.map((_, index) => (
          <circle
            key={index}
            cx={positions[index]}
            cy={middle}
            r={hovered?.index === index ? 5 : 3.5}
            fill="#2a9fd6"
            opacity={hovered === null ? 0.55 : hovered.index === index ? 1 : 0.3}
          />
        ))}
        {stats === null ? null : (
          <line
            x1={logPosition(stats.median, width)}
            x2={logPosition(stats.median, width)}
            y1={2}
            y2={height - 2}
            stroke="currentColor"
            strokeWidth={2}
          />
        )}
      </svg>
      {turn === undefined || hovered === null ? null : (
        <HoverTip at={hovered.at}>
          <span className="font-medium">{formatSpan(turn.ms)}</span>
          <span className="text-muted-foreground"> · started {startedLabel(turn.at)}</span>
        </HoverTip>
      )}
    </>
  );
}

const TICKS: ReadonlyArray<[number, string]> = [
  [10_000, "10s"],
  [60_000, "1m"],
  [300_000, "5m"],
  [900_000, "15m"],
  [3_600_000, "1h"],
];

/** The scale's labels, to sit above a column of TurnDots. */
export function TurnDotsAxis({ width = DOTS_WIDTH }: { width?: number }) {
  return (
    <span className="relative block shrink-0" style={{ width, height: 16 }}>
      {TICKS.map(([ms, label], index) => (
        <span
          key={label}
          // The end labels sit inside the axis so they don't run into the columns beside it.
          className={cn(
            "absolute whitespace-nowrap",
            index === 0 ? "" : index === TICKS.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
          )}
          style={{ left: logPosition(ms, width) }}
        >
          {label}
        </span>
      ))}
    </span>
  );
}
