/** Settings hold lists as one string: one entry per line, commas also split. */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const entry = part.trim();
    if (entry) seen.add(entry);
  }
  return [...seen];
}

export const formatList = (items: readonly string[]): string => items.join("\n");
