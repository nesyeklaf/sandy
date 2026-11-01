// The meters above the chart: each subscription limit's percent used of
// about how many tokens it holds, a lighter fill to where it lands at its
// reset at the current pace, and a sentence saying so. Display only; app.tsx loads the limits.
import { cn } from "@/lib/utils";
import type { Limit } from "@/usage/contract";
import { formatTokens } from "@/usage/series";

/** The context meter's amber, so a warning reads the same everywhere in the plugin. */
const AMBER = "#d97706";

const MINUTE = 60_000;

function clock(time: number, withDay: boolean): string {
  return new Date(time).toLocaleString([], {
    ...(withDay ? { weekday: "short" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
}

/** A weekly reset is days away, so it names the day. */
function withDay(limit: Limit): boolean {
  return limit.resetsAt - limit.sampledAt > 20 * 60 * MINUTE;
}

/** "On pace for 95% by 8:50 AM", "On pace to run out at 6:56 AM, 1h 54m before it resets", and so on. */
export function paceText(limit: Limit): string {
  const day = withDay(limit);
  if (limit.usedPercent >= 100) return `Used up until ${clock(limit.resetsAt, day)}`;
  if (limit.runsOutAt !== null) {
    return `On pace to run out at ${clock(limit.runsOutAt, day)}, ${duration(limit.resetsAt - limit.runsOutAt)} before it resets`;
  }
  if (limit.projectedPercent === null) return "Measuring the pace";
  return `On pace for ${Math.round(Math.min(100, limit.projectedPercent))}% by ${clock(limit.resetsAt, day)}`;
}

/** "4% of ~300M" once the window's size is known, "4% used" until then. */
export function usedText(limit: Limit): string {
  const percent = Math.round(limit.usedPercent);
  return typeof limit.sizeTokens === "number" ? `${percent}% of ~${formatTokens(limit.sizeTokens)}` : `${percent}% used`;
}

function toneStyle(limit: Limit) {
  if (limit.tone === "error") return { text: "text-destructive", fill: "bg-destructive", color: undefined };
  if (limit.tone === "warning") return { text: "", fill: "", color: AMBER };
  return { text: "", fill: "bg-foreground/60", color: undefined };
}

function LimitMeter({ limit, label }: { limit: Limit; label: string }) {
  const style = toneStyle(limit);
  const used = Math.min(100, limit.usedPercent);
  const projected = Math.min(100, limit.projectedPercent ?? used);
  return (
    <div className="min-w-0 flex-1 basis-64">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">
          <span className="font-medium">{label}</span>
          <span className="ml-1.5 text-muted-foreground">resets {clock(limit.resetsAt, withDay(limit))}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{usedText(limit)}</span>
      </div>
      <div
        className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${label}: ${usedText(limit)} tokens. ${paceText(limit)}.`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
      >
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full opacity-30", style.fill)}
          style={{ width: `${projected}%`, background: style.color }}
        />
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", style.fill)}
          style={{ width: `${used}%`, background: style.color }}
        />
      </div>
      <p className={cn("mt-1 text-xs", style.text)} style={{ color: style.color }}>
        {paceText(limit)}
        {limit.sizeTokens === null && <span className="text-muted-foreground"> · sizing the limit</span>}
      </p>
    </div>
  );
}

const accountOf = (limit: Limit) => `${limit.providerId}:${limit.accountKey ?? ""}`;

/**
 * One meter per limit. With more than one subscription, each one's meters
 * sit in their own row under the provider's name, so two accounts' sessions
 * stay apart.
 */
export function LimitMeters({
  limits,
  providerName,
  className = "mt-3",
}: {
  limits: readonly Limit[];
  providerName: (providerId: string) => string;
  className?: string;
}) {
  if (limits.length === 0) return null;
  const accounts = new Map<string, Limit[]>();
  for (const limit of limits) accounts.set(accountOf(limit), [...(accounts.get(accountOf(limit)) ?? []), limit]);
  const row = (group: readonly Limit[]) => (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      {group.map((limit) => (
        <LimitMeter key={`${accountOf(limit)}:${limit.label}`} limit={limit} label={limit.label} />
      ))}
    </div>
  );
  if (accounts.size === 1) return <div className={className}>{row(limits)}</div>;
  return (
    <div className={cn("space-y-3", className)}>
      {[...accounts.entries()].map(([key, group]) => (
        <section key={key} aria-label={providerName(group[0]!.providerId)}>
          <h3 className="mb-1 text-xs text-muted-foreground">{providerName(group[0]!.providerId)}</h3>
          {row(group)}
        </section>
      ))}
    </div>
  );
}
