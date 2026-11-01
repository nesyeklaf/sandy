// The numbers `sandy value` prints: one report per thread for a period, and
// the commands that took the most time. Pure; server.ts gathers the inputs.

/**
 * Commands that only set up the one after them. A chained command line is
 * credited to the last part that isn't one of these, since that is the part
 * the time was most likely spent in.
 */
const SETUP = new Set(["cd", "source", ".", "export", "set", "nvm", "pushd", "popd", "true", "unset"]);

/** Shell keywords around a loop or condition; the command inside is what ran. */
const LOOPS = new Set(["done", "fi", "esac"]);
const LOOP_HEADS = new Set(["for", "while", "until", "if", "case"]);

/** Tools whose first argument names what runs, so it belongs in the key. */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "npx", "bun", "git", "gh", "sandy", "node", "python3", "python", "cargo", "go", "make", "uv"]);

/**
 * A short key that groups runs of the same command: "npm run screenshots",
 * "git status", "pytest". It drops setup steps, pipes, redirections, and
 * arguments, so "cd x && npm test 2>&1 | tail" and "npm test" share a key.
 */
export function commandKey(commandLine: string): string {
  const firstLine = commandLine.split("\n")[0] ?? "";
  const parts = firstLine
    .split(/&&|\|\||;/)
    .map((part) => part.split("|")[0]!.trim().replace(/^(?:do|then|else)\s+/, ""))
    .filter((part) => part !== "" && !LOOPS.has(part));
  const words = (part: string) =>
    part
      .replace(/^(?:\w+=\S*\s+)+/, "")
      .split(/\s+/)
      .filter((word) => word !== "" && !/^\d?[<>]/.test(word));
  const main =
    [...parts].reverse().find((part) => !SETUP.has(words(part)[0] ?? "") && !LOOP_HEADS.has(words(part)[0] ?? "")) ??
    parts.at(-1) ??
    "";
  const [program = "", ...rest] = words(main);
  const name = program.split("/").at(-1)!;
  if (LOOP_HEADS.has(name)) return "shell loop";
  if (!RUNNERS.has(name)) return name;
  // Flags, the value after git's -C and -c, and shell variables say nothing
  // about which command it was.
  const args = rest.filter(
    (word, index) =>
      !word.startsWith("-") &&
      !/^["']?\$/.test(word) &&
      !(name === "git" && (rest[index - 1] === "-C" || rest[index - 1] === "-c")),
  );
  if ((name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") && args[0] === "run" && args[1] !== undefined) {
    return `${name} run ${args[1]}`;
  }
  return args[0] === undefined ? name : `${name} ${args[0]}`;
}

export interface CommandTotal {
  command: string;
  runs: number;
  totalMs: number;
  medianMs: number;
  longestMs: number;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Commands grouped by key, the most total time first. */
export function slowestCommands(runs: ReadonlyArray<{ label: string; ms: number }>, limit: number): CommandTotal[] {
  const byKey = new Map<string, number[]>();
  for (const run of runs) {
    const key = commandKey(run.label);
    if (key === "") continue;
    byKey.set(key, [...(byKey.get(key) ?? []), run.ms]);
  }
  return [...byKey.entries()]
    .map(([command, times]) => {
      const sorted = [...times].sort((a, b) => a - b);
      return {
        command,
        runs: sorted.length,
        totalMs: sorted.reduce((sum, ms) => sum + ms, 0),
        medianMs: median(sorted),
        longestMs: sorted.at(-1)!,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
}

export interface TurnTimeSummary {
  count: number;
  totalMs: number;
  medianMs: number;
  p90Ms: number;
  longestMs: number;
}

export function turnTimeSummary(durations: readonly number[]): TurnTimeSummary | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, ms) => sum + ms, 0),
    medianMs: median(sorted),
    p90Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!,
    longestMs: sorted.at(-1)!,
  };
}

export interface ThreadReport {
  threadId: string;
  title: string | null;
  project: string | null;
  provider: string;
  archived: boolean;
  /** Turns with recorded usage in the period. */
  turns: number;
  tokens: { input: number; cacheRead: number; output: number; total: number };
  /** Claude Code subagents run in the period; their tokens are already in `tokens`. */
  subagents: { count: number; tokens: number };
  /** The largest context seen in the period, and the latest; null before any was recorded. */
  context: { peak: number | null; latest: number | null };
  turnTime: TurnTimeSummary | null;
  /** Questions the agent asked you in the period, and how long the answers took. */
  waitingOnYou: { count: number; ms: number };
  slowestCommands: CommandTotal[];
}

export type SortKey = "tokens" | "time" | "context";

export function sortReports(reports: ThreadReport[], key: SortKey): ThreadReport[] {
  const value = (report: ThreadReport) =>
    key === "time" ? (report.turnTime?.totalMs ?? 0) : key === "context" ? (report.context.peak ?? 0) : report.tokens.total;
  return [...reports].sort((a, b) => value(b) - value(a));
}

/** Compact counts for the text table: 1.2M, 340K, 980. */
export function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(value);
}

export function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** The human-readable table `sandy value threads` prints without --json. */
export function formatThreads(reports: readonly ThreadReport[], days: number): string {
  if (reports.length === 0) return `No thread used tokens in the past ${days} days.`;
  const lines = [`${reports.length} threads, past ${days} days. Times are per turn: median / longest.`, ""];
  for (const report of reports) {
    const time = report.turnTime === null ? "no turn times" : `${minutes(report.turnTime.medianMs)} / ${minutes(report.turnTime.longestMs)}`;
    const parts = [
      `${compact(report.tokens.total)} tokens`,
      report.subagents.count > 0 ? `${compact(report.subagents.tokens)} in ${report.subagents.count} subagents` : null,
      `${report.turns} turns`,
      time,
      report.context.peak === null ? null : `peak context ${compact(report.context.peak)}`,
      report.waitingOnYou.count > 0 ? `waited on you ${minutes(report.waitingOnYou.ms)}` : null,
    ].filter((part) => part !== null);
    lines.push(`${report.threadId}  ${report.title ?? "Untitled thread"}${report.archived ? " (archived)" : ""}`);
    lines.push(`  ${parts.join(" · ")}`);
    if (report.slowestCommands.length > 0) {
      lines.push(`  slowest: ${report.slowestCommands.map((c) => `${c.command} ${c.runs}× ${minutes(c.totalMs)}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function formatCommands(commands: readonly CommandTotal[], days: number): string {
  if (commands.length === 0) return `No shell commands recorded in the past ${days} days.`;
  const lines = [`Commands that took the most time, past ${days} days. Runs, total, median per run, longest.`, ""];
  for (const command of commands) {
    lines.push(
      `${minutes(command.totalMs).padStart(6)}  ${String(command.runs).padStart(4)}×  median ${minutes(command.medianMs).padEnd(4)} longest ${minutes(command.longestMs).padEnd(4)}  ${command.command}`,
    );
  }
  return lines.join("\n");
}
