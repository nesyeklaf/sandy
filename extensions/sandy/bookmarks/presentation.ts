/**
 * Markdown flattened into readable plain text for a compact list row. Code
 * blocks are dropped when the message has prose to show instead.
 */
export function plainExcerpt(markdown: string): string {
  const prose = flatten(
    markdown.replace(/^[ \t]*(`{3,}|~{3,}).*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, " "),
  );
  return prose === "" ? flatten(markdown) : prose;
}

function flatten(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|?)+\s*$/gm, " ")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/`+/g, "")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One line for a list row; only assistant replies are markdown to flatten. */
export function excerptText(text: string, isMarkdown: boolean): string {
  return isMarkdown ? plainExcerpt(text) : text.replace(/\s+/g, " ").trim();
}

/** How long ago a bookmark was saved: `now`, `5m`, `3h`, `2d`, then a date. */
export function formatSavedAt(savedAt: number, now: number): string {
  const minutes = Math.floor((now - savedAt) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(savedAt);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}
