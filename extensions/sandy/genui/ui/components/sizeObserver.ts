import { flushSync } from "react-dom";

type SizeListener = (rect: DOMRectReadOnly) => void;

interface Watch {
  readonly listener: SizeListener;
  reported: boolean;
}

const watches = new Map<Element, Set<Watch>>();
let observer: ResizeObserver | null = null;

function deliver(entries: ResizeObserverEntry[]): void {
  const initial: (() => void)[] = [];
  const later: (() => void)[] = [];
  for (const entry of entries) {
    for (const watch of watches.get(entry.target) ?? []) {
      const apply = () => watch.listener(entry.contentRect);
      if (watch.reported) later.push(apply);
      else {
        watch.reported = true;
        initial.push(apply);
      }
    }
  }
  if (initial.length > 0) {
    flushSync(() => {
      for (const apply of initial) apply();
    });
  }
  for (const apply of later) apply();
}

export function observeContentRect(element: Element, listener: SizeListener): () => void {
  observer ??= new ResizeObserver(deliver);
  const watch: Watch = { listener, reported: false };
  const forElement = watches.get(element) ?? new Set<Watch>();
  forElement.add(watch);
  watches.set(element, forElement);
  observer.observe(element);
  return () => {
    forElement.delete(watch);
    if (forElement.size > 0) return;
    watches.delete(element);
    if (watches.size > 0) {
      observer?.unobserve(element);
      return;
    }
    observer?.disconnect();
    observer = null;
  };
}
