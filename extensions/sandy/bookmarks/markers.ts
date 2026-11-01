import { BOOKMARK_ACTION_TITLE } from "./shared";

const FILLED_BOOKMARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 17.9808V9.70753C4 6.07416 4 4.25748 5.17157 3.12874C6.34315 2 8.22876 2 12 2C15.7712 2 17.6569 2 18.8284 3.12874C20 4.25748 20 6.07416 20 9.70753V17.9808C20 20.2867 20 21.4396 19.2272 21.8523C17.7305 22.6514 14.9232 19.9852 13.59 19.1824C12.8168 18.7168 12.4302 18.484 12 18.484C11.5698 18.484 11.1832 18.7168 10.41 19.1824C9.0768 19.9852 6.26947 22.6514 4.77285 21.8523C4 21.4396 4 20.2867 4 17.9808Z" fill="black" stroke="black" stroke-linejoin="round" stroke-width="1.5"/></svg>';

const FILLED_BOOKMARK = `url("data:image/svg+xml,${encodeURIComponent(FILLED_BOOKMARK_SVG)}")`;

function cssString(value: string): string {
  return value.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, " ");
}

/**
 * CSS that keeps the bookmark button of each bookmarked timeline row visible
 * and filled, the way a liked message looks. Rows scroll in and out of the
 * virtualized timeline, so attribute selectors follow them without observers.
 */
export function markerStyles(rowIds: readonly string[]): string {
  if (rowIds.length === 0) return "";
  const rows = rowIds
    .map((id) => `[data-timeline-row-id="${cssString(id)}"]`)
    .join(",");
  const button = `:is(${rows}) button[aria-label="${cssString(BOOKMARK_ACTION_TITLE)}"]`;
  return [
    `${button}{opacity:1!important;color:var(--foreground)!important}`,
    `${button} [data-plugin-icon-asset]{-webkit-mask-image:${FILLED_BOOKMARK}!important;mask-image:${FILLED_BOOKMARK}!important}`,
  ].join("\n");
}
