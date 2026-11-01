import {
  SANDY_DESKTOP_MAX_ZOOM_PERCENT,
  SANDY_DESKTOP_MIN_ZOOM_PERCENT,
  type SandyDesktopZoomCommand,
} from "@sandy/desktop-contract";

const ZOOM_STEP_PERCENT = 10;

export function nextZoomFactor(
  zoomFactor: number,
  command: SandyDesktopZoomCommand,
): number {
  if (command === "reset") {
    return 1;
  }
  const step = command === "in" ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT;
  const percent =
    Math.round((zoomFactor * 100 + step) / ZOOM_STEP_PERCENT) *
    ZOOM_STEP_PERCENT;
  return (
    Math.min(
      SANDY_DESKTOP_MAX_ZOOM_PERCENT,
      Math.max(SANDY_DESKTOP_MIN_ZOOM_PERCENT, percent),
    ) / 100
  );
}
