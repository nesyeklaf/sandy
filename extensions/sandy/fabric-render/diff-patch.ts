// Converts the line diff pi stores in a render entry (`@@ n @@`, ` N text`, `-N text`, `+N text`,
// `...` between hunks; numbers may be padded) into a unified patch for SANDY's diff viewer.
interface Hunk {
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  lines: string[];
}

export function toUnifiedPatch(diff: string, path: string): string | null {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let delta = 0; // new line number minus old line number at the current position
  for (const raw of diff.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "..." || trimmed.startsWith("@@")) {
      current = null;
      continue;
    }
    const match = /^([+\- ])\s*(\d+) ?(.*)$/.exec(raw);
    if (!match) continue;
    const sign = match[1]!;
    const n = Number(match[2]);
    const text = match[3] ?? "";
    if (current === null) {
      current = { oldStart: sign === "+" ? n - delta : n, newStart: sign === "+" ? n : n + delta, oldCount: 0, newCount: 0, lines: [] };
      hunks.push(current);
    }
    if (sign === " ") {
      current.oldCount += 1;
      current.newCount += 1;
    } else if (sign === "-") {
      current.oldCount += 1;
      delta -= 1;
    } else {
      current.newCount += 1;
      delta += 1;
    }
    current.lines.push(sign + text);
  }
  if (hunks.length === 0) return null;
  const body = hunks
    .map((h) => `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n${h.lines.join("\n")}`)
    .join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}
