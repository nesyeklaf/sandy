// The Value dashboard's panels: one tile per account on the overview, the
// per-window detail, and the hosts. Display only; app.tsx loads the report.
import { cn } from "@/lib/utils";
import type { Limit, ValueSeriesView } from "@/usage/contract";
import {
  KIND_LABEL,
  accountsOf,
  currentWindow,
  hostShares,
  seriesOf,
  usd,
  type AccountRef,
} from "@/usage/value-view";
import { LEAST_PERCENT_POINTS } from "@/usage/value";

import { LimitMeters } from "./limit-meters";

export interface ValueData {
  series: readonly ValueSeriesView[];
  unpricedModels: ReadonlyArray<{ model: string; turns: number }>;
  invalidPrices: readonly string[];
}

type ProviderName = (providerId: string) => string;

const day = (time: number) => new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
const clock = (time: number) =>
  new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const isAccount = (limit: { providerId: string; accountKey: string | null }, account: AccountRef) =>
  limit.providerId === account.providerId && limit.accountKey === account.accountKey;

/** The provider's name, with the account key when one provider has several accounts. */
function accountName(account: AccountRef, accounts: readonly AccountRef[], providerName: ProviderName): string {
  const several = accounts.filter((other) => other.providerId === account.providerId).length > 1;
  return several && account.accountKey !== null ? `${providerName(account.providerId)} (${account.accountKey})` : providerName(account.providerId);
}

/** The headline value of one series: "$12.40" or "–" while too few points. */
function worth(entry: ValueSeriesView | undefined): string {
  return entry === undefined || entry.total.usdPerPercent === null ? "–" : usd(entry.total.usdPerPercent);
}

/** Why a series has no headline yet. */
function whyNoHeadline(entry: ValueSeriesView | undefined): string {
  if (entry === undefined) return "No limit reading with turns in between yet.";
  return `Only ${entry.total.percent} percentage points so far; a reading's rounding swings it until there are ${LEAST_PERCENT_POINTS}.`;
}

/** Each window's value as a bar, oldest left, the newest highlighted. */
function WindowBars({ entry }: { entry: ValueSeriesView }) {
  const windows = entry.windows.slice(-12);
  const values = windows.map((window) => window.summary.usdPerPercent);
  const top = Math.max(...values.map((value) => value ?? 0), 0);
  if (windows.length < 2 || top === 0) return null;
  return (
    <div className="mt-3">
      <div className="flex h-12 items-end gap-1" role="img" aria-label={`Value per 1% in the last ${windows.length} windows`}>
        {windows.map((window, index) => {
          const value = values[index] ?? null;
          return (
            <div
              key={window.resetsAt}
              title={`${day(window.resetsAt)}: ${value === null ? "too few points" : usd(value)}`}
              className={cn("min-w-1 flex-1 rounded-sm", index === windows.length - 1 ? "bg-foreground/70" : "bg-foreground/25")}
              style={{ height: `${value === null ? 2 : Math.max(4, (value / top) * 100)}%` }}
            />
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">Per window, up to {usd(top)}</p>
    </div>
  );
}

function AccountTile({
  account,
  name,
  data,
  limits,
  providerName,
  now,
}: {
  account: AccountRef;
  name: string;
  data: ValueData | null;
  limits: readonly Limit[];
  providerName: ProviderName;
  now: number;
}) {
  const own = seriesOf(data?.series ?? [], account);
  const weekly = own.find((entry) => entry.kind === "weekly");
  const session = own.find((entry) => entry.kind === "five-hour");
  const current = weekly === undefined ? null : currentWindow(weekly, now);
  return (
    <section className="min-w-0 flex-1 basis-80 rounded-lg border border-border bg-card p-3" aria-label={name}>
      <h2 className="text-sm font-medium">{name}</h2>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {worth(weekly)}
        <span className="ml-1.5 text-sm font-normal text-muted-foreground">per 1% weekly</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {weekly === undefined || weekly.total.usdPerPercent === null
          ? whyNoHeadline(weekly)
          : `${usd(weekly.total.costUsd)} over ${weekly.total.percent} percentage points${
              current === null ? "" : ` · this week ${usd(current.summary.costUsd)} for ${current.summary.percent} points`
            }`}
      </p>
      {session === undefined ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          5-hour: <span className="tabular-nums text-foreground">{worth(session)}</span> per 1%
        </p>
      )}
      {weekly === undefined ? null : <WindowBars entry={weekly} />}
      <LimitMeters limits={limits.filter((limit) => isAccount(limit, account))} providerName={providerName} className="mt-4" />
    </section>
  );
}

/** Overview: both accounts side by side, each with its weekly value, the 5-hour value and its limits. */
export function ValueOverview({
  data,
  limits,
  providerName,
  now,
}: {
  data: ValueData | null;
  limits: readonly Limit[];
  providerName: ProviderName;
  now: number;
}) {
  const accounts = accountsOf(data?.series ?? [], limits);
  if (accounts.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
        {data === null ? "Loading…" : "No limit reading yet. Each reading is taken every five minutes; check back after a bit of work."}
      </p>
    );
  }
  return (
    <div className="mt-4 flex flex-wrap gap-3">
      {accounts.map((account) => (
        <AccountTile
          key={`${account.providerId}:${account.accountKey ?? ""}`}
          account={account}
          name={accountName(account, accounts, providerName)}
          data={data}
          limits={limits}
          providerName={providerName}
          now={now}
        />
      ))}
      <Notes data={data} />
    </div>
  );
}

function Notes({ data }: { data: ValueData | null }) {
  if (data === null) return null;
  return (
    <div className="w-full space-y-1">
      {data.unpricedModels.length === 0 ? null : (
        <p className="text-xs text-amber-600">
          No price for {data.unpricedModels.map((entry) => `${entry.model} (${entry.turns})`).join(", ")}. Add one in the plugin's settings.
        </p>
      )}
      {data.invalidPrices.length === 0 ? null : (
        <p className="text-xs text-destructive">Could not read price lines: {data.invalidPrices.join("; ")}</p>
      )}
    </div>
  );
}

function SeriesDetail({ entry }: { entry: ValueSeriesView }) {
  const { total } = entry;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-sm">
        <span className="font-medium">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
        <span className="ml-2 text-lg font-semibold tabular-nums">{worth(entry)}</span>
        <span className="ml-1 text-xs text-muted-foreground">per 1%</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {total.usdPerPercent === null
          ? whyNoHeadline(entry)
          : `${usd(total.costUsd)} list price over ${total.percent} percentage points · ${total.steps} steps`}
        {total.skipped === 0 ? "" : ` · ${total.skipped} left out for turns without a price`}
      </p>
      {entry.windows.length < 2 ? null : (
        <table className="mt-2 w-full text-xs tabular-nums">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="font-normal">Window ending</th>
              <th className="text-right font-normal">Per 1%</th>
              <th className="text-right font-normal">Points</th>
              <th className="text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {[...entry.windows].reverse().map((window) => (
              <tr key={window.resetsAt}>
                <td>{day(window.resetsAt)}</td>
                <td className="text-right">{window.summary.usdPerPercent === null ? "–" : usd(window.summary.usdPerPercent)}</td>
                <td className="text-right">{window.summary.percent}</td>
                <td className="text-right">{usd(window.summary.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Every step ({entry.steps.length})</summary>
        <ul className="mt-1 space-y-0.5 tabular-nums">
          {[...entry.steps].reverse().map((step) => (
            <li key={step.to} className="flex justify-between gap-2">
              <span>
                {clock(step.to)} · {step.fromPercent}% → {step.toPercent}%
              </span>
              <span className={step.unpricedTurns > 0 ? "text-muted-foreground" : ""}>
                {step.unpricedTurns > 0 ? "no price" : `${usd(step.costUsd / step.percent)} per 1%`}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Value per 1%: every account, weekly then 5-hour, each with its windows and steps. */
export function ValueDetail({ data, providerName }: { data: ValueData | null; providerName: ProviderName }) {
  const accounts = accountsOf(data?.series ?? [], []);
  if (accounts.length === 0) {
    return <p className="mt-4 text-xs text-muted-foreground">{data === null ? "Loading…" : "Nothing to value yet."}</p>;
  }
  return (
    <div className="mt-4 space-y-3">
      {accounts.map((account) => (
        <section key={`${account.providerId}:${account.accountKey ?? ""}`} className="rounded-lg border border-border bg-card p-3">
          <h2 className="text-sm font-medium">{accountName(account, accounts, providerName)}</h2>
          {seriesOf(data?.series ?? [], account).map((entry) => (
            <SeriesDetail key={entry.kind} entry={entry} />
          ))}
        </section>
      ))}
      <Notes data={data} />
    </div>
  );
}

/** Hosts: what each machine's turns cost, per account, from the weekly series. */
export function ValueHosts({ data, providerName }: { data: ValueData | null; providerName: ProviderName }) {
  const accounts = accountsOf(data?.series ?? [], []);
  const columns = accounts.map((account) => {
    const own = seriesOf(data?.series ?? [], account);
    return { name: accountName(account, accounts, providerName), cost: (own.find((entry) => entry.kind === "weekly") ?? own[0])?.total.hostCost ?? {} };
  });
  const hostIds = [...new Set(columns.flatMap((column) => Object.keys(column.cost)))];
  if (hostIds.length === 0) {
    return <p className="mt-4 text-xs text-muted-foreground">{data === null ? "Loading…" : "No priced turns by host yet."}</p>;
  }
  const rows = hostIds
    .map((hostId) => ({ hostId, costs: columns.map((column) => column.cost[hostId] ?? 0) }))
    .map((row) => ({ ...row, total: row.costs.reduce((sum, cost) => sum + cost, 0) }))
    .sort((a, b) => b.total - a.total);
  const all = rows.reduce((sum, row) => sum + row.total, 0);
  const shares = new Map(hostShares(Object.fromEntries(rows.map((row) => [row.hostId, row.total]))).map((entry) => [entry.hostId, entry.share]));
  return (
    <section className="mt-4 rounded-lg border border-border bg-card p-3">
      <table className="w-full text-xs tabular-nums">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="font-normal">Host</th>
            {columns.map((column) => (
              <th key={column.name} className="text-right font-normal">{column.name}</th>
            ))}
            <th className="text-right font-normal">Total</th>
            <th className="text-right font-normal">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.hostId}>
              <td>{row.hostId === "" ? "unknown" : row.hostId}</td>
              {row.costs.map((cost, index) => (
                <td key={columns[index]!.name} className="text-right">{usd(cost)}</td>
              ))}
              <td className="text-right">{usd(row.total)}</td>
              <td className="text-right">{all === 0 ? "–" : `${Math.round((shares.get(row.hostId === "" ? "unknown" : row.hostId) ?? 0) * 100)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted-foreground">List price of the turns behind each account's weekly value.</p>
    </section>
  );
}
