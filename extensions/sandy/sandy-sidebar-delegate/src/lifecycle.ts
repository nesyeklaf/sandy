import type { PluginSidebarThread, PluginSidebarThreadActivity } from "@sandy-sdk/plugin-sdk";
import { threadAsksForInput } from "./child-status";

export interface ThreadLifecycleRow {
  threadId: string;
  parkedAt?: number | null;
  settledAt: number | null;
  settledOverride?: "active" | "settled" | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
  deferredInteractionId?: string | null;
}

export interface ThreadActivitySignals {
  hasPendingInteraction: boolean;
  hasQueuedWork: boolean;
  isWorking: boolean;
  hasUnblockedWork: boolean;
  isUnread: boolean;
  latestAttentionAt: number;
}

export type ThreadShelf = "active" | "parked" | "snoozed" | "settled";
type WakeReason = "timer" | "attention";

function defersQuestion(row: ThreadLifecycleRow): boolean {
  return row.snoozedUntil !== null && row.deferredInteractionId != null;
}

export function resolveWakeReason(
  row: ThreadLifecycleRow | undefined,
  signals: ThreadActivitySignals,
  now: number,
): WakeReason | null {
  if (row?.snoozedUntil === null || row?.snoozedUntil === undefined) {
    return null;
  }

  const wokeOnAttention =
    (signals.hasPendingInteraction && !defersQuestion(row)) ||
    (row.snoozedAt !== null && signals.latestAttentionAt > row.snoozedAt);
  if (wokeOnAttention) return "attention";
  return row.snoozedUntil <= now ? "timer" : null;
}

export function canPark(
  signals: Pick<ThreadActivitySignals, "hasPendingInteraction" | "hasQueuedWork" | "isWorking">,
): boolean {
  return !signals.hasPendingInteraction && !signals.hasQueuedWork && !signals.isWorking;
}

export function isTurnInFlight(status: PluginSidebarThread["status"]): boolean {
  return status === "active" || status === "pending" || status === "starting" || status === "stopping";
}

export function hasBackgroundWork(activity: PluginSidebarThreadActivity): boolean {
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0
  );
}

export function hasLiveWork(activity: PluginSidebarThreadActivity, turnInFlight: boolean): boolean {
  return turnInFlight || hasBackgroundWork(activity);
}

export function isThreadWorking(thread: PluginSidebarThread): boolean {
  return hasLiveWork(thread.activity, isTurnInFlight(thread.status) || thread.indicator === "runtime");
}

export function threadHasUnblockedWork(thread: PluginSidebarThread): boolean {
  return threadAsksForInput(thread) ? hasBackgroundWork(thread.activity) : isThreadWorking(thread);
}

export function sidebarThreadSignals(thread: PluginSidebarThread): ThreadActivitySignals {
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    hasQueuedWork: thread.queuedWork !== "none",
    isWorking: isThreadWorking(thread),
    hasUnblockedWork: threadHasUnblockedWork(thread),
    isUnread: thread.isUnread,
    latestAttentionAt: thread.latestAttentionAt,
  };
}

export function canParkThread(thread: PluginSidebarThread): boolean {
  return canPark(sidebarThreadSignals(thread));
}

export function resolveShelf(
  row: ThreadLifecycleRow | undefined,
  signals: ThreadActivitySignals,
  now: number,
): ThreadShelf {
  if (row === undefined) return "active";
  const waitsOnDeferredQuestion = defersQuestion(row) && signals.hasPendingInteraction;
  const parkSignals = waitsOnDeferredQuestion
    ? { ...signals, hasPendingInteraction: false, isWorking: signals.hasUnblockedWork }
    : signals;
  if (!canPark(parkSignals)) return "active";

  if (row.parkedAt != null) {
    return signals.latestAttentionAt > row.parkedAt ? "active" : "parked";
  }

  if (row.snoozedUntil !== null) {
    if (resolveWakeReason(row, signals, now) === null) return "snoozed";
    return "active";
  }

  if (row.settledAt !== null) {
    if (signals.latestAttentionAt > row.settledAt) return "active";
    return "settled";
  }

  return "active";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export const DEFAULT_SNOOZE_PRESET_CONFIG =
  "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00";

type CalendarSnoozeDay = "evening" | "tomorrow" | "next-week";

export type ConfiguredSnoozePreset = {
  id: string;
  label: string;
} & ({ durationMs: number } | { calendar: CalendarSnoozeDay; hour: number; minute: number });

export function configuredSnoozePresetError(configured: string): string | null {
  const entries = configured
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) return "Enter at least one snooze shortcut.";
  if (entries.length > 8) return "Use no more than eight snooze shortcuts.";
  if (parseSnoozePresetEntries(configured).length !== entries.length) {
    return "Use comma-separated durations or calendar times, such as 1h, Wait refresh=5h, evening@18:00, tomorrow@09:00, or next-week@09:00.";
  }
  return null;
}

const DURATION_UNIT_MS = {
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
} as const;

const DURATION_UNIT_LABEL = {
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
} as const;

function parseSnoozePresetEntries(source: string): ConfiguredSnoozePreset[] {
  return source
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8)
    .flatMap<ConfiguredSnoozePreset>((part, index) => {
      const separator = part.indexOf("=");
      const customLabel = separator >= 0 ? part.slice(0, separator).trim() : "";
      const value = (separator >= 0 ? part.slice(separator + 1) : part).trim().toLowerCase();
      const calendar = /^(evening|tomorrow|next-week)(?:@(\d{1,2}):(\d{2}))?$/.exec(value);
      if (calendar) {
        const day = calendar[1] as CalendarSnoozeDay;
        const defaultHour = day === "evening" ? 18 : 9;
        const hour = Number(calendar[2] ?? defaultHour);
        const minute = Number(calendar[3] ?? 0);
        if (hour > 23 || minute > 59) return [];
        const labels: Record<CalendarSnoozeDay, string> = {
          evening: "This evening",
          tomorrow: "Tomorrow morning",
          "next-week": "Next week",
        };
        return [
          {
            id: `preset-${index}`,
            label: customLabel.slice(0, 40) || labels[day],
            calendar: day,
            hour,
            minute,
          },
        ];
      }
      const match = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(value);
      if (!match) return [];

      const amount = Number(match[1]);
      const unit = match[2] as keyof typeof DURATION_UNIT_MS;
      const durationMs = amount * DURATION_UNIT_MS[unit];
      if (!Number.isFinite(durationMs) || durationMs < MINUTE_MS || durationMs > 365 * DAY_MS) {
        return [];
      }

      const displayedAmount = Number.isInteger(amount) ? String(amount) : String(Number(amount.toFixed(2)));
      const generatedLabel = `${displayedAmount} ${DURATION_UNIT_LABEL[unit]}${amount === 1 ? "" : "s"}`;
      return [
        {
          id: `preset-${index}`,
          label: customLabel.slice(0, 40) || generatedLabel,
          durationMs,
        },
      ];
    });
}

export function parseConfiguredSnoozePresets(configured: string): ConfiguredSnoozePreset[] {
  const parsed = parseSnoozePresetEntries(configured);
  return parsed.length > 0 ? parsed : parseSnoozePresetEntries(DEFAULT_SNOOZE_PRESET_CONFIG);
}

export function snoozeWakeLabel(snoozedUntil: number, now: number): string {
  const remaining = snoozedUntil - now;
  if (remaining <= 0) return "now";
  if (remaining < HOUR_MS) {
    return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  }
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function cachedDateTimeFormat(
  kind: string,
  locale: string | undefined,
  timeZone: string | undefined,
  at: Date,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${kind}|${locale ?? ""}|${timeZone ?? `local${at.getTimezoneOffset()}`}`;
  let formatter = dateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, ...(timeZone ? { timeZone } : {}) });
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatSnoozeWakeTime(snoozedUntil: number, locale?: string, timeZone?: string): string {
  return cachedDateTimeFormat("wake", locale, timeZone, new Date(snoozedUntil), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(snoozedUntil));
}

export function resolveConfiguredSnoozePreset(preset: ConfiguredSnoozePreset, now = new Date()): number | null {
  if ("durationMs" in preset) return now.getTime() + preset.durationMs;

  const addDays =
    preset.calendar === "next-week" ? (1 - now.getDay() + 7) % 7 || 7 : preset.calendar === "tomorrow" ? 1 : 0;
  const wake = new Date(now);
  wake.setDate(wake.getDate() + addDays);
  wake.setHours(preset.hour, preset.minute, 0, 0);
  return wake.getTime() > now.getTime() ? wake.getTime() : null;
}

export const MAX_TIMEOUT_MS = 2_147_483_647;

export function nextWakeDelayMs(snoozedUntilValues: readonly number[], now: number): number | null {
  const upcoming = snoozedUntilValues.filter((value) => value > now);
  if (upcoming.length === 0) return null;
  const soonest = Math.min(...upcoming);
  return Math.min(Math.max(0, soonest - now) + 50, MAX_TIMEOUT_MS);
}

export const MAX_SNOOZE_MS = 365 * DAY_MS;

export function defaultPickedSnooze(now = new Date()): { date: Date; time: string } {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return { date, time: "09:00" };
}

export function combineSnoozeDateTime(date: Date, time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const wake = new Date(date);
  wake.setHours(hour, minute, 0, 0);
  return wake.getTime();
}

export function formatPickedSnooze(snoozedUntil: number, now = new Date(), locale?: string, timeZone?: string): string {
  const wake = new Date(snoozedUntil);
  const withYear = wake.getFullYear() !== now.getFullYear();
  return cachedDateTimeFormat(withYear ? "picked-year" : "picked", locale, timeZone, wake, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(wake);
}
