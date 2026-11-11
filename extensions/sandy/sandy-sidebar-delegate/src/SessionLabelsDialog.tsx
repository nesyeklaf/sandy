import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { usePortalScopeProps } from "./lib/portal-scope";
import { toast } from "./lib/toast";
import { TOPICS_CHANNEL } from "./realtime-channels";
import { TagEditor } from "./TagEditor";

const REALIZE_FALLBACK_MS = 120;

function useRealizedOnce(open: boolean) {
  const [realized, setRealized] = useState(false);
  useEffect(() => {
    if (!open || realized) return;
    let outer = 0;
    let inner = 0;
    const realize = () => setRealized(true);
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(realize);
    });
    const fallback = setTimeout(realize, REALIZE_FALLBACK_MS);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(fallback);
    };
  }, [open, realized]);
  return realized;
}

interface SessionLabels {
  tags: string[];
  topics: string[];
}

function useSessionLabels(threadId: string, enabled: boolean) {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [labels, setLabels] = useState<SessionLabels | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("listTopics", { threadId });
      setLabels({ tags: result.threadTags, topics: result.threadTopics });
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [rpc, threadId]);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  useRealtime(TOPICS_CHANNEL, () => {
    if (enabled) void refresh();
  });
  const retry = () => {
    setLoadFailed(false);
    void refresh();
  };
  const save = async (write: () => Promise<SessionLabels>) => {
    try {
      setLabels(await write());
    } catch (error) {
      toast.error("Could not save", { description: error instanceof Error ? error.message : undefined });
    }
  };
  const setTags = (tags: string[]) =>
    save(async () => {
      const result = await rpc.call("setTopicTags", { kind: "thread", ownerId: threadId, tags });
      return { tags: result.tags, topics: labels?.topics ?? [] };
    });
  const setTopics = (topics: string[]) =>
    save(async () => {
      const result = await rpc.call("setThreadTopics", { threadId, topics });
      return { tags: labels?.tags ?? [], topics: result.topics };
    });
  return { labels, loadFailed, retry, setTags, setTopics };
}

export function SessionLabelsDialog({
  threadId,
  title,
  open,
  onOpenChange,
}: {
  threadId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const portalScope = usePortalScopeProps();
  const { labels, loadFailed, retry, setTags, setTopics } = useSessionLabels(threadId, open);
  const realized = useRealizedOnce(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Dialog.Portal>
        <Dialog.Content
          {...portalScope}
          onContextMenu={(event) => event.stopPropagation()}
          className="fixed left-1/2 top-1/2 z-50 box-border w-80 max-w-[calc(100%_-_2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:translate-x-0 max-sm:w-full max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <Dialog.Title className="text-sm font-semibold leading-5">Tags & Topics</Dialog.Title>
          <Dialog.Description className="truncate text-xs text-muted-foreground">{title}</Dialog.Description>
          {labels === null && loadFailed ? (
            <div role="alert" className="mt-3 flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Tags and topics could not be loaded.</span>
              <button
                type="button"
                onClick={retry}
                className="h-7 shrink-0 rounded-md border border-border bg-background px-2 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Try again
              </button>
            </div>
          ) : labels === null || !realized ? (
            <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <div className="mt-3 flex flex-col gap-3 text-xs">
              <section className="flex flex-col gap-1">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Tags</h3>
                <TagEditor tags={labels.tags} label="Tags of this session" onChange={(tags) => void setTags(tags)} />
              </section>
              <section className="flex flex-col gap-1">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Topics</h3>
                <TagEditor
                  kind="topic"
                  tags={labels.topics}
                  label="Topics of this session"
                  onChange={(topics) => void setTopics(topics)}
                />
              </section>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Done
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
