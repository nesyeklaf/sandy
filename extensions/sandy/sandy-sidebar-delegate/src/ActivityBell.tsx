import { useMemo, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { ACTIVITY_LABELS, activityFeed } from "./activity-feed";
import { Icon } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { threadDisplayTitle } from "./inbox";
import { useInboxActions } from "./InboxContext";
import { toast } from "./lib/toast";
import { relativeTimeLabel } from "./relative-time";

const KIND_TONE = {
  asked: "text-[color:var(--sandy-sidebar-tone-pending)]",
  failed: "text-[color:var(--sandy-sidebar-tone-error)]",
  finished: "text-[color:var(--sandy-sidebar-tone-success)]",
  archived: "text-muted-foreground",
} as const;

export function ActivityBell({
  threads,
  needs,
  open,
  onOpenChange,
}: {
  threads: readonly PluginSidebarThread[];
  needs: readonly PluginSidebarThread[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sdk = useSdk();
  const { openThread } = useInboxActions();
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const waiting = needs.length;
  const feed = useMemo(() => (open ? activityFeed(threads, needs, openedAt) : []), [open, threads, needs, openedAt]);
  const label = `Activity, ${waiting} ${waiting === 1 ? "thread needs" : "threads need"} you`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpenedAt(Date.now());
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title="Activity"
          className="relative flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="Bell" className="size-3.5" aria-hidden />
          {waiting > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-[color:var(--sandy-sidebar-tone-pending)] text-2xs font-medium leading-none text-background tabular-nums"
            >
              {waiting}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Activity" className="w-72 p-1">
        <h3 className="px-2 pb-0.5 pt-1 text-2xs font-medium text-muted-foreground">Last 24 hours</h3>
        {waiting > 0 ? (
          <p className="mx-1 mb-1 rounded-sm bg-sidebar-accent/60 px-2 py-1.5 text-xs">
            {waiting} {waiting === 1 ? "thread waits" : "threads wait"} in Needs you
          </p>
        ) : null}
        {feed.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">Nothing happened in the last 24 hours.</p>
        ) : (
          <ul aria-label="Activity feed" className="max-h-80 overflow-y-auto">
            {feed.map((item) => (
              <li key={`${item.kind}:${item.thread.id}`} className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-state-hover focus-visible:bg-state-hover"
                  onClick={() => {
                    onOpenChange(false);
                    openThread(item.thread.id);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{threadDisplayTitle(item.thread)}</span>{" "}
                    <span className={KIND_TONE[item.kind]}>{ACTIVITY_LABELS[item.kind]}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">
                    {relativeTimeLabel(item.at, openedAt)}
                  </span>
                </button>
                {item.kind === "archived" ? (
                  <button
                    type="button"
                    aria-label={`Restore ${threadDisplayTitle(item.thread)}`}
                    className="shrink-0 rounded-sm px-1.5 py-1 text-2xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => {
                      void sdk.threads.unarchive({ threadId: item.thread.id }).then(
                        () => toast.success("Thread restored"),
                        () => toast.error("Could not restore thread"),
                      );
                    }}
                  >
                    Restore
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
