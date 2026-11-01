// DOM rules for the composer's card stack, kept free of React so they can be
// tested on their own. Everything sandy-specific the plugin relies on is named
// here; all of it was checked against sandy 0.46.1.

/** sandy marks the composer shell; the card stack is its child holding the bar. */
export const SHELL_ATTR = "data-promptbox-shell";
/** sandy wraps each plugin banner in a display: contents element. */
export const PLUGIN_ROOT_ATTR = "data-sandy-plugin-root";

/**
 * Questions, approvals and plan reviews the thread waits on. They stay
 * visible when the stack is collapsed.
 */
export const PINNED_SELECTOR = [
  '[data-testid="approval-banner"]',
  '[data-testid="user-question-banner"]',
  '[data-testid="plan-review-banner"]',
  '[data-testid="plugin-request-banner"]',
  '[data-testid="plugin-interaction-shell"]',
].join(",");

/** Attribute changes that can show, hide or fold a card. */
export const WATCHED_ATTRIBUTES = [
  "class",
  "style",
  "hidden",
  "data-expanded",
  "data-state",
  "aria-hidden",
];

/**
 * The card stack the bar renders in: the child of the composer shell that
 * contains it. Null outside a composer shell (for example a new-thread form).
 */
export function findStack(from: Element): HTMLElement | null {
  let child: Element = from;
  let parent = from.parentElement;
  while (parent !== null) {
    if (parent.hasAttribute(SHELL_ATTR)) {
      return child instanceof HTMLElement ? child : null;
    }
    child = parent;
    parent = parent.parentElement;
  }
  return null;
}

function isContents(element: Element): boolean {
  return getComputedStyle(element).display === "contents";
}

/**
 * The cards laid out in the stack. Wrappers with display: contents (sandy's
 * plugin roots, and wrappers plugins add inside them) have no box of their
 * own, so folding them would do nothing; look through them to the boxes.
 */
export function stackItems(stack: Element, own: Element): HTMLElement[] {
  const items: HTMLElement[] = [];
  const visit = (element: Element) => {
    for (const child of Array.from(element.children)) {
      if (child === own || !(child instanceof HTMLElement)) continue;
      if (isContents(child)) visit(child);
      else items.push(child);
    }
  };
  visit(stack);
  return items;
}

export function isPinned(item: Element): boolean {
  return item.matches(PINNED_SELECTOR) || item.querySelector(PINNED_SELECTOR) !== null;
}

/**
 * Whether a card shows something. scrollHeight still reports the content of a
 * card folded to height 0 by app.css, so the answer is the same collapsed and
 * expanded. Cards sandy hides with display: none (empty:hidden) report 0.
 */
export function isShown(item: HTMLElement): boolean {
  return item.scrollHeight > 0 && getComputedStyle(item).opacity !== "0";
}

/** Cards the toggle hides: shown, and not something the thread waits on. */
export function countFoldable(
  stack: Element,
  own: Element,
  shown: (item: HTMLElement) => boolean = isShown,
): number {
  return stackItems(stack, own).filter((item) => !isPinned(item) && shown(item))
    .length;
}
