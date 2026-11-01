// What the Value card shows, worked out from the report. Display logic only.
import type { ValueSeriesView } from "./contract.js";

export const KIND_LABEL: Record<string, string> = { weekly: "Weekly", "five-hour": "5-hour" };

/** The kinds the report has for a provider, weekly first. */
export function kindsOf(series: readonly ValueSeriesView[], providerId: string): string[] {
  return series
    .filter((entry) => entry.providerId === providerId)
    .map((entry) => entry.kind)
    .sort((a, b) => (a === "weekly" ? -1 : b === "weekly" ? 1 : a.localeCompare(b)));
}

/** The providers the report has, in report order. */
export function providersOf(series: readonly ValueSeriesView[]): string[] {
  return [...new Set(series.map((entry) => entry.providerId))];
}

/** The series for a provider and kind. When the chosen kind is gone, the provider's first one. */
export function pick(series: readonly ValueSeriesView[], providerId: string, kind: string): ValueSeriesView | null {
  const own = series.filter((entry) => entry.providerId === providerId);
  return own.find((entry) => entry.kind === kind) ?? own[0] ?? null;
}

/** One subscription account the dashboard shows: it has a limit reading or a value. */
export interface AccountRef {
  providerId: string;
  accountKey: string | null;
}

/** Every account that has a value or a limit, in the order the report lists them, then the limits'. */
export function accountsOf(
  series: readonly ValueSeriesView[],
  limits: ReadonlyArray<{ providerId: string; accountKey: string | null }>,
): AccountRef[] {
  const seen = new Set<string>();
  const accounts: AccountRef[] = [];
  for (const entry of [...series, ...limits]) {
    const key = `${entry.providerId}\u0000${entry.accountKey ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ providerId: entry.providerId, accountKey: entry.accountKey });
  }
  return accounts;
}

/** One account's series, weekly first. */
export function seriesOf(series: readonly ValueSeriesView[], account: AccountRef): ValueSeriesView[] {
  return series
    .filter((entry) => entry.providerId === account.providerId && entry.accountKey === account.accountKey)
    .sort((a, b) => (a.kind === "weekly" ? -1 : b.kind === "weekly" ? 1 : a.kind.localeCompare(b.kind)));
}

/** The window that has not reset yet, if the series has one. */
export function currentWindow(entry: ValueSeriesView, now: number): ValueSeriesView["windows"][number] | null {
  return [...entry.windows].reverse().find((window) => window.resetsAt > now) ?? null;
}

/** "$12.40", "$0.83": two decimals, more when tiny. */
export function usd(amount: number): string {
  if (amount >= 100) return `$${Math.round(amount).toLocaleString("en-US")}`;
  return `$${amount.toFixed(amount > 0 && amount < 0.1 ? 3 : 2)}`;
}

/** Each host's share of the dollars, biggest first. A host that was not recorded is "unknown". */
export function hostShares(hostCost: Record<string, number>): Array<{ hostId: string; costUsd: number; share: number }> {
  const total = Object.values(hostCost).reduce((sum, cost) => sum + cost, 0);
  return Object.entries(hostCost)
    .map(([hostId, costUsd]) => ({ hostId: hostId === "" ? "unknown" : hostId, costUsd, share: total === 0 ? 0 : costUsd / total }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** The report as lines for the terminal. */
export function formatValueReport(report: {
  series: readonly ValueSeriesView[];
  unpricedModels: ReadonlyArray<{ model: string; turns: number }>;
  invalidPrices: readonly string[];
}): string {
  if (report.series.length === 0) return "No limit readings with priced turns in between yet.";
  const lines = report.series.map((entry) => {
    const { total } = entry;
    const worth = total.usdPerPercent === null ? "n/a (too few points)" : `${usd(total.usdPerPercent)} per 1%`;
    const hosts = hostShares(total.hostCost).map((host) => `${host.hostId} ${Math.round(host.share * 100)}%`).join(", ");
    return `${entry.providerId}${entry.accountKey === null ? "" : ` (${entry.accountKey})`} ${KIND_LABEL[entry.kind] ?? entry.kind}: ${worth} · ${usd(total.costUsd)} over ${total.percent} points, ${total.steps} steps${hosts === "" ? "" : ` · ${hosts}`}`;
  });
  for (const unpriced of report.unpricedModels) lines.push(`No price for ${unpriced.model} (${unpriced.turns} turns); set it in the prices setting.`);
  for (const bad of report.invalidPrices) lines.push(`Unreadable price line: ${bad}`);
  return lines.join("\n");
}
