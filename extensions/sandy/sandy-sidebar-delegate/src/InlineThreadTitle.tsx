import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { toast } from "./lib/toast";
import { cn } from "./lib/utils";
import { threadDisplayTitle, threadStoredTitle, threadTitleHasMentions } from "./inbox";
import { ThreadTitle } from "./ThreadTitle";
import { statusToneClass } from "./StatusSlot";
import { threadFailed } from "./thread-status";
import { Icon } from "./components/Icon";
import { useIsIdea } from "./useIdeas";
import { useIsOrchestrator } from "./useOrchestrators";

export function InlineThreadTitle({
  thread,
  editing,
  onEditingChange,
  className,
}: {
  thread: PluginSidebarThread;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  className?: string;
}) {
  const sdk = useSdk();
  const isIdea = useIsIdea(thread.id);
  const isOrchestrator = useIsOrchestrator(thread.id);
  const title = threadStoredTitle(thread);
  const [draft, setDraft] = useState(title);
  const finished = useRef(false);
  const latest = useRef({ draft, title, sdk, onEditingChange });
  latest.current = { draft, title, sdk, onEditingChange };

  useLayoutEffect(() => {
    if (!editing) return;
    return () => {
      if (finished.current) return;
      finished.current = true;
      const { draft: currentDraft, title: currentTitle, sdk: currentSdk, onEditingChange: notify } = latest.current;
      notify(false);
      const nextTitle = currentDraft.trim();
      if (nextTitle && nextTitle !== currentTitle) saveTitle(currentSdk, thread.id, nextTitle);
    };
  }, [editing, thread.id]);

  useEffect(() => {
    if (!editing) return;
    setDraft(title);
    finished.current = false;
  }, [editing, title]);

  if (!editing) {
    return (
      <>
        {thread.isUnread ? (
          <span
            aria-hidden="true"
            data-unread-dot=""
            className={cn(
              "mr-1.5 inline-block size-[5px] shrink-0 rounded-full bg-current align-middle",
              statusToneClass(threadFailed(thread) ? "unread-error" : "unread-success"),
            )}
          />
        ) : null}
        {isOrchestrator ? (
          <span
            aria-hidden="true"
            data-orchestrator-mark=""
            className="mr-1 inline-flex shrink-0 align-[-0.125em] text-[color:var(--sandy-sidebar-tone-pending)]"
          >
            <Icon name="Orchestrator" className="size-3" aria-hidden />
          </span>
        ) : null}
        {isIdea ? (
          <span
            aria-hidden="true"
            data-idea-mark=""
            className="mr-1 inline-flex shrink-0 align-[-0.125em] text-[color:var(--sandy-sidebar-tone-draft)]"
          >
            <Icon name="Bulb" className="size-3" aria-hidden />
          </span>
        ) : null}
        <ThreadTitle
          threadId={thread.id}
          title={threadDisplayTitle(thread)}
          mentions={threadTitleHasMentions(thread)}
          className={className}
        />
      </>
    );
  }

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onEditingChange(false);
    const nextTitle = draft.trim();
    if (save && nextTitle.length > 0 && nextTitle !== title) {
      saveTitle(sdk, thread.id, nextTitle);
    }
  };

  return (
    <input
      autoFocus
      aria-label={`Rename ${threadDisplayTitle(thread)}`}
      value={draft}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cn(
        "h-6 w-full min-w-0 appearance-none rounded border border-solid border-border bg-background px-1.5 text-inherit text-foreground shadow-none outline-none focus:border-ring",
        className,
      )}
    />
  );
}

function saveTitle(sdk: ReturnType<typeof useSdk>, threadId: string, title: string) {
  void sdk.threads.update({ threadId, title }).catch((error) => {
    toast.error("Failed to update thread", {
      description: error instanceof Error ? error.message.replace(/^HTTP \d+: /, "") : undefined,
    });
  });
}
