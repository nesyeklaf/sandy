import { useRef, type MouseEvent, type PointerEvent } from "react";

const REPEAT_PRESS_MS = 400;

const lastPressActivation: { owner: object | null; at: number } = { owner: null, at: Number.NEGATIVE_INFINITY };

function activatesOnPress(event: PointerEvent): boolean {
  return (
    (event.pointerType === "mouse" || event.pointerType === "pen") &&
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function useRowActivation({
  onActivate,
  disabled = false,
  ignoreRepeatClicks = false,
}: {
  onActivate: () => void;
  disabled?: boolean;
  ignoreRepeatClicks?: boolean;
}) {
  const pressHandled = useRef(false);
  const owner = useRef({});
  return {
    onPointerDown(event: PointerEvent) {
      pressHandled.current = false;
      if (disabled || !activatesOnPress(event)) return;
      pressHandled.current = true;
      const repeatsLastActivation =
        lastPressActivation.owner === owner.current && event.timeStamp - lastPressActivation.at < REPEAT_PRESS_MS;
      if (repeatsLastActivation) return;
      lastPressActivation.owner = owner.current;
      lastPressActivation.at = event.timeStamp;
      onActivate();
    },
    onClick(event: MouseEvent) {
      const followsHandledPress = pressHandled.current && event.detail > 0;
      pressHandled.current = false;
      if (followsHandledPress || disabled || (ignoreRepeatClicks && event.detail > 1)) return;
      onActivate();
    },
  };
}
