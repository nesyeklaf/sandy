export type Frontmatter = {
  fields: Record<string, string>;
  metadata: Record<string, string>;
  raw: string;
  bodyStart: number;
  bodyLine: number;
};

function unquote(value: string): string {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {}
    return text.slice(1, -1);
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

export function readFrontmatter(source: string): Frontmatter | undefined {
  const text = source.replace(/^\uFEFF/, "");
  const offset = source.length - text.length;
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (open === null) return undefined;
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open[0].length - 1));
  if (close === null) return undefined;
  const rawEnd = open[0].length - 1 + close.index;
  const raw = text.slice(open[0].length, rawEnd);
  const bodyStart = offset + open[0].length - 1 + close.index + close[0].length;
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let section: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top !== null) {
      section = top[2]!.trim() === "" ? top[1] : undefined;
      if (section === undefined) fields[top[1]!] = unquote(top[2]!);
      continue;
    }
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested !== null && section === "metadata") metadata[nested[1]!] = unquote(nested[2]!);
  }
  const bodyLine = source.slice(0, bodyStart).split("\n").length - 1;
  return { fields, metadata, raw, bodyStart, bodyLine };
}

export function dialectOf(source: string): string | undefined {
  return readFrontmatter(source)?.metadata.dialect;
}
