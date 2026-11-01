// Token use per hour or per day, stacked by kind. Display only: the bars
// arrive as props, so stories and tests render it without a server.
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { totalOf, type Tokens } from "@/usage/breakdown";
import { formatTokens, niceTicks, type Bar } from "@/usage/series";

export type PartKey = keyof Tokens;

/** Stacked bottom to top in this order; colors are the first three categorical slots. */
export const PARTS: ReadonlyArray<{ key: PartKey; label: string; fill: string; swatch: string }> = [
  { key: "input", label: "New input", fill: "fill-[#2a78d6] dark:fill-[#3987e5]", swatch: "bg-[#2a78d6] dark:bg-[#3987e5]" },
  { key: "cacheRead", label: "Cache reads", fill: "fill-[#eb6834] dark:fill-[#d95926]", swatch: "bg-[#eb6834] dark:bg-[#d95926]" },
  { key: "output", label: "Output", fill: "fill-[#1baf7a] dark:fill-[#199e70]", swatch: "bg-[#1baf7a] dark:bg-[#199e70]" },
];

const DEFAULT_PLOT_HEIGHT = 200;
/** Room above the plot for the top axis label. */
const TOP = 12;
const TOOLTIP_WIDTH = 192;
const AXIS_WIDTH = 44;
const LABEL_HEIGHT = 22;
const GAP = 2;
const RADIUS = 4;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Beside the hovered bar, on whichever side has room, so the bar stays visible. */
function tooltipLeft(barLeft: number, slot: number, width: number): number {
  const right = barLeft + slot + 8;
  if (right + TOOLTIP_WIDTH <= width) return right;
  return Math.max(0, barLeft - 8 - TOOLTIP_WIDTH);
}

/** A rectangle with its top corners rounded, standing on the baseline. */
function roundedTop(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function hourLabel(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "numeric" });
}

function weekday(time: number): string {
  return new Date(time).toLocaleDateString([], { weekday: "short" });
}

/** The x-axis label under a bar, or null for the bars between labels. */
function tickLabel(bar: Bar, index: number, count: number, unit: "hour" | "day"): string | null {
  if (unit === "day") return weekday(bar.start);
  const hour = new Date(bar.start).getHours();
  if (count <= 24) return hour % 3 === 0 ? hourLabel(bar.start) : null;
  if (hour === 0) return weekday(bar.start);
  return hour === 12 ? hourLabel(bar.start) : null;
}

export function barLabel(bar: Bar, unit: "hour" | "day"): string {
  if (unit === "day") {
    return new Date(bar.start).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  return `${weekday(bar.start)} ${hourLabel(bar.start)} to ${hourLabel(bar.end)}`;
}

export function UsageLegend({
  hidden,
  onToggle,
  pace = false,
}: {
  hidden: ReadonlySet<PartKey>;
  onToggle: (key: PartKey) => void;
  /** Adds the hatched bars' key, while the chart draws them. */
  pace?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {PARTS.map((part) => {
        const shown = !hidden.has(part.key);
        return (
          <button
            key={part.key}
            type="button"
            aria-pressed={shown}
            onClick={() => onToggle(part.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground",
              !shown && "opacity-50 line-through",
            )}
          >
            <span className={cn("size-2.5 rounded-sm", part.swatch)} aria-hidden />
            {part.label}
          </button>
        );
      })}
      {pace ? (
        <span className="inline-flex items-center gap-1.5 px-1 py-0.5">
          <svg className="size-2.5 rounded-sm" aria-hidden>
            <rect width="10" height="10" fill="url(#value-pace)" />
          </svg>
          At the past hour's pace
        </span>
      ) : null}
    </div>
  );
}

/**
 * Hatched bars for the hours still to come, at the past hour's pace, until a
 * limit resets. Red from the point the limit runs out.
 */
export interface Projection {
  /** Now: the hatching starts here. */
  from: number;
  /** When the limit resets: the hatching stops here. */
  until: number;
  tokensPerHour: number;
  runsOutAt: number | null;
}

/** The tokens the projection adds to a bar, for the part of it between `from` and `until`. */
export function projectedTokens(bar: Bar, projection: Projection): number {
  const overlap = Math.min(bar.end, projection.until) - Math.max(bar.start, projection.from);
  return overlap <= 0 ? 0 : (projection.tokensPerHour * overlap) / 3_600_000;
}

function resetLabel(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function UsageChart({
  bars,
  unit,
  hidden,
  initialHovered = null,
  projection = null,
  plotHeight = DEFAULT_PLOT_HEIGHT,
}: {
  bars: readonly Bar[];
  unit: "hour" | "day";
  hidden: ReadonlySet<PartKey>;
  /** A bar to show hovered on first render, so a story can draw the tooltip. */
  initialHovered?: number | null;
  projection?: Projection | null;
  /** The bars' tallest height in pixels; the title bar's popover draws a shorter chart. */
  plotHeight?: number;
}) {
  const { ref, width } = useWidth();
  const [hovered, setHovered] = useState<number | null>(initialHovered);
  const parts = PARTS.filter((part) => !hidden.has(part.key));
  const shownTotal = (bar: Bar) => parts.reduce((sum, part) => sum + bar[part.key], 0);
  const ghost = (bar: Bar) => (projection === null ? 0 : projectedTokens(bar, projection));

  const ticks = niceTicks(Math.max(0, ...bars.map((bar) => shownTotal(bar) + ghost(bar))));
  const top = ticks.at(-1)!;
  const plotWidth = Math.max(0, width - AXIS_WIDTH);
  const slot = bars.length === 0 ? 0 : plotWidth / bars.length;
  const barWidth = Math.max(1, slot - Math.max(GAP, slot * 0.2));
  const y = (value: number) => TOP + (top === 0 ? plotHeight : plotHeight - (value / top) * plotHeight);
  const hoveredBar = hovered === null ? undefined : bars[hovered];
  const span = bars.length === 0 ? 1 : bars.at(-1)!.end - bars[0]!.start;
  const xAt = (time: number) => AXIS_WIDTH + ((time - (bars[0]?.start ?? 0)) / span) * plotWidth;

  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHovered(null)}>
      {width > 0 ? (
        <svg width={width} height={TOP + plotHeight + LABEL_HEIGHT} role="img" aria-label={`Tokens used per ${unit}`}>
          {projection === null ? null : (
            <defs>
              <pattern id="value-pace" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" strokeWidth="3" className="stroke-muted-foreground/45" />
              </pattern>
              <pattern id="value-pace-out" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" strokeWidth="3" className="stroke-destructive/70" />
              </pattern>
            </defs>
          )}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={AXIS_WIDTH}
                x2={width}
                y1={y(tick) + 0.5}
                y2={y(tick) + 0.5}
                className={tick === 0 ? "stroke-border" : "stroke-border/50"}
              />
              <text
                x={AXIS_WIDTH - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {formatTokens(tick)}
              </text>
            </g>
          ))}
          {bars.map((bar, index) => {
            const x = AXIS_WIDTH + index * slot + (slot - barWidth) / 2;
            const label = tickLabel(bar, index, bars.length, unit);
            let base = 0;
            const drawn = parts.filter((part) => bar[part.key] > 0);
            return (
              <g key={bar.start}>
                {hovered === index ? (
                  <rect x={AXIS_WIDTH + index * slot} y={TOP} width={slot} height={plotHeight} className="fill-muted/60" />
                ) : null}
                {drawn.map((part, stackIndex) => {
                  const value = bar[part.key];
                  const yTop = y(base + value);
                  const yBottom = y(base);
                  base += value;
                  // A 2px surface gap below every segment but the first.
                  const height = Math.max(0, yBottom - yTop);
                  const gap = stackIndex > 0 ? Math.min(GAP, height / 2) : 0;
                  const segmentHeight = Math.max(0, height - gap);
                  if (segmentHeight < 0.5) return null;
                  return stackIndex === drawn.length - 1 ? (
                    <path key={part.key} d={roundedTop(x, yTop, barWidth, segmentHeight)} className={part.fill} />
                  ) : (
                    <rect key={part.key} x={x} y={yTop} width={barWidth} height={segmentHeight} className={part.fill} />
                  );
                })}
                {projection === null || ghost(bar) === 0 ? null : (
                  <path
                    d={roundedTop(x, y(shownTotal(bar) + ghost(bar)), barWidth, Math.max(0, y(shownTotal(bar)) - y(shownTotal(bar) + ghost(bar)) - (shownTotal(bar) > 0 ? GAP : 0)))}
                    fill={
                      projection.runsOutAt !== null && Math.max(bar.start, projection.from) >= projection.runsOutAt
                        ? "url(#value-pace-out)"
                        : "url(#value-pace)"
                    }
                  />
                )}
                {label === null ? null : (
                  <text
                    x={x + barWidth / 2}
                    y={TOP + plotHeight + 15}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {label}
                  </text>
                )}
                <rect
                  x={AXIS_WIDTH + index * slot}
                  y={0}
                  width={slot}
                  height={TOP + plotHeight + LABEL_HEIGHT}
                  fill="transparent"
                  onMouseEnter={() => setHovered(index)}
                />
              </g>
            );
          })}
          {projection === null ? null : (
            <g className="pointer-events-none">
              <line
                x1={xAt(projection.until)}
                x2={xAt(projection.until)}
                y1={TOP}
                y2={TOP + plotHeight}
                strokeDasharray="3 2"
                className="stroke-muted-foreground"
              />
              <text x={xAt(projection.until) - 4} y={TOP + 10} textAnchor="end" className="fill-muted-foreground text-[11px]">
                resets {resetLabel(projection.until)}
              </text>
              {projection.runsOutAt === null ? null : (
                <>
                  <line
                    x1={xAt(projection.runsOutAt)}
                    x2={xAt(projection.runsOutAt)}
                    y1={TOP}
                    y2={TOP + plotHeight}
                    strokeDasharray="3 2"
                    className="stroke-destructive"
                  />
                  <text
                    x={xAt(projection.runsOutAt) - 4}
                    y={TOP + 26}
                    textAnchor="end"
                    className="fill-destructive text-[11px] font-medium"
                  >
                    runs out {resetLabel(projection.runsOutAt)}
                  </text>
                </>
              )}
            </g>
          )}
        </svg>
      ) : (
        <div style={{ height: TOP + plotHeight + LABEL_HEIGHT }} />
      )}
      {hoveredBar === undefined || hovered === null ? null : (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-2 z-10 w-48 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          style={{ left: tooltipLeft(AXIS_WIDTH + hovered * slot, slot, width) }}
        >
          <p className="mb-1 font-medium">{barLabel(hoveredBar, unit)}</p>
          {PARTS.map((part) => (
            <p key={part.key} className={cn("flex items-center gap-1.5", hidden.has(part.key) && "opacity-50")}>
              <span className={cn("size-2 rounded-sm", part.swatch)} aria-hidden />
              <span className="flex-1 text-muted-foreground">{part.label}</span>
              <span className="tabular-nums">{formatTokens(hoveredBar[part.key])}</span>
            </p>
          ))}
          <p className="mt-1 flex border-t border-border pt-1 font-medium">
            <span className="flex-1">Total</span>
            <span className="tabular-nums">{formatTokens(totalOf(hoveredBar))}</span>
          </p>
          {ghost(hoveredBar) === 0 ? null : (
            <p className="flex text-muted-foreground">
              <span className="flex-1">At this pace</span>
              <span className="tabular-nums">+{formatTokens(ghost(hoveredBar))}</span>
            </p>
          )}
        </div>
      )}
      <table className="sr-only">
        <caption>Tokens used per {unit}</caption>
        <thead>
          <tr>
            <th scope="col">{unit === "day" ? "Day" : "Hour"}</th>
            {PARTS.map((part) => (
              <th key={part.key} scope="col">
                {part.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.start}>
              <th scope="row">{barLabel(bar, unit)}</th>
              {PARTS.map((part) => (
                <td key={part.key}>{bar[part.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
