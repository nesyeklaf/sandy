// A small readout that follows the pointer over a chart mark. Fixed to the
// viewport, so a list's overflow does not clip it on the first or last row.
import type { ReactNode } from "react";

export interface TipPosition {
  /** Viewport coordinates of the mark's top centre. */
  x: number;
  y: number;
}

export function HoverTip({ at, children }: { at: TipPosition; children: ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
      style={{ left: at.x, top: at.y - 6 }}
    >
      {children}
    </span>
  );
}
