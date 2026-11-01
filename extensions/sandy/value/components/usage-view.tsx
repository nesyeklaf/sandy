// The Value page: range picker, headline total, chart, and thread list.
// Display only; app.tsx loads the data.
import { useState } from "react";

import { addTokens, totalOf, ZERO_TOKENS } from "@/usage/breakdown";
import type { Limit, ThreadUsage, TurnTimeBreakdown as Breakdown } from "@/usage/contract";
import { formatTokens, RANGES, type Bar, type RangeId } from "@/usage/series";

import { Segmented } from "./segmented";
import type { ContextThresholds } from "@/usage/context";

import { TurnTimeBreakdown } from "./turn-time-breakdown";
import { ThreadUsageList, splitArchived } from "./thread-usage-list";
import { ValueDetail, ValueHosts, ValueOverview, type ValueData } from "./value-panels";
import { PARTS, UsageChart, UsageLegend, type PartKey, type Projection } from "./usage-chart";

export interface UsageData {
  since: number;
  bars: Bar[];
  unit: "hour" | "day";
  threads: ThreadUsage[];
  recordingSince: number;
  /** Threads whose context is past these are tinted amber, then red. */
  contextThresholds?: ContextThresholds;
  /** Where the period's turn time went, for the section under the chart. */
  turnTime?: Breakdown;
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "value", label: "Value per 1%" },
  { id: "usage", label: "Usage" },
  { id: "hosts", label: "Hosts" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const HOUR = 3_600_000;
/** A session lasts five hours, so its reset is at most this many bars ahead. */
const MAX_AHEAD = 5;

/**
 * On the past day, once a session is on pace for the warning or will run
 * out, the chart runs on to its reset with hatched bars at the past hour's
 * pace. It drops as many of its oldest hours as it adds, so it keeps 24.
 */
export function withProjection(
  bars: readonly Bar[],
  unit: "hour" | "day",
  limits: readonly Limit[],
  now: number,
): { bars: readonly Bar[]; projection: Projection | null } {
  const session = limits.find((limit) => limit.kind === "five-hour" && limit.tone !== "ok" && limit.pacePerHour !== null);
  const last = bars.at(-1);
  if (unit !== "hour" || session === undefined || last === undefined || session.lastHourTokens === 0) {
    return { bars, projection: null };
  }
  if (session.resetsAt <= now) return { bars, projection: null };
  const ahead = Math.min(MAX_AHEAD, Math.max(0, Math.ceil((session.resetsAt - last.end) / HOUR)));
  const future: Bar[] = Array.from({ length: ahead }, (_, index) => ({
    start: last.end + index * HOUR,
    end: last.end + (index + 1) * HOUR,
    ...ZERO_TOKENS,
  }));
  return {
    bars: [...bars.slice(ahead), ...future],
    projection: {
      from: now,
      until: session.resetsAt,
      tokensPerHour: session.lastHourTokens,
      runsOutAt: session.usedPercent >= 100 ? null : session.runsOutAt,
    },
  };
}

function recordingNote(data: UsageData): string | null {
  if (data.recordingSince <= data.since) return null;
  const when = new Date(data.recordingSince).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Value started recording ${when}. Turns before then count only where sandy had not yet pruned them, so earlier bars can read low.`;
}

export function UsageView({
  range,
  onRange,
  data,
  error,
  onOpenThread,
  initialHovered,
  now = Date.now(),
  limits = [],
  providerName = (providerId) => providerId,
  value = null,
  initialTab = "overview",
}: {
  range: RangeId;
  onRange: (range: RangeId) => void;
  data: UsageData | null;
  error: string | null;
  onOpenThread: (threadId: string) => void;
  /** A bar to show hovered on first render, for stories. */
  initialHovered?: number;
  /** What "recently" is measured from; stories pin it. */
  now?: number;
  /** The subscriptions' usage limits, for the meters and the chart's hatched bars. */
  limits?: readonly Limit[];
  providerName?: (providerId: string) => string;
  /** What 1% of each limit is worth; null while loading. */
  value?: ValueData | null;
  /** The tab to open on, for stories. */
  initialTab?: TabId;
}) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [hidden, setHidden] = useState<ReadonlySet<PartKey>>(new Set());
  const toggle = (key: PartKey) =>
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const sum = data === null ? ZERO_TOKENS : data.bars.reduce(addTokens, ZERO_TOKENS);
  const note = data === null ? null : recordingNote(data);
  const chart = data === null ? null : withProjection(data.bars, data.unit, limits, now);

  const usageTab = (
    <>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">
            {data === null ? "…" : formatTokens(totalOf(sum))}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">tokens</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {PARTS.map((part) => `${formatTokens(sum[part.key])} ${part.label.toLowerCase()}`).join(" · ")}
          </p>
        </div>
        <Segmented label="Period" options={RANGES} value={range} onChange={onRange} />
      </div>

      <div className="mt-4 rounded-lg border border-border bg-card px-3 pb-2 pt-3">
        {data === null ? (
          <div className="h-[230px]" role="status" aria-label="Loading usage" />
        ) : (
          <UsageChart
            bars={chart!.bars}
            unit={data.unit}
            hidden={hidden}
            initialHovered={initialHovered}
            projection={chart!.projection}
          />
        )}
        <div className="mt-1 pl-[44px]">
          <UsageLegend hidden={hidden} onToggle={toggle} pace={chart?.projection != null} />
        </div>
      </div>
      {note === null ? null : <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      {data?.turnTime === undefined ? null : (
        <TurnTimeBreakdown breakdown={data.turnTime} period={RANGES.find((option) => option.id === range)?.label ?? ""} />
      )}

      <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Threads</h2>
        {data === null ? null : (
          <p className="text-xs text-muted-foreground">
            {(() => {
              const { active, archived } = splitArchived(data.threads);
              return `${active.length} active · ${archived.length} archived`;
            })()}
          </p>
        )}
      </div>
      {data === null ? null : (
        <ThreadUsageList threads={data.threads} bars={data.bars} contextThresholds={data.contextThresholds} onOpen={onOpenThread} />
      )}
    </>
  );

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <Segmented label="View" options={TABS} value={tab} onChange={(id) => setTab(id as TabId)} />

        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {tab === "overview" ? <ValueOverview data={value} limits={limits} providerName={providerName} now={now} /> : null}
        {tab === "value" ? <ValueDetail data={value} providerName={providerName} /> : null}
        {tab === "usage" ? usageTab : null}
        {tab === "hosts" ? <ValueHosts data={value} providerName={providerName} /> : null}
      </div>
    </div>
  );
}
