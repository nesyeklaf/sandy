// The threads that used tokens in the window, most first, each with a
// sparkline of when it used them. Display only.
import { useState, type MouseEvent } from "react";

import { cn } from "@/lib/utils";
import { totalOf } from "@/usage/breakdown";
import { contextLevel, type ContextLevel, type ContextThresholds } from "@/usage/context";
import type { ThreadUsage } from "@/usage/contract";
import { formatTokens, type Bar } from "@/usage/series";

import { HoverTip, type TipPosition } from "./hover-tip";
import { TokenPair } from "./token-pair";
import { formatSpan } from "./thread-token-count";
import { TurnDots, TurnDotsAxis, turnStats } from "./turn-dots";

/**
 * The period's threads in two groups, active first, then archived, each
 * with the most tokens first. Deleted threads count as archived.
 */
export function splitArchived(threads: readonly ThreadUsage[]): { active: ThreadUsage[]; archived: ThreadUsage[] } {
  const sorted = [...threads].sort((a, b) => totalOf(b) - totalOf(a));
  return {
    active: sorted.filter((thread) => thread.archivedAt === null),
    archived: sorted.filter((thread) => thread.archivedAt !== null),
  };
}

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

function providerName(providerId: string): string {
  return PROVIDER_NAMES[providerId] ?? providerId;
}

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 20;

/** The thread's tokens in each of the page chart's bars. */
export function threadBars(thread: ThreadUsage, bars: readonly Bar[]): number[] {
  const totals = bars.map(() => 0);
  for (const { hour, total } of thread.hours) {
    const index = bars.findIndex((bar) => hour >= bar.start && hour < bar.end);
    if (index !== -1) totals[index]! += total;
  }
  return totals;
}

/**
 * When the thread used its tokens, on the same bars as the page's chart and
 * scaled to its own busiest one, so a thread still running when you expected
 * it to stop shows bars at the right end. The total beside it gives the size.
 */
function sparkLabel(bar: Bar): string {
  const daily = bar.end - bar.start >= 86_400_000;
  return new Date(bar.start).toLocaleString(
    [],
    daily ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "short", hour: "numeric" },
  );
}

/**
 * When the thread used its tokens, on the same bars as the page's chart and
 * scaled to its own busiest one, so a thread still running when you expected
 * it to stop shows bars at the right end. The total beside it gives the size.
 * Hover a bar for its time and tokens.
 */
function RowSpark({ totals, bars }: { totals: readonly number[]; bars: readonly Bar[] }) {
  const [hovered, setHovered] = useState<{ index: number; at: TipPosition } | null>(null);
  const most = Math.max(1, ...totals);
  const slot = totals.length === 0 ? 0 : SPARK_WIDTH / totals.length;
  const barWidth = Math.max(1, slot - (slot > 4 ? 1 : 0.5));
  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.min(totals.length - 1, Math.max(0, Math.floor((event.clientX - box.left) / slot)));
    setHovered(totals[index]! > 0 ? { index, at: { x: box.left + index * slot + barWidth / 2, y: box.top } } : null);
  };
  const bar = hovered === null ? undefined : bars[hovered.index];
  return (
    <>
      <svg
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        className="shrink-0"
        onMouseMove={slot === 0 ? undefined : onMove}
        onMouseLeave={() => setHovered(null)}
      >
        <line x1={0} x2={SPARK_WIDTH} y1={SPARK_HEIGHT - 0.5} y2={SPARK_HEIGHT - 0.5} stroke="currentColor" opacity={0.2} />
        {totals.map((total, index) => {
          if (total === 0) return null;
          const height = Math.max(1, (total / most) * SPARK_HEIGHT);
          return (
            <rect
              key={index}
              x={index * slot}
              y={SPARK_HEIGHT - height}
              width={barWidth}
              height={height}
              rx={Math.min(1, barWidth / 2)}
              fill="currentColor"
              opacity={hovered === null || hovered.index === index ? 1 : 0.45}
            />
          );
        })}
      </svg>
      {hovered === null || bar === undefined ? null : (
        <HoverTip at={hovered.at}>
          <span className="font-medium">{formatTokens(totals[hovered.index]!)} tokens</span>
          <span className="text-muted-foreground"> · {sparkLabel(bar)}</span>
        </HoverTip>
      )}
    </>
  );
}


/** How an active thread's latest context rates against the settings; archived threads are not rated. */
export function threadContextLevel(thread: ThreadUsage, thresholds: ContextThresholds): ContextLevel | null {
  if (thread.archivedAt !== null || thread.context === null) return null;
  return contextLevel(thread.context, thresholds);
}

/** The context meter's amber, so a warning reads the same on the page and above the composer. */
const AMBER = "#d97706";

const NO_THRESHOLDS: ContextThresholds = { warning: null, error: null };

export function ThreadUsageList({
  threads,
  bars,
  contextThresholds = NO_THRESHOLDS,
  onOpen,
}: {
  /** Every thread that used tokens in the period, most first. */
  threads: readonly ThreadUsage[];
  /** The page chart's bars, which the sparklines line up with. */
  bars: readonly Bar[];
  /** The context settings; rows past them are tinted as Now tints what is due today, then what is overdue. */
  contextThresholds?: ContextThresholds;
  onOpen: (threadId: string) => void;
}) {
  if (threads.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
      >
        No thread used tokens in this period.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="hidden items-end gap-3 border-b border-border px-4 py-1.5 text-[11px] text-muted-foreground sm:flex">
        <span className="flex-1" />
        <span className="w-[188px] shrink-0">Tokens</span>
        <span className="hidden shrink-0 lg:block" title="One dot per turn, on a log scale; the bar marks the median">
          <TurnDotsAxis />
        </span>
        <span className="hidden w-20 shrink-0 text-right lg:block">Turn time</span>
      </div>
      {(() => {
        const { active, archived } = splitArchived(threads);
        const row = (thread: ThreadUsage) => {
        const total = totalOf(thread);
        const archived = thread.archivedAt !== null;
        const level = threadContextLevel(thread, contextThresholds);
        const turnTimes = thread.turnTimes ?? [];
        const durations = turnTimes.map((turn) => turn.ms);
        const stats = turnStats(durations);
        const meta = [
          thread.projectName,
          providerName(thread.providerId),
          `${thread.turns} ${thread.turns === 1 ? "turn" : "turns"}`,
        ].filter((part) => part !== null && part !== "");
        return (
          <li
            key={thread.threadId}
            className={cn(
              archived && "bg-muted/30",
              // Now's due-today and overdue treatments: a bar where the padding was.
              level === "warning" &&
                "border-l-2 border-l-[#eda100] bg-[#eda100]/[0.06] dark:border-l-[#c98500] dark:bg-[#c98500]/[0.08]",
              level === "error" && "border-l-2 border-l-destructive bg-destructive/[0.04]",
            )}
            title={level === null ? undefined : `Its context is ${formatTokens(thread.context!)} tokens, which every model call re-reads`}
          >
            <button
              type="button"
              onClick={() => onOpen(thread.threadId)}
              className={cn(
                "flex w-full items-center gap-3 py-2.5 pr-4 text-left text-sm hover:bg-muted/50",
                level === null ? "pl-4" : "pl-[14px]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "truncate",
                      (thread.title === null || archived) && "text-muted-foreground",
                    )}
                  >
                    {thread.title ?? "Untitled thread"}
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {meta.join(" · ")}
                  {thread.context === null ? null : (
                    <>
                      {" · "}
                      <span
                        className={cn(level === "error" && "font-medium text-destructive")}
                        style={level === "warning" ? { color: AMBER, fontWeight: 500 } : undefined}
                      >
                        {formatTokens(thread.context)} context
                      </span>
                    </>
                  )}
                </span>
              </span>
              <span className="flex shrink-0 items-center justify-end gap-2 sm:w-[188px]">
                <span className={cn("hidden sm:block", archived ? "text-muted-foreground/60" : "text-foreground/60")}>
                  <RowSpark totals={threadBars(thread, bars)} bars={bars} />
                </span>
                <span
                  className="w-[60px] shrink-0"
                  title={
                    thread.lifetime !== undefined
                      ? `${total.toLocaleString()} tokens in this period, of ${thread.lifetime.toLocaleString()} in all`
                      : `${total.toLocaleString()} tokens`
                  }
                >
                  <TokenPair period={total} total={thread.lifetime ?? total} muted={archived} />
                </span>
              </span>
              <span className={cn("hidden lg:block", archived && "opacity-50")}>
                <TurnDots turns={turnTimes} />
              </span>
              <span
                className={cn("hidden w-20 shrink-0 text-right tabular-nums lg:block", archived && "text-muted-foreground")}
                title={
                  stats === null
                    ? "No turn times recorded"
                    : `${durations.length} turns took ${formatSpan(stats.total)}; the longest ${formatSpan(stats.longest)}`
                }
              >
                {stats === null ? (
                  "–"
                ) : (
                  <>
                    <span className="block">{formatSpan(stats.total)}</span>
                    <span className="block whitespace-nowrap text-xs text-muted-foreground">median {formatSpan(stats.median)}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        );
        };
        return (
          <>
            {active.length === 0 ? null : <ul className="divide-y divide-border">{active.map(row)}</ul>}
            {archived.length === 0 ? null : (
              <>
                <h3
                  className={cn(
                    "bg-muted/30 px-4 py-1.5 text-[11px] font-medium text-muted-foreground",
                    active.length > 0 && "border-t border-border",
                  )}
                >
                  Archived · {archived.length}
                </h3>
                <ul className="divide-y divide-border border-t border-border">{archived.map(row)}</ul>
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}
