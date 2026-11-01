/** One backlog entry parsed from pasted text. */
export interface BacklogEntry {
  title: string;
  details: string;
}

const BULLET = /^(?:[-*+•]|\d+[.)]|\[[ xX]?\])\s+/;
const MAX_TITLE = 200;

/**
 * Parse pasted backlog text. Each unindented non-empty line starts an item;
 * indented lines that follow become that item's details. Bullets, numbering
 * and checkbox markers are stripped, and checked boxes (`[x]`) are skipped as
 * already done.
 */
export function parseBacklog(text: string): BacklogEntry[] {
  const entries: BacklogEntry[] = [];
  let current: { title: string; details: string[] } | null = null;
  let skipping = false;
  const flush = () => {
    if (current !== null) {
      entries.push({
        title: current.title,
        details: current.details.join("\n").trim(),
      });
    }
    current = null;
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.trim() === "") continue;
    const indented = /^\s/.test(raw);
    if (indented && (current !== null || skipping)) {
      current?.details.push(raw.trim());
      continue;
    }
    flush();
    let line = raw.trim();
    skipping = /^(?:[-*+]\s+)?\[[xX]\]\s+/.test(line);
    if (skipping) continue;
    while (BULLET.test(line)) line = line.replace(BULLET, "");
    line = line.replace(/^#+\s+/, "").trim();
    if (line === "") continue;
    const title = line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
    current = { title, details: line.length > MAX_TITLE ? [line] : [] };
  }
  flush();
  return entries;
}
