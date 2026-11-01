// The thread header's token count: a button with a sparkline of the thread's
// token use over time, opening a summary of when its tokens went and which of
// your messages set them off. Display only.
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { totalOf, type Tokens } from "@/usage/breakdown";
import type { TurnDetail, UsageAt } from "@/usage/contract";
import { formatTokens, niceTicks, timeBuckets, type TimeBucket } from "@/usage/series";

import { TokenPair } from "./token-pair";
import { PARTS } from "./usage-chart";

export interface ThreadTokens extends Tokens {
  total: number;
  turns: number;
  /** The latest usage rows, oldest first. */
  recent: UsageAt[];
  /** Claude Code subagents the thread ran and the tokens they used; already in the totals. */
  subagents?: { count: number; tokens: number };
}

/** The thread's tokens in the 24 hours before `now`, from its latest rows. */
export function pastDayTokens(recent: readonly UsageAt[], now: number): number {
  return recent.filter((row) => row.at >= now - 86_400_000 && row.at <= now).reduce((sum, row) => sum + totalOf(row), 0);
}

/** Buckets in the header's sparkline and the summary's chart. */
const SPARK_BUCKETS = 20;
const CHART_BUCKETS = 36;
/** Turns the summary names under "Biggest turns". */
const BIGGEST = 3;

/**
 * One bar per time bucket, scaled to the largest, in the current text color.
 * It draws each bucket's total, so it stays neutral rather than taking the
 * color of one of the three parts. An empty bucket draws nothing, so idle
 * stretches read as gaps.
 */
/** Room left of the summary chart for its axis labels, and above and below for the end labels. */
const AXIS_WIDTH = 34;
const AXIS_PAD = 6;

function Spark({
  buckets,
  width,
  height,
  gap,
  axis = false,
  active,
  onHover,
}: {
  buckets: readonly TimeBucket[];
  width: number;
  height: number;
  gap: number;
  /** Draw gridlines and token labels on the left, scaled to a round top. */
  axis?: boolean;
  active?: number | null;
  onHover?: (index: number | null) => void;
}) {
  const largest = Math.max(0, ...buckets.map(totalOf));
  const ticks = axis ? niceTicks(largest, 2) : [];
  const most = Math.max(1, axis ? ticks.at(-1)! : largest);
  const left = axis ? AXIS_WIDTH : 0;
  const top = axis ? AXIS_PAD : 0;
  const plot = height - (axis ? 2 * AXIS_PAD : 0);
  const slot = buckets.length === 0 ? 0 : (width - left) / buckets.length;
  const barWidth = Math.max(1, slot - gap);
  const y = (value: number) => top + plot - (value / most) * plot;
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0" onMouseLeave={() => onHover?.(null)}>
      {axis ? (
        ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={width}
              y1={Math.round(y(tick)) - 0.5}
              y2={Math.round(y(tick)) - 0.5}
              stroke="currentColor"
              opacity={tick === 0 ? 0.2 : 0.1}
            />
            <text
              x={left - 6}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {formatTokens(tick)}
            </text>
          </g>
        ))
      ) : (
        <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="currentColor" opacity={0.2} />
      )}
      {buckets.map((bucket, index) => {
        const total = totalOf(bucket);
        // A bucket too small to see still gets one pixel, so every busy stretch shows.
        const barHeight = total === 0 ? 0 : Math.max(1, (total / most) * plot);
        return (
          <g key={bucket.start}>
            {barHeight === 0 ? null : (
              <rect
                x={left + index * slot}
                y={top + plot - barHeight}
                width={barWidth}
                height={barHeight}
                rx={Math.min(1, barWidth / 2)}
                fill="currentColor"
                opacity={active === undefined || active === null || active === index ? 1 : 0.45}
              />
            )}
            {onHover === undefined ? null : (
              <rect
                x={left + index * slot}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                onMouseEnter={() => onHover(index)}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** "15 minutes", "hour", "3 hours": the span one bar covers, for the chart's title. */
export function bucketSpan(bucket: TimeBucket | undefined): string {
  if (bucket === undefined) return "stretch";
  const minutes = Math.round((bucket.end - bucket.start) / 60_000);
  if (minutes === 1) return "minute";
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return "hour";
  if (minutes === 1_440) return "day";
  return `${minutes / 60} hours`;
}

function day(time: number): string {
  return new Date(time).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function clock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Thu, Sep 24, 10:20 AM to 1:27 PM", naming the day once when both fall on it. */
export function spanLabel(first: number, last: number): string {
  if (day(first) === day(last)) return `${day(first)}, ${clock(first)} to ${clock(last)}`;
  return `${day(first)}, ${clock(first)} to ${day(last)}, ${clock(last)}`;
}

/** A clock time, with the day in front when it is not the day `reference` falls on. */
function timeLabel(time: number, reference: number): string {
  return day(time) === day(reference) ? clock(time) : `${day(time)}, ${clock(time)}`;
}

function percent(part: number, total: number): string {
  if (total === 0) return "0%";
  const value = (part / total) * 100;
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
}

/** Where a turn's time went, in the order the bars stack them. */
export const TIME_PARTS = [
  { key: "model", label: "Model", color: "#7c6cf2" },
  { key: "tools", label: "Tools", color: "#2a9fd6" },
  { key: "waiting", label: "Waiting on you", color: "#e0a100" },
] as const;

type TimeSplit = NonNullable<TurnDetail["time"]>;

const timeTotal = (split: TimeSplit) => split.model + split.tools + split.waiting;

/** "36 sec", "14 min", "1 hr 5 min", for a span in milliseconds. */
export function formatSpan(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`;
}

function SplitBar({ split, width }: { split: TimeSplit; width: number }) {
  const all = Math.max(1, timeTotal(split));
  return (
    <span className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted" style={{ width }} aria-hidden>
      {TIME_PARTS.map((part) =>
        split[part.key] > 0 ? (
          <span key={part.key} style={{ width: `${(split[part.key] / all) * 100}%`, background: part.color }} />
        ) : null,
      )}
    </span>
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * One stacked bar per finished turn, in the order they ran, split into model,
 * tools, and waiting on you. Hover a bar for the message behind it.
 */
function TurnMinutes({ turns, total, reference }: { turns: TurnDetail[]; total: number; reference: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const timed = turns.filter((turn): turn is TurnDetail & { time: TimeSplit } => turn.time != null);
  if (timed.length === 0) return null;
  const width = 368;
  const height = 70;
  const ticks = niceTicks(Math.max(...timed.map((turn) => timeTotal(turn.time))) / 60_000, 2);
  const most = Math.max(1, ticks.at(-1)!) * 60_000;
  const plot = height - 2 * AXIS_PAD;
  const slot = (width - AXIS_WIDTH) / timed.length;
  const barWidth = Math.max(1, slot - (timed.length > 24 ? 1 : 2));
  const y = (ms: number) => AXIS_PAD + plot - (ms / most) * plot;
  const hoveredTurn = hovered === null ? undefined : timed[hovered];
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">Minutes per turn</p>
      <svg width={width} height={height} aria-hidden className="text-foreground/70" onMouseLeave={() => setHovered(null)}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={AXIS_WIDTH}
              x2={width}
              y1={Math.round(y(tick * 60_000)) - 0.5}
              y2={Math.round(y(tick * 60_000)) - 0.5}
              stroke="currentColor"
              opacity={tick === 0 ? 0.2 : 0.1}
            />
            <text x={AXIS_WIDTH - 6} y={y(tick * 60_000)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
              {tick}
            </text>
          </g>
        ))}
        {timed.map((turn, index) => {
          let base = 0;
          return (
            <g key={turn.turnId ?? index} opacity={hovered === null || hovered === index ? 1 : 0.45}>
              {TIME_PARTS.map((part) => {
                const value = turn.time[part.key];
                if (value <= 0) return null;
                const top = y(base + value);
                const bottom = y(base);
                base += value;
                return (
                  <rect
                    key={part.key}
                    x={AXIS_WIDTH + index * slot}
                    y={top}
                    width={barWidth}
                    height={Math.max(0.5, bottom - top)}
                    fill={part.color}
                  />
                );
              })}
              <rect
                x={AXIS_WIDTH + index * slot}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHovered(index)}
              />
            </g>
          );
        })}
      </svg>
      <p className="flex pl-[34px] text-[11px] text-muted-foreground">
        <span className="flex-1">Turn 1</span>
        <span>
          Turn {timed.length} · median {formatSpan(median(timed.map((turn) => timeTotal(turn.time))))}
        </span>
      </p>
      <div className="flex gap-3 pl-[34px] text-[11px] text-muted-foreground">
        {TIME_PARTS.map((part) => (
          <span key={part.key} className="flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: part.color }} aria-hidden />
            {part.label}
          </span>
        ))}
      </div>
      {hoveredTurn === undefined ? null : (
        <ul className="rounded-md bg-muted/50 px-2.5 py-2">
          <TurnLine turn={hoveredTurn} total={total} reference={reference} />
        </ul>
      )}
    </div>
  );
}

function duration(turn: TurnDetail): string | null {
  if (turn.endedAt === null) return "still running";
  const minutes = Math.round((turn.endedAt - turn.startedAt) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}

/**
 * The start of a chart ending at `to`: `from`, or earlier when that would give
 * fewer than `count` one-minute buckets. A thread whose usage all landed at
 * once then draws a thin bar at the right, not one bar the chart's width.
 */
function paddedFrom(from: number, to: number, count: number): number {
  return Math.min(from, to - (count - 1) * 60_000);
}

/** The header sparkline's buckets: the recorded rows, up to the last. */
export function sparkBuckets(recent: readonly UsageAt[]): TimeBucket[] {
  const first = recent[0];
  const last = recent.at(-1);
  if (first === undefined || last === undefined) return [];
  return timeBuckets(recent, (row) => row.at, paddedFrom(first.at, last.at, SPARK_BUCKETS), last.at, SPARK_BUCKETS);
}

function TurnLine({ turn, total, reference }: { turn: TurnDetail; total: number; reference: number }) {
  const tokens = totalOf(turn);
  const meta = [timeLabel(turn.startedAt, reference), duration(turn), `${percent(tokens, total)} of the thread`];
  return (
    <li className="flex gap-3 text-xs">
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", turn.prompt === null && "text-muted-foreground")}>
          {turn.prompt ?? (turn.turnId === null ? "Before the first recorded turn" : "Continued without a new message")}
        </span>
        <span className="block truncate text-muted-foreground">{meta.join(" · ")}</span>
        {turn.time == null || timeTotal(turn.time) === 0 ? null : (
          <span
            className="block"
            title={TIME_PARTS.map((part) => `${part.label} ${formatSpan(turn.time![part.key])}`).join(" · ")}
          >
            <SplitBar split={turn.time} width={200} />
          </span>
        )}
      </span>
      <span className="shrink-0 tabular-nums">{formatTokens(tokens)}</span>
    </li>
  );
}

/** A bucket to show hovered on first render: an index, or the one that used the most. */
export type InitialHover = number | "largest" | null;

export function ThreadTokenSummary({
  usage,
  turns,
  onOpenPage,
  initialHovered = null,
}: {
  usage: ThreadTokens;
  /** Null while the turns are loading. */
  turns: TurnDetail[] | null;
  onOpenPage?: () => void;
  /** For stories, so the readout under the chart can be drawn filled in. */
  initialHovered?: InitialHover;
}) {
  const [hoverState, setHovered] = useState<InitialHover>(initialHovered);
  const recorded = totalOf(usage);
  const unrecorded = usage.total - recorded;
  const first = usage.recent[0];
  const last = usage.recent.at(-1);

  // Until the turns load, the chart draws the recorded rows on their own.
  const start = turns?.[0]?.startedAt ?? first?.at;
  const to = turns === null ? last?.at : turns.reduce((latest, turn) => Math.max(latest, turn.usageAt), start ?? 0);
  const from = start === undefined || to === undefined ? undefined : paddedFrom(start, to, CHART_BUCKETS);
  const buckets =
    from === undefined || to === undefined
      ? []
      : turns === null
        ? timeBuckets(usage.recent, (row) => row.at, from, to, CHART_BUCKETS)
        : timeBuckets(turns, (turn) => turn.usageAt, from, to, CHART_BUCKETS);
  const hovered =
    hoverState === "largest"
      ? buckets.reduce((best, bucket, index) => (totalOf(bucket) > totalOf(buckets[best]!) ? index : best), 0)
      : hoverState;
  const hoveredBucket = hovered === null ? undefined : buckets[hovered];
  const biggest = turns === null ? [] : [...turns].sort((a, b) => totalOf(b) - totalOf(a)).slice(0, BIGGEST);
  const inBucket =
    hoveredBucket === undefined || turns === null
      ? []
      : hoveredBucket.items
          .map((index) => turns[index]!)
          .filter((turn) => totalOf(turn) > 0)
          .sort((a, b) => totalOf(b) - totalOf(a))
          .slice(0, BIGGEST);

  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-xl font-semibold tabular-nums">
          {formatTokens(usage.total)}
          <span className="ml-1.5 text-sm font-normal text-muted-foreground">
            tokens over {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
          </span>
        </p>
        {first === undefined || last === undefined ? null : (
          <p className="text-xs text-muted-foreground">{spanLabel(start ?? first.at, last.at)}</p>
        )}
      </div>

      {buckets.length === 0 || from === undefined || to === undefined ? null : (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Tokens per {bucketSpan(buckets[0])}</p>
          <div className="text-foreground/70">
            <Spark
              buckets={buckets}
              axis
              width={368}
              height={80}
              gap={buckets.length > 24 ? 1 : 2}
              active={hovered}
              onHover={setHovered}
            />
          </div>
          <p className="flex pl-[34px] text-[11px] text-muted-foreground">
            <span className="flex-1">{clock(from)}</span>
            <span>{timeLabel(to, from)}</span>
          </p>
          <div className="min-h-[52px] rounded-md bg-muted/50 px-2.5 py-2">
            {hoveredBucket === undefined ? (
              <p className="text-xs text-muted-foreground">Hover a bar to see the messages behind it.</p>
            ) : (
              <div className="space-y-1.5">
                <p className="flex text-xs font-medium">
                  <span className="flex-1">
                    {timeLabel(hoveredBucket.start, from)} to {clock(hoveredBucket.end)}
                  </span>
                  <span className="tabular-nums">{formatTokens(totalOf(hoveredBucket))}</span>
                </p>
                {totalOf(hoveredBucket) === 0 ? (
                  <p className="text-xs text-muted-foreground">No tokens used.</p>
                ) : turns === null ? (
                  <p className="text-xs text-muted-foreground">Loading the messages…</p>
                ) : (
                  <ul className="space-y-1.5">
                    {inBucket.map((turn) => (
                      <TurnLine key={turn.turnId ?? "before"} turn={turn} total={usage.total} reference={from} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {turns === null ? null : <TurnMinutes turns={turns} total={usage.total} reference={from ?? start ?? 0} />}

      {turns === null || biggest.length < 2 ? null : (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Biggest turns</p>
          <ul className="space-y-1.5">
            {biggest.map((turn) => (
              <TurnLine key={turn.turnId ?? "before"} turn={turn} total={usage.total} reference={from ?? turn.startedAt} />
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
          {PARTS.map((part) =>
            usage[part.key] > 0 ? (
              <span key={part.key} className={part.swatch} style={{ flexGrow: usage[part.key], minWidth: 2 }} />
            ) : null,
          )}
        </div>
        {PARTS.map((part) => (
          <p key={part.key} className="flex items-center gap-2 text-xs">
            <span className={cn("size-2.5 rounded-sm", part.swatch)} aria-hidden />
            <span className="flex-1 text-muted-foreground">{part.label}</span>
            <span className="tabular-nums">{usage[part.key].toLocaleString()}</span>
            <span className="w-9 text-right tabular-nums text-muted-foreground">{percent(usage[part.key], recorded)}</span>
          </p>
        ))}
        {usage.subagents !== undefined && usage.subagents.tokens > 0 ? (
          <p className="text-xs text-muted-foreground">
            Includes {formatTokens(usage.subagents.tokens)} from {usage.subagents.count}{" "}
            {usage.subagents.count === 1 ? "subagent" : "subagents"}, which sandy does not count in the thread's own usage.
          </p>
        ) : null}
        {unrecorded > 0 ? (
          <p className="text-xs text-muted-foreground">
            Plus {unrecorded.toLocaleString()} from earlier turns that sandy deleted before Value could record them.
          </p>
        ) : null}
      </div>

      {onOpenPage === undefined ? null : (
        <Button variant="outline" size="sm" className="w-full" onClick={onOpenPage}>
          Open Value
        </Button>
      )}
    </div>
  );
}

export function ThreadTokenCount({
  usage,
  turns,
  onOpen,
  onOpenPage,
  isCompactViewport = false,
  defaultOpen = false,
  initialHovered,
  now = Date.now(),
}: {
  usage: ThreadTokens;
  turns: TurnDetail[] | null;
  /** Called when the summary opens, so the turns load only when wanted. */
  onOpen?: () => void;
  onOpenPage?: () => void;
  isCompactViewport?: boolean;
  /** Open on first render, for stories. */
  defaultOpen?: boolean;
  initialHovered?: InitialHover;
  /** What "past day" is measured from; stories pin it. */
  now?: number;
}) {
  const pastDay = pastDayTokens(usage.recent, now);
  return (
    <Popover defaultOpen={defaultOpen} onOpenChange={(open) => (open ? onOpen?.() : undefined)}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 cursor-pointer gap-1.5 px-2 tabular-nums"
          aria-label={`${formatTokens(pastDay)} tokens in the past day, of ${formatTokens(usage.total)} used by this thread. Show the summary.`}
        >
          {isCompactViewport ? null : (
            <span className="text-muted-foreground">
              <Spark buckets={sparkBuckets(usage.recent)} width={40} height={14} gap={1} />
            </span>
          )}
          {/* As the page's thread list shows it: the past day's tokens over the thread's lifetime. */}
          <TokenPair period={pastDay} total={usage.total} header />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[400px] p-4">
        <ThreadTokenSummary usage={usage} turns={turns} onOpenPage={onOpenPage} initialHovered={initialHovered} />
      </PopoverContent>
    </Popover>
  );
}
