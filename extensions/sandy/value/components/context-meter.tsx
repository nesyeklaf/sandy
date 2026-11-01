// The meter above a thread's composer once its context passes the warning
// setting: the context size against the model's window, amber past the
// warning and red past the error, the last turn's tokens, and a button that
// compacts the thread. Display only.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContextLevel, ContextThresholds } from "@/usage/context";
import { formatTokens } from "@/usage/series";

/** Tailwind's amber-600, which reads on both light and dark backgrounds. */
const AMBER = "#d97706";

export interface ContextMeterProps {
  usedTokens: number;
  /** The model's window; without it the bar is left out. */
  contextWindow: number | null;
  thresholds: ContextThresholds;
  /** Which setting the context has passed. */
  level: ContextLevel;
  lastTurn: number | null;
  /** A turn is running, so sandy would refuse to compact. */
  running: boolean;
  /** The compact request is on its way or its turn is running. */
  compacting: boolean;
  error: string | null;
  /** Narrow composer: the bar and the last turn drop out. */
  compact?: boolean;
  onCompact: () => void;
}

export function ContextMeter({
  usedTokens,
  contextWindow,
  thresholds,
  level,
  lastTurn,
  running,
  compacting,
  error,
  compact = false,
  onCompact,
}: ContextMeterProps) {
  // Claude Code sometimes reports a 200K window for a thread already past it,
  // so a window smaller than the context is left out rather than drawn full.
  const window = contextWindow !== null && contextWindow >= usedTokens ? contextWindow : null;
  const showBar = !compact && window !== null;
  const fill = window === null ? 0 : usedTokens / window;
  const ticks = [thresholds.warning, thresholds.error].filter(
    (at): at is number => at !== null && window !== null && at < window,
  );
  // Red is sandy's destructive color, so it follows the theme.
  const color = level === "error" ? undefined : AMBER;
  const passed = level === "error" ? thresholds.error : thresholds.warning;
  const details = [
    !compact && lastTurn !== null ? `${formatTokens(lastTurn)} last turn` : null,
    window !== null ? `${formatTokens(window)} max` : null,
  ].filter((part) => part !== null);
  const label = compacting ? "Compacting…" : "Compact";
  const why = running && !compacting ? "A thread can be compacted once its turn ends." : undefined;
  return (
    <div
      role="status"
      className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs"
      // sandy stacks composer banners in a grid, in plugin order, and wraps each
      // plugin's banner in a display: contents root. So this is a grid item,
      // and order puts it above the other plugins' banners, such as the
      // GitHub context one.
      style={{ order: -1 }}
      aria-label={`This thread's context is ${formatTokens(usedTokens)} tokens, past the ${formatTokens(passed ?? 0)} ${level === "error" ? "limit" : "warning"}.`}
    >
      <div className="flex items-center gap-3">
        <span className="shrink-0 tabular-nums">
          <span className={cn("font-medium", level === "error" && "text-destructive")} style={{ color }}>
            {formatTokens(usedTokens)}
          </span>
          <span className="text-muted-foreground"> context</span>
        </span>
        {showBar ? (
          <span className="relative h-1.5 min-w-0 flex-1 rounded-full bg-muted" aria-hidden>
            <span
              className={cn("absolute inset-y-0 left-0 rounded-full", level === "error" && "bg-destructive")}
              style={{ width: `${fill * 100}%`, background: color }}
            />
            {ticks.map((at) => (
              <span
                key={at}
                className="absolute bg-foreground/50"
                style={{ left: `${(at / window!) * 100}%`, top: -3, bottom: -3, width: 1 }}
              />
            ))}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {details.length === 0 ? null : (
          <span className="shrink-0 tabular-nums text-muted-foreground">{details.join(" · ")}</span>
        )}
        <span
          className="shrink-0"
          title={why ?? "Replace the conversation so far with a summary, so each model call reads less"}
        >
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={running || compacting}
            onClick={onCompact}
          >
            {label}
          </Button>
        </span>
      </div>
      {error === null ? null : <p className="mt-1 text-destructive">Couldn't compact: {error}</p>}
    </div>
  );
}
