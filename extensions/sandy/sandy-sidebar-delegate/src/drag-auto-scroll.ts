/** Nearest ancestor that actually scrolls, so a drag can reach past the fold. */
export function findScrollContainer(from: Element | null): HTMLElement | null {
  for (let node = from?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return null;
}

/** How close to an edge a drag must come before the shelf starts scrolling. */
const DRAG_SCROLL_EDGE = 48;
/** Pixels per frame at the very edge, ramping down to nothing at the hot zone. */
const DRAG_SCROLL_SPEED = 14;

interface DragScrollState {
  finished: boolean;
  engaged: boolean;
  scrollContainer: HTMLElement | null;
  pointerX: number;
  pointerY: number;
}

export function createDragAutoScroll(readState: () => DragScrollState, reorderAt: (x: number, y: number) => void) {
  let scrollFrame = 0;
  function onScrollFrame() {
    const { finished, engaged, scrollContainer, pointerX, pointerY } = readState();
    scrollFrame = 0;
    if (finished || !engaged) return;
    if (scrollContainer) {
      const rect = scrollContainer.getBoundingClientRect();
      const fromTop = pointerY - rect.top;
      const fromBottom = rect.bottom - pointerY;
      // A pointer dragged off to the side has left the shelf; it should
      // not keep driving it.
      const within = pointerX >= rect.left && pointerX <= rect.right;
      const delta = !within
        ? 0
        : fromTop < DRAG_SCROLL_EDGE
          ? -DRAG_SCROLL_SPEED * (1 - Math.max(fromTop, 0) / DRAG_SCROLL_EDGE)
          : fromBottom < DRAG_SCROLL_EDGE
            ? DRAG_SCROLL_SPEED * (1 - Math.max(fromBottom, 0) / DRAG_SCROLL_EDGE)
            : 0;
      if (delta !== 0) {
        const scrollTop = scrollContainer.scrollTop;
        scrollContainer.scrollTop = scrollTop + delta;
        // Only re-resolve when the view actually moved, so a drag parked
        // against an end does not churn state every frame. A host update
        // can still shift rows without the scroll position changing;
        // the next pointermove or the drop picks that up.
        if (scrollContainer.scrollTop !== scrollTop) {
          reorderAt(pointerX, pointerY);
        }
      }
    }
    scrollFrame = window.requestAnimationFrame(onScrollFrame);
  }

  return {
    start() {
      scrollFrame = window.requestAnimationFrame(onScrollFrame);
    },
    stop() {
      if (scrollFrame !== 0) {
        window.cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
      }
    },
  };
}

export function listenForDrag({
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  cancel,
  onVisibilityChange,
}: {
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  cancel: () => void;
  onVisibilityChange: () => void;
}) {
  window.addEventListener("pointermove", onPointerMove, {
    passive: false,
  });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown);
  // A gesture interrupted by lost focus, a hidden tab or a resize has no
  // drop target left worth guessing at.
  window.addEventListener("blur", cancel);
  window.addEventListener("resize", cancel);
  window.addEventListener("pagehide", cancel);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
    window.removeEventListener("pagehide", cancel);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
