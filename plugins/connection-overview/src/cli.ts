import {
  cliCommand,
  defineCli,
  type SandyPluginApi,
  type PluginCliResult,
} from "@sandy-sdk/plugin-sdk";
import type { ConnectionState } from "./classify.js";
import type { SourceHealth } from "./coverage.js";
import { buildStatusReport, isIncoming } from "./report.js";
import { parseSince } from "./since.js";
import type { DestinationRow, Store } from "./store.js";

const SINCE = {
  type: "string",
  description:
    "Window start: a duration (30m, 24h, 7d) or an ISO time; default 24h",
} as const;
const JSON_FLAG = { type: "boolean", description: "Print JSON" } as const;
const RED = { type: "boolean", description: "Only red rows" } as const;

function failure(error: unknown): PluginCliResult {
  return {
    exitCode: 1,
    stderr: (error instanceof Error ? error.message : String(error)) + "\n",
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatRows(rows: readonly DestinationRow[]): string {
  if (rows.length === 0) return "No rows in this window.\n";
  const lines = rows.map((row) => {
    const target = row.hostname ?? row.ip;
    const processes = [
      ...new Set(row.attributions.map((entry) => entry.comm)),
    ].join(",");
    return [
      row.state.toUpperCase().padEnd(12),
      row.direction.padEnd(4),
      `${row.proto}/${row.port}`.padEnd(10),
      target.padEnd(40),
      String(row.count).padStart(6),
      iso(row.lastSeen),
      row.sourceId,
      processes,
      row.reason,
    ].join("  ");
  });
  return lines.join("\n") + "\n";
}

export function registerCli(
  sandy: SandyPluginApi,
  deps: { store: Store; health: () => SourceHealth[]; now?: () => number },
) {
  const now = deps.now ?? Date.now;
  function listCommand(direction: "out" | "in", summary: string) {
    return cliCommand({
      summary,
      options: { since: SINCE, red: RED, json: JSON_FLAG },
      run: (input) => {
        try {
          const since = parseSince(input.options.since, now());
          const states: ConnectionState[] | undefined = input.options.red
            ? ["red"]
            : undefined;
          const rows = deps.store
            .list({ since, ...(states === undefined ? {} : { states }) })
            .filter((row) => isIncoming(row) === (direction === "in"));
          return {
            exitCode: 0,
            stdout: input.options.json
              ? JSON.stringify(rows, null, 2) + "\n"
              : formatRows(rows),
          };
        } catch (error) {
          return failure(error);
        }
      },
    });
  }
  sandy.cli.register(
    defineCli({
      name: "connections",
      summary:
        "Show where sandy connects to and whether the measurement is healthy",
      root: cliCommand({
        summary: "Show connection commands",
        run: (input) => ({ exitCode: 0, stdout: input.help }),
      }),
      commands: {
        list: listCommand("out", "List outgoing destinations in a window"),
        incoming: listCommand("in", "List incoming peers in a window"),
        status: cliCommand({
          summary:
            "Exit 0 when coverage is healthy and nothing is red, 1 when coverage is unhealthy, 2 when red rows exist",
          options: { since: SINCE, json: JSON_FLAG },
          run: (input) => {
            try {
              const since = parseSince(input.options.since, now());
              const report = buildStatusReport(
                {
                  rows: deps.store.list({ since }),
                  sources: deps.health(),
                  gaps: deps.store.gaps(since),
                  capReached: deps.store.capReached(),
                },
                since,
              );
              const json = {
                exitCode: report.exitCode,
                since: iso(since),
                problems: report.problems,
                counts: report.counts,
                sources: report.sources,
                gaps: report.gaps,
                notMeasured: report.notMeasured,
              };
              const text = [
                `Window since ${json.since}: exit ${report.exitCode}`,
                ...report.problems.map((problem) => `  problem: ${problem}`),
                `  rows: ${
                  Object.entries(report.counts)
                    .map(([state, count]) => `${state} ${count}`)
                    .join(", ") || "none"
                }`,
                ...report.sources.map(
                  (source) =>
                    `  source ${source.label}: collector ${source.collector}, transport ${source.transport}, ${source.treeSize} processes, ${source.unreadablePids} unreadable${source.error === null ? "" : ", error " + source.error}`,
                ),
                `  not measured: ${report.notMeasured.join("; ")}`,
              ].join("\n");
              return {
                exitCode: report.exitCode,
                stdout: input.options.json
                  ? JSON.stringify(json, null, 2) + "\n"
                  : text + "\n",
              };
            } catch (error) {
              return failure(error);
            }
          },
        }),
      },
    }),
  );
}
