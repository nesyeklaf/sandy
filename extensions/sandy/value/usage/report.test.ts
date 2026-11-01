import { describe, expect, it } from "vitest";

import { commandKey, slowestCommands, sortReports, turnTimeSummary, type ThreadReport } from "./report.js";

describe("commandKey", () => {
  it("credits a chained command to its last real step, without pipes, redirections, or arguments", () => {
    expect(commandKey("cd /tmp/widgets && source ~/.nvm/nvm.sh && npm test 2>&1 | tail -5")).toBe("npm test");
    expect(commandKey("npm run screenshots:isolated 2>&1 | grep value")).toBe("npm run screenshots:isolated");
    expect(commandKey("git status --short")).toBe("git status");
    expect(commandKey("FORCE_COLOR=0 npx tsc --noEmit -p tsconfig.json")).toBe("npx tsc");
    expect(commandKey("pytest -q tests/test_widgets.py")).toBe("pytest");
    expect(commandKey("python3 - <<'EOF'\nprint('hi')\nEOF")).toBe("python3");
  });

  it("groups loops and drops shell variables", () => {
    expect(commandKey("for f in a b; do echo $f; done")).toBe("echo");
    expect(commandKey("while true; do sleep 1; done")).toBe("sleep");
    expect(commandKey("for f in a b")).toBe("shell loop");
    expect(commandKey('git -C "$W" status')).toBe("git status");
    expect(commandKey("git -C ../widgets log --oneline")).toBe("git log");
  });
});

describe("slowestCommands", () => {
  it("groups runs by key, most total time first", () => {
    const commands = slowestCommands(
      [
        { label: "npm test", ms: 30_000 },
        { label: "cd widgets && npm test", ms: 50_000 },
        { label: "npm run screenshots", ms: 420_000 },
      ],
      5,
    );
    expect(commands).toEqual([
      { command: "npm run screenshots", runs: 1, totalMs: 420_000, medianMs: 420_000, longestMs: 420_000 },
      { command: "npm test", runs: 2, totalMs: 80_000, medianMs: 40_000, longestMs: 50_000 },
    ]);
  });
});

describe("turnTimeSummary", () => {
  it("gives the median, the 90th percentile, and the longest", () => {
    const durations = Array.from({ length: 10 }, (_, index) => (index + 1) * 60_000);
    expect(turnTimeSummary(durations)).toEqual({
      count: 10,
      totalMs: 3_300_000,
      medianMs: 330_000,
      p90Ms: 600_000,
      longestMs: 600_000,
    });
    expect(turnTimeSummary([])).toBeNull();
  });
});

describe("sortReports", () => {
  const report = (threadId: string, total: number, timeMs: number, peak: number | null): ThreadReport => ({
    threadId,
    title: null,
    project: "widgets",
    provider: "claude-code",
    archived: false,
    turns: 1,
    tokens: { input: 0, cacheRead: total, output: 0, total },
    subagents: { count: 0, tokens: 0 },
    context: { peak, latest: peak },
    turnTime: turnTimeSummary([timeMs]),
    waitingOnYou: { count: 0, ms: 0 },
    slowestCommands: [],
  });

  it("sorts by tokens, time, or peak context", () => {
    const reports = [report("thr_a", 10, 3, 100), report("thr_b", 30, 1, null), report("thr_c", 20, 2, 300)];
    expect(sortReports(reports, "tokens").map((r) => r.threadId)).toEqual(["thr_b", "thr_c", "thr_a"]);
    expect(sortReports(reports, "time").map((r) => r.threadId)).toEqual(["thr_a", "thr_c", "thr_b"]);
    expect(sortReports(reports, "context").map((r) => r.threadId)).toEqual(["thr_c", "thr_a", "thr_b"]);
  });
});
