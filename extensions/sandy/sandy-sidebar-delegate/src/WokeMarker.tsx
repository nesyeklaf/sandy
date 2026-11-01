import { Tooltip } from "./components/Tooltip";

/** "Woke" beside a snoozed thread that came back; clicking it dismisses the marker. */
export function WokeMarker({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Tooltip label="Dismiss Woke marker">
      <button
        type="button"
        aria-label="Dismiss Woke marker"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }}
        className="pointer-events-auto text-2xs font-medium text-[color:var(--sandy-sidebar-woke)] hover:underline"
      >
        Woke
      </button>
    </Tooltip>
  );
}
