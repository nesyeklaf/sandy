import { useSpaceCoordination } from "./useSpaceCoordination";

export function SpaceAddOrchestrator({
  spaceId,
  name,
  onClose,
}: {
  spaceId: string;
  name: string;
  onClose: () => void;
}) {
  const state = useSpaceCoordination(spaceId);
  const candidates = state.space?.members.filter((member) => !member.isOrchestrator) ?? [];
  return (
    <div
      role="group"
      aria-label={`Add orchestrator to ${name}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
    >
      <p className="font-medium">Add orchestrator</p>
      {state.space === null ? <p className="text-2xs text-muted-foreground">Loading…</p> : null}
      {state.space !== null && candidates.length === 0 ? (
        <p className="text-2xs text-muted-foreground">Every session here is already an orchestrator.</p>
      ) : null}
      <ul>
        {candidates.map((member) => (
          <li key={member.threadId}>
            <button
              type="button"
              onClick={() =>
                void state
                  .act("Could not add the orchestrator", () =>
                    state.rpc.call("setOrchestrator", { threadId: member.threadId, orchestrator: true }),
                  )
                  .then((ok) => ok && onClose())
              }
              className="w-full truncate rounded px-1.5 py-1 text-left hover:bg-accent max-md:min-h-9"
            >
              {member.title || member.threadId}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClose}
        className="self-end rounded px-2 py-1 text-2xs hover:bg-accent max-md:min-h-9"
      >
        Cancel
      </button>
    </div>
  );
}
