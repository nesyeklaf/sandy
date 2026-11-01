import { useEffect, useState } from "react";
import { experimental_useRpcQuery as useRpcQuery } from "@sandy-sdk/plugin-sdk/app";
import {
  OVERVIEW_WINDOWS,
  connectionOverviewContract,
  type Overview,
  type OverviewRow,
} from "../src/contract.js";
import {
  describeCoverage,
  staleAt,
  formatAge,
  formatDuration,
  type BannerTone,
} from "./coverage.js";

type StateName = OverviewRow["state"];
type Window = (typeof OVERVIEW_WINDOWS)[number];

const STATE_LABEL: Record<StateName, string> = {
  allowed: "allowed",
  inferred: "inferred",
  yellow: "yellow",
  red: "red",
  unverifiable: "unverifiable",
  undetermined: "undetermined",
  "third-party": "third-party",
};

const STATE_CLASS: Record<StateName, string> = {
  allowed: "text-success",
  inferred: "text-muted-foreground",
  yellow: "text-warning-text",
  red: "text-destructive-text",
  unverifiable: "text-muted-foreground",
  undetermined: "text-warning-text",
  "third-party": "text-muted-foreground",
};

const BANNER_CLASS: Record<BannerTone, string> = {
  alert: "border-destructive/30 bg-destructive/5",
  warning: "border-warning/40 bg-warning/5",
  measured: "border-border bg-card",
};

function StateBadge({ state }: { state: StateName }) {
  return (
    <span className={`text-xs font-medium ${STATE_CLASS[state]}`}>
      {STATE_LABEL[state]}
    </span>
  );
}

function Banner({
  overview,
  refreshFailed,
}: {
  overview: Overview | undefined;
  refreshFailed: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (overview === undefined) return;
    const wait = staleAt(overview) - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [overview]);
  const summary = describeCoverage(overview, refreshFailed, now);
  return (
    <section
      role="status"
      aria-label="Measurement coverage"
      className={`rounded-lg border p-4 ${BANNER_CLASS[summary.tone]}`}
    >
      <p className="text-sm font-medium text-foreground">{summary.headline}</p>
      {summary.details.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {summary.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {overview ? <Sources overview={overview} /> : null}
      {overview ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Not measured: {overview.notMeasured.join("; ")}.
        </p>
      ) : null}
    </section>
  );
}

function Sources({ overview }: { overview: Overview }) {
  const longGaps = overview.gaps.map((gap) => gap.end - gap.start);
  return (
    <div className="mt-3 space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs" aria-label="Sources">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">Host</th>
              <th className="py-1 pr-3 font-normal">Collector clock</th>
              <th className="py-1 pr-3 font-normal">Transport clock</th>
              <th className="py-1 pr-3 font-normal">Processes</th>
              <th className="py-1 font-normal">Unreadable pids</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {overview.sources.map((source) => (
              <tr key={source.sourceId}>
                <th scope="row" className="py-1 pr-3 text-left font-medium">
                  {source.label}
                  {source.supported ? null : (
                    <span className="ml-2 font-normal text-warning-text">
                      not measured on this platform
                    </span>
                  )}
                </th>
                <td
                  className={`py-1 pr-3 ${source.collector === "fresh" ? "text-muted-foreground" : "text-warning-text"}`}
                >
                  {source.collector}
                </td>
                <td
                  className={`py-1 pr-3 ${source.transport === "fresh" ? "text-muted-foreground" : "text-warning-text"}`}
                >
                  {source.transport}
                </td>
                <td className="py-1 pr-3 tabular-nums">{source.treeSize}</td>
                <td className="py-1 tabular-nums">{source.unreadablePids}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {overview.gaps.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {overview.gaps.length} sampling gap
          {overview.gaps.length === 1 ? "" : "s"} in this window (short ones are
          normal), longest {formatDuration(Math.max(...longGaps))}.
        </p>
      ) : null}
    </div>
  );
}

function RowsTable({
  title,
  rows,
  now,
}: {
  title: string;
  rows: readonly OverviewRow[];
  now: number;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">
        {title} <span className="text-muted-foreground">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No rows for this window and filter.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs" aria-label={title}>
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">State</th>
                <th className="px-3 py-2 font-normal">Destination</th>
                <th className="px-3 py-2 font-normal">Port</th>
                <th className="px-3 py-2 font-normal">Process</th>
                <th className="px-3 py-2 font-normal">Source</th>
                <th className="px-3 py-2 text-right font-normal">Count</th>
                <th className="px-3 py-2 font-normal">Last seen</th>
                <th className="px-3 py-2 font-normal">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <StateBadge state={row.state} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.hostname ?? row.ip}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {row.proto}/{row.port}
                  </td>
                  <td className="px-3 py-2">
                    {[
                      ...new Set(row.attributions.map((entry) => entry.comm)),
                    ].join(", ")}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.sourceId}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.count}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {formatAge(now - row.lastSeen)}
                  </td>
                  <td className="min-w-64 px-3 py-2 text-muted-foreground">
                    {row.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function OverviewPage() {
  const [range, setRange] = useState<Window>("24h");
  const [filter, setFilter] = useState<StateName | "all">("all");
  const query = useRpcQuery({
    contract: connectionOverviewContract,
    method: "overview.get",
    input: { window: range },
  });
  const overview = query.data;
  const visible = (overview?.rows ?? []).filter(
    (row) => filter === "all" || row.state === filter,
  );
  const states = (Object.keys(STATE_LABEL) as StateName[]).filter(
    (state) => (overview?.counts[state] ?? 0) > 0,
  );
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold text-foreground">
            Connection overview
          </h1>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Window
            <select
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
              value={range}
              onChange={(event) => setRange(event.target.value as Window)}
            >
              {OVERVIEW_WINDOWS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>
        {query.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <Banner
            overview={overview}
            refreshFailed={overview !== undefined && query.error !== null}
          />
        )}
        {query.error !== null && overview === undefined ? (
          <p role="alert" className="text-xs text-destructive-text">
            {query.error.message}
          </p>
        ) : null}
        {overview ? (
          <>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Filter by state"
            >
              {(["all", ...states] as const).map((state) => (
                <button
                  key={state}
                  type="button"
                  aria-pressed={filter === state}
                  className={`rounded-md border px-2 py-1 text-xs ${filter === state ? "border-foreground/40 bg-muted/50 text-foreground" : "border-border text-muted-foreground"}`}
                  onClick={() => setFilter(state)}
                >
                  {state === "all"
                    ? `all (${overview.totalRows})`
                    : `${state} (${overview.counts[state] ?? 0})`}
                </button>
              ))}
            </div>
            {overview.totalRows > overview.rows.length ? (
              <p className="text-xs text-muted-foreground">
                Showing the {overview.rows.length} most urgent of{" "}
                {overview.totalRows} rows; use sandy connections list for all.
              </p>
            ) : null}
            <RowsTable
              title="Outgoing"
              rows={visible.filter((row) => row.direction !== "in")}
              now={overview.now}
            />
            <RowsTable
              title="Incoming"
              rows={visible.filter((row) => row.direction === "in")}
              now={overview.now}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
