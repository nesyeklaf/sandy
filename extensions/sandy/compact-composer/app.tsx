// Compact Composer: on phones the composer grows to at most three lines
// (app.css), and a tab at the top of the composer's card stack hides or
// shows every card in it (recap, follow-ups, workflows, context, todos, ...).
//
// The tab is a bare composer banner, so sandy renders it inside the card stack.
// It marks each card it may fold with data-cc-fold and the stack with
// data-cc-collapsed; app.css then folds the marked cards to height 0.
// Anything the thread waits on stays (stack.ts).
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  definePluginApp,
  experimental_usePluginId,
} from "@sandy-sdk/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  findStack,
  isPinned,
  isShown,
  PLUGIN_ROOT_ATTR,
  stackItems,
  WATCHED_ATTRIBUTES,
} from "./stack";
import "./app.css";

const COLLAPSED_ATTR = "data-cc-collapsed";
const OWN_ATTR = "data-cc-own";
const FOLD_ATTR = "data-cc-fold";
const PIN_ATTR = "data-cc-pin";

// One collapsed flag shared by every composer on screen and kept across
// reloads, so hiding the cards once keeps them hidden in every thread.
const listeners = new Set<() => void>();

function storageKey(pluginId: string) {
  return `${pluginId}:collapsed`;
}

function readCollapsed(pluginId: string): boolean {
  try {
    return localStorage.getItem(storageKey(pluginId)) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(pluginId: string, collapsed: boolean) {
  try {
    localStorage.setItem(storageKey(pluginId), collapsed ? "1" : "0");
  } catch {
    // Private mode or a full quota: keep the in-memory change only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function useCollapsed(pluginId: string) {
  return useSyncExternalStore(subscribe, () => readCollapsed(pluginId));
}

/**
 * Pulls the tab down onto whatever sits right below it (the first card left
 * open, or the composer) and 1px further, so it covers that edge. Measured
 * rather than fixed, because the gap depends on sandy's layout and theme.
 */
function dock(bar: HTMLElement, stack: HTMLElement, items: HTMLElement[]) {
  if (bar.offsetParent === null) return;
  bar.style.marginBottom = "0px";
  const barBottom = bar.getBoundingClientRect().bottom;
  const collapsed = stack.hasAttribute(COLLAPSED_ATTR);
  const below = items.filter(
    (item) => (!collapsed || item.hasAttribute(PIN_ATTR)) && isShown(item),
  );
  const next = below.length > 0 ? below : [stack.nextElementSibling];
  const tops = next
    .filter((element): element is Element => element !== null)
    .map((element) => element.getBoundingClientRect().top)
    .filter((top) => top >= barBottom);
  const margin =
    tops.length > 0 ? `${-(Math.min(...tops) - barBottom) - 1}px` : "0px";
  bar.style.marginBottom = margin;
}

/** The stack the tab sits in and the number of cards it could hide. */
function useStack(
  barRef: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
) {
  const [stack, setStack] = useState<HTMLElement | null>(null);
  const [cards, setCards] = useState(0);
  const collapsedRef = useRef(collapsed);
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) return;
    const found = findStack(bar);
    if (found === null) return;
    const own = bar.closest(`[${PLUGIN_ROOT_ATTR}]`) ?? bar;
    own.setAttribute(OWN_ATTR, "");
    setStack(found);

    let frame = 0;
    const update = () => {
      const items = stackItems(found, own);
      let count = 0;
      for (const item of items) {
        const pinned = isPinned(item);
        item.toggleAttribute(PIN_ATTR, pinned);
        item.toggleAttribute(FOLD_ATTR, !pinned);
        if (!pinned && isShown(item)) count += 1;
      }
      found.toggleAttribute(COLLAPSED_ATTR, collapsedRef.current && count > 0);
      setCards(count);
      dock(bar, found, items);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    scheduleRef.current = schedule;
    schedule();
    // Cards appear, disappear or fold through added nodes, attribute changes
    // (classes, hidden, data-expanded) and size changes.
    // Mutations inside the tab's own root (dock() sets its style) are ignored,
    // or every update would schedule the next one.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !own.contains(record.target))) schedule();
    });
    mutations.observe(found, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(found);
    if (found.nextElementSibling !== null) sizes.observe(found.nextElementSibling);
    return () => {
      cancelAnimationFrame(frame);
      scheduleRef.current = () => {};
      mutations.disconnect();
      sizes.disconnect();
      own.removeAttribute(OWN_ATTR);
      found.removeAttribute(COLLAPSED_ATTR);
      for (const item of Array.from(
        found.querySelectorAll(`[${FOLD_ATTR}], [${PIN_ATTR}]`),
      )) {
        item.removeAttribute(FOLD_ATTR);
        item.removeAttribute(PIN_ATTR);
      }
    };
  }, [barRef]);

  useEffect(() => {
    collapsedRef.current = collapsed;
    scheduleRef.current();
  }, [collapsed]);

  return { stack, cards };
}

function StackToggle() {
  const pluginId = experimental_usePluginId();
  const collapsed = useCollapsed(pluginId);
  const barRef = useRef<HTMLDivElement>(null);
  const { stack, cards } = useStack(barRef, collapsed);

  // Nothing to hide: no tab, so it takes no space.
  const visible = stack !== null && cards > 0;
  const label = collapsed
    ? `Show ${cards} hidden ${cards === 1 ? "card" : "cards"}`
    : "Hide cards above the composer";
  return (
    <div
      ref={barRef}
      className="cc-bar flex justify-end"
      style={visible ? undefined : { display: "none" }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={label}
        title={label}
        onClick={() => writeCollapsed(pluginId, !collapsed)}
        className="flex h-6 items-center gap-1 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground max-md:pointer-coarse:h-8"
      >
        <Icon
          name={collapsed ? "ChevronUp" : "ChevronDown"}
          className="size-3.5"
          aria-hidden
        />
        {collapsed ? `${cards} hidden` : "Hide"}
      </button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "compact-composer",
    banners: [{ id: "stack-toggle", chrome: "bare", component: StackToggle }],
  });
});
