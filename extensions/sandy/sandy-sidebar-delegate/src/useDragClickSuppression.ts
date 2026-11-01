import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Swallow the click a finished drag would otherwise fire on the row it started
 * from. Armed the moment a drag engages rather than when it drops, so drop,
 * Escape and a blurred window are all covered by the same listener.
 *
 * It disarms after one swallowed click, and on the next pointer press either
 * way. Staying armed would eat the click that Enter raises on the same row —
 * that click has no pointer press in front of it to clear the trap.
 *
 * Returns its own disarm so the caller can drop it on unmount.
 */
function armClickSuppression(key: string): () => void {
  const disarm = () => {
    window.removeEventListener("click", suppress, true);
    window.removeEventListener("pointerdown", disarm, true);
  };
  function suppress(event: MouseEvent) {
    const clicked =
      event.target instanceof Element
        ? (event.target.closest("[data-reorder-key]")?.getAttribute("data-reorder-key") ??
          event.target.closest("[data-sidebar-thread-id]")?.getAttribute("data-sidebar-thread-id"))
        : null;
    if (clicked !== key) return;
    event.preventDefault();
    event.stopPropagation();
    disarm();
  }
  window.addEventListener("click", suppress, true);
  window.addEventListener("pointerdown", disarm, true);
  return disarm;
}

export function useDragClickSuppression(activeReorderCancelRef: RefObject<(() => void) | null>) {
  const clickSuppressionRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      activeReorderCancelRef.current?.();
      // Suppression outlives the gesture on purpose, but not the component.
      clickSuppressionRef.current?.();
    },
    [],
  );
  return useCallback((key: string) => {
    clickSuppressionRef.current?.();
    clickSuppressionRef.current = armClickSuppression(key);
  }, []);
}
