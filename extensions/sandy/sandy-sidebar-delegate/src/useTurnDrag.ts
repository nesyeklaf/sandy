import { useRef, useState } from "react";
import type { PointerEvent } from "react";

interface TurnDrag {
  anchor: number;
  current: number;
}

function turnIndex(element: Element | null): number | null {
  const row = element?.closest<HTMLElement>("[data-turn]");
  const index = row ? Number(row.dataset.turn) : Number.NaN;
  return Number.isInteger(index) ? index : null;
}

/**
 * Drag over the rows of a list to pick a range of turns. A mouse starts on any
 * row; touch starts only on the grip (data-grip), so the list still scrolls.
 * Rows carry data-turn=index and the pressable part data-pick.
 */
export function useTurnDrag(onCommit: (from: number, to: number, extend: boolean) => void) {
  const [drag, setDrag] = useState<TurnDrag | null>(null);
  const live = useRef<TurnDrag | null>(null);
  const update = (next: TurnDrag | null) => {
    live.current = next;
    setDrag(next);
  };

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      const target = event.target as Element;
      if (event.button !== 0 || !target.closest("[data-pick]")) return;
      if (event.pointerType === "touch" && !target.closest("[data-grip]")) return;
      const index = turnIndex(target);
      if (index === null) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      update({ anchor: index, current: index });
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = live.current;
      if (!current) return;
      const index = turnIndex(document.elementFromPoint(event.clientX, event.clientY));
      if (index !== null && index !== current.current) update({ ...current, current: index });
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const current = live.current;
      update(null);
      if (current)
        onCommit(Math.min(current.anchor, current.current), Math.max(current.anchor, current.current), event.shiftKey);
    },
    onPointerCancel: () => update(null),
  };
  return { drag, handlers };
}
