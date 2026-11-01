import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import Bookmark02Icon from "@hugeicons/core-free-icons/Bookmark02Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useSandyNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageActionContext,
  type PluginRpcClient,
  type PluginSidebarProject,
  type ExperimentalThreadActionTabProps,
  type ExperimentalPanelController,
} from "@sandy-sdk/plugin-sdk/app";
import { toast } from "sonner";
import { markerStyles } from "./markers";
import { registerHeaderAction, type LegacyHeaderActionProps, type LegacyNavigate } from "./legacy-header";
import { openMessage, threadPath } from "./navigation";
import { excerptText, formatSavedAt } from "./presentation";
import { createRpcClient } from "./rpc";
import type { Bookmark, StoredBookmark, rpcContract } from "./server";
import {
  BOOKMARK_ACTION_TITLE,
  CHANGED_CHANNEL,
  MAX_TEXT_LENGTH,
  PANEL_ACTION_ID,
  truncate,
} from "./shared";

type BookmarksRpc = PluginRpcClient<typeof rpcContract>;

const actionRpc: BookmarksRpc = createRpcClient<typeof rpcContract>("bookmarks");

/** A cross-thread jump from the panel, so the panel can follow it there. */
let panelFollow: { threadId: string; expiresAt: number } | null = null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function announceRemoval(removed: StoredBookmark, rpc: BookmarksRpc) {
  toast("Bookmark removed", {
    action: {
      label: "Undo",
      onClick: () => {
        rpc
          .call("restore", removed)
          .catch((error: unknown) => toast.error(errorText(error)));
      },
    },
  });
}

async function toggleBookmark({
  threadId,
  message,
  selectedText,
  experimental_panel,
}: PluginMessageActionContext) {
  const showPanel = {
    label: "Show",
    onClick: () => {
      openBookmarksPanel(experimental_panel);
    },
  };
  const input = {
    threadId,
    seq: message.sourceSeqEnd,
    rowId: message.id,
    role: message.role,
    text: truncate(message.text, MAX_TEXT_LENGTH),
  };
  const quote = truncate(selectedText?.trim() ?? "", MAX_TEXT_LENGTH);
  try {
    if (quote !== "") {
      await actionRpc.call("save", { ...input, quote });
      toast.success("Selection bookmarked", { action: showPanel });
      return;
    }
    const { removed } = await actionRpc.call("toggle", input);
    if (removed === null) {
      toast.success("Bookmarked", { action: showPanel });
    } else {
      announceRemoval(removed, actionRpc);
    }
  } catch (error) {
    toast.error(`Could not update the bookmark: ${errorText(error)}`);
  }
}

/** Refetch after every server write, and once a dropped connection is back. */
function useBookmarksChanged(refetch: () => void) {
  useRealtime(CHANGED_CHANNEL, refetch);
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") {
      refetch();
    }
    previous.current = connection;
  }, [connection, refetch]);
}

function useBookmarkList(query: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const refetch = useCallback(() => {
    const request = ++latestRequest.current;
    rpc.call("list", query === "" ? null : { query }).then(
      (result) => {
        if (request !== latestRequest.current) return;
        setBookmarks(result.bookmarks);
        setError(null);
      },
      (cause: unknown) => {
        if (request === latestRequest.current) setError(errorText(cause));
      },
    );
  }, [rpc, query]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useBookmarksChanged(refetch);
  return { rpc, bookmarks, error };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function fallbackPath(
  bookmark: Bookmark,
  projects: ReadonlyMap<string, PluginSidebarProject>,
): string | null {
  if (bookmark.projectId === null) return null;
  return threadPath(
    bookmark.threadId,
    bookmark.projectId,
    projects.get(bookmark.projectId)?.isPersonal ?? false,
  );
}

function ItemAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: IconSvgElement;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.5} />
    </button>
  );
}

function BookmarkItem({
  bookmark,
  title,
  showThread,
  now,
  onOpen,
  onCopy,
  onRemove,
}: {
  bookmark: Bookmark;
  title: string;
  showThread: boolean;
  now: number;
  onOpen: () => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const excerpt = excerptText(
    bookmark.excerpt,
    bookmark.role === "assistant" && !bookmark.quoted,
  );
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        disabled={bookmark.threadDeleted}
        className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--state-hover)] hover:duration-0 focus-visible:bg-[var(--state-hover)] focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="flex min-w-0 items-center gap-1 pr-12 text-[11px] leading-4 text-muted-foreground">
          {showThread ? <span className="min-w-0 truncate">{title}</span> : null}
          {bookmark.role === "user" ? (
            <span className="shrink-0">{showThread ? "· You" : "You"}</span>
          ) : null}
        </span>
        <span
          className={`line-clamp-3 text-xs leading-[1.125rem] text-foreground ${
            bookmark.quoted ? "border-l-2 border-border pl-2" : ""
          }`}
        >
          {excerpt === "" ? "No text" : excerpt}
        </span>
      </button>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1.5 text-[11px] leading-4 tabular-nums text-muted-foreground group-focus-within:invisible group-hover:invisible"
      >
        {formatSavedAt(bookmark.createdAt, now)}
      </span>
      <span className="absolute right-1 top-0.5 hidden items-center group-focus-within:flex group-hover:flex">
        <ItemAction label="Copy text" icon={Copy01Icon} onClick={onCopy} />
        <ItemAction
          label="Remove bookmark"
          icon={Delete02Icon}
          onClick={onRemove}
        />
      </span>
    </li>
  );
}

type Scope = "all" | "thread";

function ScopeSwitch({
  scope,
  onChange,
}: {
  scope: Scope;
  onChange: (scope: Scope) => void;
}) {
  const options: { value: Scope; label: string }[] = [
    { value: "all", label: "All" },
    { value: "thread", label: "This thread" },
  ];
  return (
    <div
      role="group"
      aria-label="Bookmarks to show"
      className="flex h-7 shrink-0 items-center rounded-md bg-muted p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={scope === option.value}
          onClick={() => onChange(option.value)}
          className={`h-full rounded-[5px] px-2 text-[11px] leading-4 transition-colors ${
            scope === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground"
    >
      {children}
    </p>
  );
}

function BookmarksPanel({ threadId }: { threadId: string | null }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const search = useDebouncedValue(query.trim(), 150);
  const { rpc, bookmarks, error } = useBookmarkList(search);
  const sidebar = experimental_useSidebarThreads();
  const navigate = useSandyNavigate();
  const now = useNow(60_000);

  const threads = useMemo(
    () => new Map(sidebar.threads.map((thread) => [thread.id, thread])),
    [sidebar.threads],
  );
  const projects = useMemo(
    () => new Map(sidebar.projects.map((project) => [project.id, project])),
    [sidebar.projects],
  );

  const inThread = scope === "thread" && threadId !== null;
  const visible = useMemo(() => {
    if (bookmarks === null || !inThread) return bookmarks;
    return bookmarks
      .filter((bookmark) => bookmark.threadId === threadId)
      .sort((a, b) => a.seq - b.seq);
  }, [bookmarks, inThread, threadId]);

  function open(bookmark: Bookmark) {
    // The side panel belongs to one thread; a wide layout keeps the list
    // beside the thread it jumps to. On a phone the panel would cover it.
    if (
      bookmark.threadId !== threadId &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      panelFollow = { threadId: bookmark.threadId, expiresAt: Date.now() + 5_000 };
    }
    const href =
      threads.get(bookmark.threadId)?.href ?? fallbackPath(bookmark, projects);
    if (href === null || !openMessage(href, bookmark.threadId, bookmark.seq)) {
      navigate.toThread(bookmark.threadId);
    }
  }

  async function copy(bookmark: Bookmark) {
    try {
      const { text } = await rpc.call("fullText", { id: bookmark.id });
      await navigator.clipboard.writeText(text ?? bookmark.excerpt);
      toast.success("Copied");
    } catch (cause) {
      toast.error(`Could not copy the bookmark: ${errorText(cause)}`);
    }
  }

  async function remove(bookmark: Bookmark) {
    try {
      const { removed } = await rpc.call("remove", { id: bookmark.id });
      if (removed !== null) announceRemoval(removed, rpc);
    } catch (cause) {
      toast.error(`Could not remove the bookmark: ${errorText(cause)}`);
    }
  }

  let body: ReactNode;
  if (visible === null) {
    body =
      error === null ? (
        <span className="sr-only" role="status">
          Loading bookmarks…
        </span>
      ) : (
        <Notice>{error}</Notice>
      );
  } else if (visible.length === 0) {
    body = (
      <Notice>
        {search !== "" ? (
          `No bookmarks match “${search}”.`
        ) : inThread ? (
          "No bookmarks in this thread yet."
        ) : (
          <>
            No bookmarks yet.
            <br />
            Hover a message and click its bookmark icon to save it here.
          </>
        )}
      </Notice>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-px">
        {visible.map((bookmark) => (
          <BookmarkItem
            key={bookmark.id}
            bookmark={bookmark}
            title={
              bookmark.threadDeleted
                ? "Deleted thread"
                : (threads.get(bookmark.threadId)?.displayTitle ??
                  bookmark.threadTitle ??
                  "Untitled thread")
            }
            showThread={!inThread}
            now={now}
            onOpen={() => open(bookmark)}
            onCopy={() => void copy(bookmark)}
            onRemove={() => void remove(bookmark)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search bookmarks</span>
          <HugeiconsIcon
            icon={Search01Icon}
            size={14}
            strokeWidth={1.5}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="h-7 w-full rounded-md border border-border bg-transparent pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none"
          />
        </label>
        {threadId === null ? null : (
          <ScopeSwitch scope={scope} onChange={setScope} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{body}</div>
    </div>
  );
}

/** Opens the Bookmarks tab in the side panel of the surface that is in focus. */
function openBookmarksPanel(panel: ExperimentalPanelController): boolean {
  return panel.openTab({
    tab: { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" },
  });
}

function ThreadBookmarksPanel({ threadId }: ExperimentalThreadActionTabProps) {
  return <BookmarksPanel threadId={threadId} />;
}

function NewThreadBookmarksPanel() {
  return <BookmarksPanel threadId={null} />;
}

function useTimelineMarkers() {
  const rpc = useRpc<typeof rpcContract>();
  const [rowIds, setRowIds] = useState<readonly string[]>([]);
  const latestRequest = useRef(0);

  const refetch = useCallback(() => {
    const request = ++latestRequest.current;
    rpc.call("markers").then(
      (result) => {
        if (request === latestRequest.current) setRowIds(result.rowIds);
      },
      () => undefined,
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useBookmarksChanged(refetch);

  const css = useMemo(() => markerStyles(rowIds), [rowIds]);
  useEffect(() => {
    if (css === "") return;
    const style = document.createElement("style");
    style.dataset.bookmarksMarkers = "";
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  }, [css]);
}

function BookmarksOverlay() {
  useTimelineMarkers();
  return null;
}

// Only a component inside a thread view can open that thread's side panel;
// the app overlay cannot, so the header button also finishes panel jumps.
function HeaderButton({ threadId }: LegacyHeaderActionProps) {
  const navigate = useSandyNavigate() as LegacyNavigate;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const follow = panelFollow;
    if (follow === null || follow.threadId !== threadId) return;
    panelFollow = null;
    if (Date.now() > follow.expiresAt) return;
    let attempts = 0;
    let timer: number | undefined;
    const open = () => {
      if (navigateRef.current.openThreadPanel({ actionId: PANEL_ACTION_ID })) {
        return;
      }
      attempts += 1;
      if (attempts < 10) timer = window.setTimeout(open, 100);
    };
    open();
    return () => window.clearTimeout(timer);
  }, [threadId]);

  return (
    <button
      type="button"
      aria-label="Bookmarks"
      title="Bookmarks"
      onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--subtle-foreground)] transition-colors duration-150 hover:bg-[var(--state-hover)] hover:text-muted-foreground hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-9"
    >
      <HugeiconsIcon
        icon={Bookmark02Icon}
        size={16}
        strokeWidth={1.5}
        className="max-md:pointer-coarse:size-5"
        // How SANDY marks its own icons, so the styles for those color it too.
        data-icon-root=""
      />
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "bookmark",
    title: BOOKMARK_ACTION_TITLE,
    run: toggleBookmark,
  });

  app.slots.experimental_tab({
    id: PANEL_ACTION_ID,
    title: "Bookmarks",
    icon: "Bookmark",
    layout: "flush",
    context: { kind: "thread" },
    availability: "action",
    component: ThreadBookmarksPanel,
  });

  app.slots.experimental_newThreadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Bookmarks",
    layout: "flush",
    component: NewThreadBookmarksPanel,
  });

  registerHeaderAction(app.slots, {
    id: "bookmarks",
    title: "Bookmarks",
    component: HeaderButton,
  });

  app.slots.experimental_appOverlay({
    id: "timeline",
    component: BookmarksOverlay,
  });

  app.commands.register({
    id: "show-bookmarks",
    title: "Bookmarks: Show saved messages",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ experimental_panel }) => {
      openBookmarksPanel(experimental_panel);
    },
  });
});
