/** Longest message text a bookmark keeps; the rest of a longer message is cut. */
export const MAX_TEXT_LENGTH = 64_000;

/** Realtime channel the server publishes on after every write. */
export const CHANGED_CHANNEL = "changed";

/** The message action's title, which the host also renders as its aria-label. */
export const BOOKMARK_ACTION_TITLE = "Bookmark";

export const PANEL_ACTION_ID = "bookmarks";

/** Cut `text` to at most `length` UTF-16 units without splitting a surrogate pair. */
export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
