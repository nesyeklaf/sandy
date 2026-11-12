import { useState } from "react";
import { useSidebarThreads } from "./sandy-sdk";
import { SpaceIdeas } from "./SpaceIdeas";
import { SpaceOverview } from "./SpaceOverview";
import { SpaceScratchpad } from "./SpaceScratchpad";
import { cn } from "./lib/utils";
import { useSpaceCoordination } from "./useSpaceCoordination";

const PANES = ["overview", "ideas", "scratchpad"] as const;
type Pane = (typeof PANES)[number];
const PANE_LABELS: Record<Pane, string> = { overview: "Overview", ideas: "Ideas", scratchpad: "Scratchpad" };

function useSpaceIdOf(threadId: string): string | null {
  const { threads } = useSidebarThreads();
  return threads.find((thread) => thread.id === threadId)?.sectionId ?? null;
}

export function useSpaceTabVisible({ threadId }: { threadId: string }): boolean {
  return useSpaceIdOf(threadId) !== null;
}

export function SpaceTab({ threadId }: { threadId: string }) {
  const spaceId = useSpaceIdOf(threadId);
  if (spaceId === null) return null;
  return <SpacePanes spaceId={spaceId} />;
}

function SpacePanes({ spaceId }: { spaceId: string }) {
  const [pane, setPane] = useState<Pane>("overview");
  const state = useSpaceCoordination(spaceId);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 text-xs">
      <div role="tablist" aria-label="Space" className="flex gap-1">
        {PANES.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={pane === entry}
            onClick={() => setPane(entry)}
            className={cn(
              "rounded px-2 py-1 text-xs hover:bg-accent max-md:min-h-9",
              pane === entry && "bg-accent font-medium",
            )}
          >
            {PANE_LABELS[entry]}
          </button>
        ))}
      </div>
      {state.error !== null ? (
        <p role="alert" className="text-2xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.space === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : pane === "overview" ? (
        <SpaceOverview state={state} space={state.space} />
      ) : pane === "ideas" ? (
        <SpaceIdeas state={state} space={state.space} />
      ) : (
        <SpaceScratchpad spaceId={spaceId} state={state} />
      )}
    </div>
  );
}
