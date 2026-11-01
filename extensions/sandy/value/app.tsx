// sandy-plugin-value — the Value page, the thread header's token count,
// and the context meter above a thread's composer.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  definePluginApp,
  useSandyNavigate,
  useComposer,
  useRealtime,
  useRpc,
  experimental_useProviders,
  type ExperimentalBadge,
  type PluginThreadHeaderActionProps,
} from "@sandy-sdk/plugin-sdk/app";

import { ContextMeter } from "@/components/context-meter";
import { ThreadTokenCount, type ThreadTokens } from "@/components/thread-token-count";
import { UsageView, type UsageData } from "@/components/usage-view";
import type { ValueData } from "@/components/value-panels";

import type { rpcContract } from "./server";
import { contextLevel, type ContextThresholds } from "./usage/context.js";
import { CONTEXT_CHANNEL, LIMITS_CHANNEL, USAGE_CHANNEL } from "./usage/channels.js";
import type { Limit, TurnDetail } from "./usage/contract.js";
import { fillBars, windowFor, type Bar, type RangeId } from "./usage/series.js";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The window's usage, re-read whenever the server records more. */
function useUsage(range: RangeId) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const span = windowFor(range, new Date());
    rpc.call("usage_window", { since: span.since }).then(
      (result) => {
        setData({
          since: span.since,
          bars: fillBars(span.bars, result.hours),
          unit: span.unit,
          threads: result.threads,
          recordingSince: result.recordingSince,
          contextThresholds: result.contextThresholds,
          turnTime: result.turnTime,
        });
        setError(null);
      },
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc, range]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  // The newest bar keeps filling while a thread runs, and the window slides
  // forward every hour, so re-read on new usage and once a minute.
  useRealtime(USAGE_CHANNEL, load);
  useEffect(() => {
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return { data, error };
}

/** The subscriptions' usage limits, re-read after each reading the server stores and each turn's usage. */
function useLimits(): Limit[] {
  const rpc = useRpc<typeof rpcContract>();
  const [limits, setLimits] = useState<Limit[]>([]);
  const load = useCallback(() => {
    rpc.call("usage_limits", null).then((result) => setLimits(result.limits), () => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(LIMITS_CHANNEL, load);
  // The past hour's tokens and the session's spark change with each turn.
  useRealtime(USAGE_CHANNEL, load);
  return limits;
}

/** What 1% of each limit is worth, over everything recorded; re-read after each limit reading and turn. */
function useValue(): ValueData | null {
  const rpc = useRpc<typeof rpcContract>();
  const [value, setValue] = useState<ValueData | null>(null);
  const load = useCallback(() => {
    rpc.call("value_report", { since: 0 }).then(setValue, () => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(LIMITS_CHANNEL, load);
  return value;
}

function useProviderName() {
  const providers = experimental_useProviders();
  return (providerId: string) =>
    providers.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;
}

function ValuePage() {
  const [range, setRange] = useState<RangeId>("day");
  const { data, error } = useUsage(range);
  const limits = useLimits();
  const value = useValue();
  const providerName = useProviderName();
  const navigate = useSandyNavigate();
  return (
    <UsageView
      value={value}
      range={range}
      onRange={setRange}
      data={data}
      error={error}
      onOpenThread={(threadId) => navigate.toThread(threadId)}
      limits={limits}
      providerName={providerName}
    />
  );
}

const plural = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;

/**
 * Beside Value in the sidebar: a count of the active threads whose context is
 * past the warning (amber) or past the limit (red, when any is). Re-read when a
 * context size or an archive is recorded, and once a minute for a changed setting.
 */
function useContextLevelsBadge(): ExperimentalBadge | null {
  const rpc = useRpc<typeof rpcContract>();
  const [levels, setLevels] = useState<{ warning: number; error: number } | null>(null);
  const load = useCallback(() => {
    rpc.call("context_levels", null).then(setLevels, () => undefined);
  }, [rpc]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime(CONTEXT_CHANNEL, load);
  useRealtime(USAGE_CHANNEL, load);
  if (levels === null || levels.warning + levels.error === 0) return null;
  return {
    count: levels.warning + levels.error,
    tone: levels.error > 0 ? "critical" : "warning",
    label: levels.error > 0
      ? `${plural(levels.error)} past the context limit, ${plural(levels.warning)} past the warning`
      : `${plural(levels.warning)} past the context warning`,
  };
}

function isForThread(payload: unknown, threadId: string): boolean {
  const ids = (payload as { threadIds?: unknown } | null)?.threadIds;
  return Array.isArray(ids) && ids.includes(threadId);
}

function ThreadTokensAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useSandyNavigate();
  const [usage, setUsage] = useState<ThreadTokens | null>(null);
  // Loaded when the summary first opens, because it reads sandy's turn events.
  const [turns, setTurns] = useState<TurnDetail[] | null>(null);
  const [wantsTurns, setWantsTurns] = useState(false);

  const load = useCallback(() => {
    rpc.call("thread_usage", { threadId }).then(setUsage, () => undefined);
  }, [rpc, threadId]);
  const loadTurns = useCallback(() => {
    rpc.call("thread_turns", { threadId }).then(({ turns: loaded }) => setTurns(loaded), () => undefined);
  }, [rpc, threadId]);

  useEffect(() => {
    setUsage(null);
    setTurns(null);
    setWantsTurns(false);
    load();
  }, [load]);
  useEffect(() => {
    if (wantsTurns) loadTurns();
  }, [wantsTurns, loadTurns]);
  const onChange = useMemo(
    () => (payload: unknown) => {
      if (!isForThread(payload, threadId)) return;
      load();
      if (wantsTurns) loadTurns();
    },
    [load, loadTurns, threadId, wantsTurns],
  );
  useRealtime(USAGE_CHANNEL, onChange);

  if (usage === null || usage.total === 0) return null;
  return (
    <ThreadTokenCount
      usage={usage}
      turns={turns}
      onOpen={() => setWantsTurns(true)}
      isCompactViewport={isCompactViewport}
      onOpenPage={() => navigate.toPluginPanel("value")}
    />
  );
}

interface ContextState {
  context: { usedTokens: number; contextWindow: number | null; at: number } | null;
  lastTurn: number | null;
  thresholds: ContextThresholds;
  archived: boolean;
}

/** The meter above the composer, drawn only once the thread's context passes the setting. */
function ContextMeterBanner() {
  const view = useComposer();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ContextState | null>(null);
  // When Compact was pressed; cleared once a newer context size arrives.
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(threadId);
  current.current = threadId;

  const load = useCallback(() => {
    if (threadId === null) return;
    rpc.call("thread_context", { threadId }).then(
      (next: ContextState) => {
        if (current.current === threadId) setState(next);
      },
      () => undefined,
    );
  }, [rpc, threadId]);

  useEffect(() => {
    setState(null);
    setRequestedAt(null);
    setError(null);
    load();
  }, [load]);
  const onChange = useMemo(
    () => (payload: unknown) => {
      if (threadId !== null && isForThread(payload, threadId)) load();
    },
    [load, threadId],
  );
  useRealtime(CONTEXT_CHANNEL, onChange);
  useRealtime(USAGE_CHANNEL, onChange);

  useEffect(() => {
    if (requestedAt !== null && state?.context != null && state.context.at > requestedAt) setRequestedAt(null);
  }, [requestedAt, state]);

  if (threadId === null || state === null || state.archived) return null;
  if (state.context === null) return null;
  const level = contextLevel(state.context.usedTokens, state.thresholds);
  if (level === null) return null;

  const onCompact = () => {
    setError(null);
    setRequestedAt(Date.now());
    rpc.call("compact_thread", { threadId }).catch((cause: unknown) => {
      setRequestedAt(null);
      setError(messageOf(cause));
    });
  };

  return (
    <ContextMeter
      usedTokens={state.context.usedTokens}
      contextWindow={state.context.contextWindow}
      thresholds={state.thresholds}
      level={level}
      lastTurn={state.lastTurn}
      running={view.isRunning}
      compacting={requestedAt !== null}
      error={error}
      compact={view.layout === "compact"}
      onCompact={onCompact}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "value",
    title: "Value",
    // The plugin's own coin stack, declared under sandy.branding.experimental_icons.
    icon: "value/coins",
    path: "value",
    component: ValuePage,
    experimental_useBadge: useContextLevelsBadge,
  });

  app.slots.experimental_threadHeaderAction({
    id: "thread-tokens",
    title: "Tokens used",
    component: ThreadTokensAction,
  });

  app.composer.customize({
    id: "context-meter",
    scopes: ["thread"],
    // Bare: the meter draws its own card, and a thread under the setting
    // draws nothing at all.
    banners: [{ id: "context-meter", chrome: "bare", component: ContextMeterBanner }],
  });
});
