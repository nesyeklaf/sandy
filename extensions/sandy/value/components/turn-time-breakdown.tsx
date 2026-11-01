// The page's "Where turn time goes" section: the period's turn time by kind,
// with the slowest shell commands under Shell commands, beside the same time
// grouped by turn length. Display only.
import type { TurnTimeBreakdown as Breakdown } from "@/usage/contract";
import { LENGTH_EDGES } from "@/usage/timing";

import { formatSpan, TIME_PARTS } from "./thread-token-count";

type PartKey = (typeof TIME_PARTS)[number]["key"];
type Split = Breakdown["split"];

const colorOf = (key: PartKey) => TIME_PARTS.find((part) => part.key === key)!.color;
const totalOf = (split: Split) => split.model + split.tools + split.waiting;

/** What sandy calls each kind of tool, and the word for one of it. */
const KINDS: Record<string, { label: string; one: string; many: string }> = {
  commandExecution: { label: "Shell commands", one: "run", many: "runs" },
  toolCall: { label: "Tool calls", one: "call", many: "calls" },
  mcpToolCall: { label: "MCP tool calls", one: "call", many: "calls" },
  fileRead: { label: "File reads", one: "read", many: "reads" },
  fileChange: { label: "File edits", one: "edit", many: "edits" },
  delegation: { label: "Subagents", one: "subagent", many: "subagents" },
  webFetch: { label: "Web fetches", one: "fetch", many: "fetches" },
  webSearch: { label: "Web searches", one: "search", many: "searches" },
};

/** Tool kinds under this share of the period's time are folded into Other tools. */
const MIN_SHARE = 0.01;

interface Row {
  key: string;
  label: string;
  part: PartKey;
  ms: number;
  title: string;
}

const counted = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

function rowsOf(breakdown: Breakdown): Row[] {
  const all = totalOf(breakdown.split);
  const rows: Row[] = [
    { key: "model", label: "Model", part: "model", ms: breakdown.split.model, title: "Thinking and writing" },
    {
      key: "waiting",
      label: "Waiting on you",
      part: "waiting",
      ms: breakdown.split.waiting,
      title: counted(breakdown.questions, "question", "questions"),
    },
  ];
  let other = { ms: 0, count: 0 };
  for (const kind of breakdown.kinds) {
    const known = KINDS[kind.kind];
    if (known === undefined || kind.ms < all * MIN_SHARE) {
      other = { ms: other.ms + kind.ms, count: other.count + kind.count };
      continue;
    }
    rows.push({ key: kind.kind, label: known.label, part: "tools", ms: kind.ms, title: counted(kind.count, known.one, known.many) });
  }
  if (other.ms >= 1_000) {
    rows.push({ key: "other", label: "Other tools", part: "tools", ms: other.ms, title: counted(other.count, "tool", "tools") });
  }
  return rows.filter((row) => row.ms >= 1_000 || row.key === "model").sort((a, b) => b.ms - a.ms);
}

function share(part: number, all: number): string {
  const percent = (part / Math.max(1, all)) * 100;
  return percent > 0 && percent < 1 ? "under 1%" : `${Math.round(percent)}%`;
}

function Bar({ ms, most, color, height }: { ms: number; most: number; color: string; height: number }) {
  return (
    <span
      className="block rounded-sm"
      style={{ height, width: `${(ms / Math.max(1, most)) * 100}%`, minWidth: ms > 0 ? 2 : 0, background: color }}
    />
  );
}

function StackBar({ split, most }: { split: Split; most: number }) {
  const all = totalOf(split);
  if (all === 0) return null;
  return (
    <span className="flex h-2.5 overflow-hidden rounded-sm" style={{ width: `${(all / Math.max(1, most)) * 100}%`, minWidth: 2 }}>
      {TIME_PARTS.map((part) =>
        split[part.key] > 0 ? (
          <span key={part.key} style={{ width: `${(split[part.key] / all) * 100}%`, background: part.color }} />
        ) : null,
      )}
    </span>
  );
}

function lengthLabels(): string[] {
  const minutes = LENGTH_EDGES.map((edge) => edge / 60_000);
  return [
    `Under ${minutes[0]} min`,
    ...minutes.slice(1).map((upTo, index) => `${minutes[index]} to ${upTo} min`),
    `Over ${minutes[minutes.length - 1]} min`,
  ];
}

const Heading = ({ children }: { children: React.ReactNode }) => <p className="mb-2 text-xs font-medium">{children}</p>;

export function TurnTimeBreakdown({ breakdown, period }: { breakdown: Breakdown; period: string }) {
  const all = totalOf(breakdown.split);
  const rows = rowsOf(breakdown);
  const most = Math.max(1, ...rows.map((row) => row.ms));
  const longest = Math.max(1, ...breakdown.lengths.map((length) => totalOf(length.split)));
  const labels = lengthLabels();
  return (
    <section className="mt-6" aria-label="Where turn time goes">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Where turn time goes</h2>
        {breakdown.turns === 0 ? null : (
          <span className="text-xs text-muted-foreground">
            {formatSpan(all)} across {counted(breakdown.turns, "turn", "turns")}, {period.toLowerCase()}
          </span>
        )}
      </div>
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        {breakdown.turns === 0 ? (
          <p className="text-xs text-muted-foreground">No finished turns recorded in this period.</p>
        ) : (
          <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
            <div className="min-w-0">
              <Heading>By kind</Heading>
              <ul className="space-y-2 text-xs">
                {rows.map((row) => (
                  <li key={row.key} title={row.title}>
                    <div className="flex items-center gap-3">
                      <span className="w-[104px] shrink-0 truncate">{row.label}</span>
                      <span className="min-w-0 flex-1">
                        <Bar ms={row.ms} most={most} color={colorOf(row.part)} height={10} />
                      </span>
                      <span className="w-[110px] shrink-0 whitespace-nowrap text-right tabular-nums">
                        {formatSpan(row.ms)} <span className="text-muted-foreground">· {share(row.ms, all)}</span>
                      </span>
                    </div>
                    {row.key === "commandExecution" && breakdown.commands.length > 0 ? (
                      <ul className="ml-1.5 mt-1.5 space-y-1 border-l border-border pl-2.5">
                        {breakdown.commands.map((command) => (
                          <li
                            key={command.command}
                            className="flex items-center gap-3"
                            title={`${command.command}: ${counted(command.runs, "run", "runs")}, median ${formatSpan(command.medianMs)}, longest ${formatSpan(command.longestMs)}`}
                          >
                            <code className="min-w-0 flex-1 truncate font-mono">{command.command}</code>
                            <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                              {counted(command.runs, "run", "runs")}
                            </span>
                            <span className="w-[110px] shrink-0 whitespace-nowrap text-right tabular-nums text-muted-foreground">
                              {formatSpan(command.totalMs)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
            <div className="min-w-0">
              <Heading>By turn length</Heading>
              <ul className="space-y-2 text-xs">
                {breakdown.lengths.map((length, index) => (
                  <li key={labels[index]} className="flex items-center gap-3">
                    <span className="w-[76px] shrink-0">{labels[index]}</span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                      {counted(length.turns, "turn", "turns")}
                    </span>
                    <span className="flex min-w-0 flex-1">
                      <StackBar split={length.split} most={longest} />
                    </span>
                    <span className="w-[72px] shrink-0 whitespace-nowrap text-right tabular-nums">
                      {formatSpan(totalOf(length.split))}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {TIME_PARTS.map((part) => (
                  <span key={part.key} className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: part.color }} />
                    <span>{part.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatSpan(breakdown.split[part.key])} · {share(breakdown.split[part.key], all)}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
