import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExperimentalThreadTocRange,
  ExperimentalThreadTocSelection,
} from "@sandy-sdk/plugin-sdk";
import type {
  ThreadConversationOutlineItem,
  ThreadConversationOutlineResponse,
  TimelineConversationAttachments,
  TimelineConversationRow,
  TimelineRow,
} from "@sandy/server-contract";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { revealTimelineRow } from "@/components/thread/timeline/reveal-timeline-row.js";
import { useThreadConversationOutline } from "@/hooks/queries/thread-panel-queries";
import { useSenderThreadMetadataById } from "@/hooks/useSenderThreadMetadataById";
import { PromptMentionIcon } from "@/components/promptbox/mentions/PromptMentionIcon";
import { PROMPT_MENTION_PILL_CLASS } from "@sandy/client-core";
import { cn } from "@sandy/shared-ui/lib/utils";
import { parseAgentMessageEnvelope } from "@sandy/thread-view";
import { useThreadTitleDisplayText } from "@/components/thread/ThreadTitleMentions";
import {
  notifyThreadTocBandClick,
  notifyThreadTocBandHover,
  ThreadTocTabMount,
  useThreadTocExtensions,
} from "@/components/plugin/PluginThreadTocExtensions";
import {
  assignBandLanes,
  bandTickRange,
  pickBandAtTick,
  selectionFromTicks,
} from "./toc-rail-bands";
import { TOC_HALF_SWITCH_DELAY_MS, railHalfAt, railHalfTint, type TocRailHalf } from "./toc-rail-half";

export interface TocItem {
  id: string;
  label: string;
  role: "user" | "assistant";
  messageSeq: number;
}

type TocTab = "user" | "agent";
type PanelTab = TocTab | `ext:${string}`;

interface ActiveItemIds {
  agent: string | null;
  user: string | null;
}

interface ThreadTableOfContentsProps {
  contextBoundarySeq: number | null;
  threadId: string;
  projectId: string;
  timelineRows: readonly TimelineRow[];
  hasOlderTimelineRows: boolean;
  loadOlderTimelineRows: () => void | Promise<void>;
  onNavigateToRow?: (rowId: string) => void;
}

const TOC_MIN_VISIBLE_WIDTH_PX = 56 * 16;
const TOC_BOTTOM_ACTIVE_THRESHOLD_PX = 4;
const TOC_MIN_USER_MESSAGES = 3;
const TOC_MAX_RAIL_TICKS = 20;
const TOC_ACTIVE_UPDATE_IDLE_MS = 120;
const TOC_JUMP_MAX_PAGE_LOADS = 1000;
const TOC_JUMP_RENDER_FRAMES = 6;
const TOC_DRAG_THRESHOLD_PX = 8;
const TOC_BAND_LANE_PITCH_PX = 3;
function toPreviewLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatAttachmentCountLabel(
  imageCount: number,
  fileCount: number,
): string {
  const totalCount = imageCount + fileCount;
  if (totalCount === 0) return "Message";
  if (totalCount === 1) {
    return imageCount === 1 ? "Image attachment" : "File attachment";
  }
  return `${totalCount} attachments`;
}

function toTocLabel({
  attachments,
  text,
}: {
  attachments: TimelineConversationAttachments | null;
  text: string;
}): string {
  const textLabel = toPreviewLabel(text);
  if (textLabel) return textLabel;
  if (!attachments) return "Message";
  return formatAttachmentCountLabel(
    attachments.webImages + attachments.localImages,
    attachments.localFiles,
  );
}

const timelineTocItemsByRow = new WeakMap<TimelineConversationRow, TocItem>();

function getTimelineTocItem(row: TimelineConversationRow): TocItem {
  const cachedItem = timelineTocItemsByRow.get(row);
  if (cachedItem !== undefined) return cachedItem;
  const item: TocItem = {
    id: row.id,
    label: toTocLabel({ attachments: row.attachments, text: row.text }),
    role: row.role,
    messageSeq: row.messageSeq,
  };
  timelineTocItemsByRow.set(row, item);
  return item;
}

function outlineItemToTocItem(item: ThreadConversationOutlineItem): TocItem {
  const summary = item.attachmentSummary;
  return {
    id: item.id,
    label:
      item.preview ||
      (summary
        ? formatAttachmentCountLabel(summary.imageCount, summary.fileCount)
        : "Message"),
    role: item.role,
    messageSeq: item.messageSeq,
  };
}

function partitionTocItems(items: Iterable<TocItem>): {
  agentItems: TocItem[];
  userItems: TocItem[];
} {
  const userItems: TocItem[] = [];
  const agentItems: TocItem[] = [];
  for (const item of items) {
    if (item.role === "user") {
      userItems.push(item);
    } else {
      agentItems.push(item);
    }
  }
  return { agentItems, userItems };
}

function mergeLiveTocItems(
  outlineItems: readonly TocItem[],
  timelineItems: readonly TocItem[],
): TocItem[] {
  const timelineItemsById = new Map(
    timelineItems.map((item) => [item.id, item]),
  );
  const outlineItemIds = new Set(outlineItems.map((item) => item.id));
  return [
    ...outlineItems.map((item) => timelineItemsById.get(item.id) ?? item),
    ...timelineItems.filter((item) => !outlineItemIds.has(item.id)),
  ];
}

export function selectTocRailItems({
  activeId,
  items,
}: {
  activeId: string | null;
  items: readonly TocItem[];
}): readonly TocItem[] {
  if (items.length <= TOC_MAX_RAIL_TICKS) return items;

  const maxIndex = items.length - 1;
  const activeIndex =
    activeId === null ? -1 : items.findIndex((item) => item.id === activeId);
  const sampledIndices = new Set<number>();
  for (let slot = 0; slot < TOC_MAX_RAIL_TICKS; slot += 1) {
    sampledIndices.add(
      Math.round((slot * maxIndex) / (TOC_MAX_RAIL_TICKS - 1)),
    );
  }

  if (activeIndex >= 0) {
    sampledIndices.add(activeIndex);
    if (sampledIndices.size > TOC_MAX_RAIL_TICKS) {
      let removableIndex: number | null = null;
      let removableDistance = Number.POSITIVE_INFINITY;
      for (const index of sampledIndices) {
        if (index === activeIndex || index === 0 || index === maxIndex) {
          continue;
        }
        const distance = Math.abs(index - activeIndex);
        if (distance < removableDistance) {
          removableIndex = index;
          removableDistance = distance;
        }
      }
      if (removableIndex !== null) sampledIndices.delete(removableIndex);
    }
  }

  return Array.from(sampledIndices)
    .sort((a, b) => a - b)
    .map((index) => items[index]);
}

function TocPanelTab({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "bg-state-hover text-foreground"
          : "text-muted-foreground hover:bg-state-hover",
      )}
    >
      {label}
    </button>
  );
}

function TocThreadMention({
  threadId,
  threadTitle,
}: {
  threadId: string;
  threadTitle: string | null;
}) {
  const label = useThreadTitleDisplayText(threadTitle ?? "Agent");
  return (
    <span
      className={cn(
        PROMPT_MENTION_PILL_CLASS,
        "max-w-32 shrink-0 bg-surface-raised/50 text-foreground",
      )}
      title={`Thread: ${label}`}
    >
      <PromptMentionIcon
        resource={{ kind: "thread", threadId, label }}
        className="size-3 shrink-0 self-center text-muted-foreground"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function TocItemPreview({
  item,
  senderThreadMetadataById,
}: {
  item: TocItem;
  senderThreadMetadataById: ReadonlyMap<string, { title: string | null }>;
}) {
  const source = parseAgentMessageEnvelope(item.label);
  if (source === null) {
    return <span className="line-clamp-2">{item.label}</span>;
  }

  const body = item.label.slice(source.bodyStart);
  return (
    <span className="flex min-w-0 items-start gap-1">
      <TocThreadMention
        threadId={source.senderThreadId}
        threadTitle={
          senderThreadMetadataById.get(source.senderThreadId)?.title ?? null
        }
      />
      <span className="line-clamp-2 min-w-0">{body || "Message"}</span>
    </span>
  );
}

function mergeOutlineTocItems(
  outlineItems: readonly ThreadConversationOutlineItem[] | undefined,
  timelineItems: readonly TocItem[],
): TocItem[] {
  if (!outlineItems || outlineItems.length === 0) return [...timelineItems];
  return mergeLiveTocItems(
    outlineItems.map(outlineItemToTocItem),
    timelineItems,
  );
}

function useConversationTocItems({
  agentOutlineItems,
  timelineRows,
  userOutlineItems,
}: {
  agentOutlineItems: readonly ThreadConversationOutlineItem[] | undefined;
  timelineRows: readonly TimelineRow[];
  userOutlineItems: readonly ThreadConversationOutlineItem[] | undefined;
}) {
  const timelineTocItems = useMemo(
    () =>
      partitionTocItems(
        timelineRows
          .filter((row) => row.kind === "conversation")
          .map((row) => getTimelineTocItem(row)),
      ),
    [timelineRows],
  );
  const userItems = useMemo(
    () => mergeOutlineTocItems(userOutlineItems, timelineTocItems.userItems),
    [timelineTocItems.userItems, userOutlineItems],
  );
  const agentItems = useMemo(
    () => mergeOutlineTocItems(agentOutlineItems, timelineTocItems.agentItems),
    [agentOutlineItems, timelineTocItems.agentItems],
  );
  return { agentItems, userItems };
}

function currentOutlineItems(
  data: ThreadConversationOutlineResponse | undefined,
  contextBoundarySeq: number | null,
): readonly ThreadConversationOutlineItem[] | undefined {
  return contextBoundarySeq !== null &&
    (data?.maxSeq ?? -1) < contextBoundarySeq
    ? undefined
    : data?.items;
}

function useThreadTocVisible(rootElement: HTMLElement | null): boolean {
  const [visible, setVisible] = useState(
    () => typeof ResizeObserver === "undefined",
  );

  useEffect(() => {
    const host =
      rootElement?.closest<HTMLElement>("[data-scroll-overlay]") ?? null;
    if (typeof ResizeObserver === "undefined") {
      setVisible(true);
      return;
    }
    if (!host) {
      setVisible(false);
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const inlineSize =
        entry.contentBoxSize[0]?.inlineSize ?? entry.contentRect.width;
      setVisible(inlineSize >= TOC_MIN_VISIBLE_WIDTH_PX);
    });
    resizeObserver.observe(host, { box: "content-box" });
    return () => resizeObserver.disconnect();
  }, [rootElement]);

  return visible;
}

function findTimelineRowElements(
  scrollElement: HTMLElement | null,
): HTMLElement[] {
  return scrollElement
    ? Array.from(
        scrollElement.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
      )
    : [];
}

function findTimelineRowElement(
  scrollElement: HTMLElement | null,
  rowId: string,
): HTMLElement | null {
  return (
    findTimelineRowElements(scrollElement).find(
      (row) => row.dataset.timelineRowId === rowId,
    ) ?? null
  );
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve();
      return;
    }
    window.requestAnimationFrame(() => resolve());
  });
}

function isScrollElementNearBottom(scrollElement: HTMLElement): boolean {
  return (
    scrollElement.scrollHeight -
      scrollElement.clientHeight -
      scrollElement.scrollTop <=
    TOC_BOTTOM_ACTIVE_THRESHOLD_PX
  );
}

function findFirstVisibleItemId({
  rows,
  scrollBottom,
  scrollTop,
}: {
  rows: readonly HTMLElement[];
  scrollBottom: number;
  scrollTop: number;
}): string | null {
  let low = 0;
  let high = rows.length - 1;
  let visibleRow: HTMLElement | null = null;
  let visibleRect: DOMRect | null = null;

  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const row = rows[index];
    if (!row) break;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= scrollTop) {
      low = index + 1;
      continue;
    }
    visibleRow = row;
    visibleRect = rect;
    high = index - 1;
  }

  if (!visibleRow || !visibleRect || visibleRect.top >= scrollBottom) {
    return null;
  }
  return visibleRow.dataset.timelineRowId ?? null;
}

function findLastVisibleItemId({
  rows,
  scrollBottom,
  scrollTop,
}: {
  rows: readonly HTMLElement[];
  scrollBottom: number;
  scrollTop: number;
}): string | null {
  let low = 0;
  let high = rows.length - 1;
  let visibleRow: HTMLElement | null = null;
  let visibleRect: DOMRect | null = null;

  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const row = rows[index];
    if (!row) break;
    const rect = row.getBoundingClientRect();
    if (rect.top >= scrollBottom) {
      high = index - 1;
      continue;
    }
    visibleRow = row;
    visibleRect = rect;
    low = index + 1;
  }

  if (!visibleRow || !visibleRect || visibleRect.bottom <= scrollTop) {
    return null;
  }
  return visibleRow.dataset.timelineRowId ?? null;
}

export function findActiveItemIds({
  agentItems,
  scrollElement,
  userItems,
}: {
  agentItems: readonly TocItem[];
  scrollElement: HTMLElement | null;
  userItems: readonly TocItem[];
}): ActiveItemIds {
  if (!scrollElement || (userItems.length === 0 && agentItems.length === 0)) {
    return { agent: null, user: null };
  }
  const scrollRect = scrollElement.getBoundingClientRect();
  const scrollTop = scrollRect.top;
  const scrollBottom = scrollRect.bottom;
  const isNearBottom = isScrollElementNearBottom(scrollElement);
  const rolesById = new Map<string, TocTab>();
  for (const item of userItems) rolesById.set(item.id, "user");
  for (const item of agentItems) rolesById.set(item.id, "agent");
  const userRows: HTMLElement[] = [];
  const agentRows: HTMLElement[] = [];

  for (const row of findTimelineRowElements(scrollElement)) {
    const rowId = row.dataset.timelineRowId;
    if (!rowId) continue;
    const role = rolesById.get(rowId);
    if (role === "user") {
      userRows.push(row);
    } else if (role === "agent") {
      agentRows.push(row);
    }
  }

  if (isNearBottom) {
    return {
      agent: findLastVisibleItemId({
        rows: agentRows,
        scrollBottom,
        scrollTop,
      }),
      user: findLastVisibleItemId({
        rows: userRows,
        scrollBottom,
        scrollTop,
      }),
    };
  }

  return {
    agent: findFirstVisibleItemId({
      rows: agentRows,
      scrollBottom,
      scrollTop,
    }),
    user: findFirstVisibleItemId({
      rows: userRows,
      scrollBottom,
      scrollTop,
    }),
  };
}

function bandColor(hue: number, alpha = 1): string {
  const normalized = ((hue % 360) + 360) % 360;
  return `oklch(0.72 0.14 ${normalized} / ${alpha})`;
}

function sameRange(
  left: ExperimentalThreadTocRange,
  right: ExperimentalThreadTocRange | null,
): boolean {
  return (
    right !== null &&
    left.fromSeq === right.fromSeq &&
    left.toSeq === right.toSeq
  );
}

function nearestTickId(
  rootElement: HTMLElement | null,
  clientY: number,
): string | null {
  if (!rootElement) return null;
  let nearestId: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const element of rootElement.querySelectorAll<HTMLElement>(
    "[data-toc-tick]",
  )) {
    const rect = element.getBoundingClientRect();
    const distance = Math.abs((rect.top + rect.bottom) / 2 - clientY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestId = element.dataset.tocTickId ?? null;
    }
  }
  return nearestId;
}

export function ThreadTableOfContents({
  contextBoundarySeq,
  threadId,
  projectId,
  timelineRows,
  hasOlderTimelineRows,
  loadOlderTimelineRows,
  onNavigateToRow,
}: ThreadTableOfContentsProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const [rootElement, setRootElement] = useState<HTMLElement | null>(null);
  const tocVisible = useThreadTocVisible(rootElement);
  const [open, setOpen] = useState(false);
  const [railHoverId, setRailHoverId] = useState<string | null>(null);
  const [chosenTab, setTab] = useState<PanelTab | null>(null);
  const [railHalf, setRailHalf] = useState<TocRailHalf | null>(null);
  const halfTimerRef = useRef<number | null>(null);
  const pointerFocusRef = useRef(false);
  const clearHalfTimer = useCallback(() => {
    if (halfTimerRef.current === null) return;
    window.clearTimeout(halfTimerRef.current);
    halfTimerRef.current = null;
  }, []);
  const [hoveredRange, setHoveredRangeState] =
    useState<ExperimentalThreadTocRange | null>(null);
  const [pointerBand, setPointerBand] =
    useState<ExperimentalThreadTocRange | null>(null);
  const [railSelection, setRailSelection] =
    useState<ExperimentalThreadTocSelection | null>(null);
  const dragRef = useRef<{
    startId: string | null;
    startY: number;
    moved: boolean;
  } | null>(null);
  const extensionInput = useMemo(
    () => ({ threadId, projectId }),
    [threadId, projectId],
  );
  const {
    bands: extensionBands,
    tabs: extensionTabs,
    observers: extensionObservers,
  } = useThreadTocExtensions(extensionInput);
  const panelOpen = open || railSelection !== null;
  const extScrollRef = useRef<HTMLDivElement | null>(null);
  const pickedBandRef = useRef<(typeof extensionBands)[number] | null>(null);
  const defaultExtensionTab = extensionTabs.find(
    (entry) => entry.slot.tab?.experimental_default === true,
  );
  const tab: PanelTab =
    chosenTab ??
    (defaultExtensionTab ? `ext:${defaultExtensionTab.key}` : "user");
  const outlineEnabled = tocVisible && timelineRows.length > 0;
  const userOutlineQuery = useThreadConversationOutline(threadId, "user", {
    enabled: outlineEnabled,
  });
  const agentOutlineQuery = useThreadConversationOutline(
    threadId,
    "assistant",
    { enabled: outlineEnabled && panelOpen && tab === "agent" },
  );
  const senderThreadMetadataById = useSenderThreadMetadataById();
  const { agentItems, userItems } = useConversationTocItems({
    agentOutlineItems: currentOutlineItems(
      agentOutlineQuery.data,
      contextBoundarySeq,
    ),
    timelineRows,
    userOutlineItems: currentOutlineItems(
      userOutlineQuery.data,
      contextBoundarySeq,
    ),
  });
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const {
    aboveOverflow,
    belowOverflow,
    bottomSentinelRef,
    scrollRef,
    topSentinelRef,
  } = useScrollOverflowState<HTMLDivElement>({
    enabled: panelOpen,
    measureOverflow: true,
  });
  const itemEls = useRef(new Map<string, HTMLElement>());
  const activeIdsRef = useRef<ActiveItemIds>({ agent: null, user: null });
  const hasAgentMessages = agentItems.length > 0;
  const extensionTab =
    extensionTabs.find((entry) => tab === `ext:${entry.key}`) ?? null;
  const activeTab: TocTab =
    extensionTab === null && tab === "agent" && hasAgentMessages
      ? "agent"
      : "user";
  const items = activeTab === "user" ? userItems : agentItems;
  const activeId = activeTab === "user" ? activeUserId : activeAgentId;
  const railItems = useMemo(
    () => selectTocRailItems({ activeId: activeUserId, items: userItems }),
    [activeUserId, userItems],
  );
  const railBands = useMemo(() => {
    const entries = extensionBands.flatMap((entry) => {
      const range = bandTickRange(railItems, entry.band);
      return range ? [{ entry, range }] : [];
    });
    const lanes = assignBandLanes(entries.map(({ range }) => range));
    return entries.map((item, index) => ({
      ...item,
      lane: lanes[index] ?? 0,
      highlighted:
        sameRange(item.entry.band, hoveredRange) ||
        sameRange(item.entry.band, pointerBand),
    }));
  }, [extensionBands, hoveredRange, pointerBand, railItems]);
  const highlightedTicks = useMemo(() => {
    const indexes = new Set<number>();
    for (const { highlighted, range } of railBands) {
      if (!highlighted) continue;
      for (let index = range.start; index <= range.end; index += 1) {
        indexes.add(index);
      }
    }
    return indexes;
  }, [railBands]);
  const activeSeq = useMemo(
    () =>
      userItems.find((item) => item.id === activeUserId)?.messageSeq ?? null,
    [activeUserId, userItems],
  );
  const setHoveredRange = useCallback(
    (range: ExperimentalThreadTocRange | null) => {
      setHoveredRangeState((current) =>
        current?.fromSeq === range?.fromSeq && current?.toSeq === range?.toSeq
          ? current
          : range,
      );
    },
    [],
  );
  const openExtensionTab = useCallback(
    (pluginId: string, id: string) => {
      const target = extensionTabs.find(
        (entry) => entry.slot.pluginId === pluginId && entry.slot.id === id,
      );
      if (target) setTab(`ext:${target.key}`);
    },
    [extensionTabs],
  );
  const outlineMaxSeq = userOutlineQuery.data?.maxSeq ?? 0;

  const hasOlderRef = useRef(hasOlderTimelineRows);
  hasOlderRef.current = hasOlderTimelineRows;
  const loadOlderRef = useRef(loadOlderTimelineRows);
  loadOlderRef.current = loadOlderTimelineRows;
  const jumpInProgressRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!tocVisible) return;
    const scrollElement = bottomAnchor?.getScrollElement();
    if (!scrollElement) return;
    const publishActiveItems = (nextActiveIds: ActiveItemIds) => {
      const currentActiveIds = activeIdsRef.current;
      if (nextActiveIds.user !== currentActiveIds.user) {
        setActiveUserId(nextActiveIds.user);
      }
      if (nextActiveIds.agent !== currentActiveIds.agent) {
        setActiveAgentId(nextActiveIds.agent);
      }
      activeIdsRef.current = nextActiveIds;
    };
    const updateActiveItems = () => {
      publishActiveItems(
        findActiveItemIds({ agentItems, scrollElement, userItems }),
      );
    };
    let updateTimeout: number | null = null;
    const scheduleActiveItemsUpdate = () => {
      if (updateTimeout !== null) {
        window.clearTimeout(updateTimeout);
      }
      updateTimeout = window.setTimeout(() => {
        updateTimeout = null;
        updateActiveItems();
      }, TOC_ACTIVE_UPDATE_IDLE_MS);
    };
    scheduleActiveItemsUpdate();
    scrollElement.addEventListener("scroll", scheduleActiveItemsUpdate, {
      passive: true,
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleActiveItemsUpdate);
    resizeObserver?.observe(scrollElement);

    return () => {
      scrollElement.removeEventListener("scroll", scheduleActiveItemsUpdate);
      resizeObserver?.disconnect();
      if (updateTimeout !== null) {
        window.clearTimeout(updateTimeout);
      }
    };
  }, [agentItems, bottomAnchor, tocVisible, userItems]);

  useEffect(() => {
    setRailSelection(null);
    setHoveredRangeState(null);
    setPointerBand(null);
  }, [threadId]);

  useEffect(() => {
    if (panelOpen) return;
    const picked = pickedBandRef.current;
    pickedBandRef.current = null;
    if (picked) notifyThreadTocBandHover(picked, false, extensionInput);
    setPointerBand(null);
    setHoveredRangeState(null);
    setRailHalf(null);
    setTab(null);
    clearHalfTimer();
  }, [panelOpen, clearHalfTimer, extensionInput]);

  useEffect(() => {
    if (!panelOpen || !rootElement) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || rootElement.contains(target)) return;
      if (
        target.closest(
          '[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]',
        )
      ) {
        return;
      }
      setOpen(false);
 setRailHoverId(null);
      setRailSelection(null);
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && rootElement.contains(focused)) {
        focused.blur();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [panelOpen, rootElement]);

  useEffect(() => {
    if (railSelection === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailSelection(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [railSelection]);

  useEffect(() => {
    if (!tocVisible || !panelOpen) return;
    const container = scrollRef.current;
    const el = activeId ? itemEls.current.get(activeId) : null;
    if (!container || !el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const pad = 8;
    if (elRect.top < containerRect.top + pad) {
      container.scrollTo({
        top: container.scrollTop - (containerRect.top + pad - elRect.top),
      });
    } else if (elRect.bottom > containerRect.bottom - pad) {
      container.scrollTo({
        top:
          container.scrollTop + (elRect.bottom - (containerRect.bottom - pad)),
      });
    }
  }, [activeId, items, panelOpen, scrollRef, tocVisible]);

  useEffect(() => {
    if (!tocVisible || !panelOpen || railHoverId === null) return;
    const container = scrollRef.current;
    const el = itemEls.current.get(railHoverId);
    if (!container || !el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offset =
      elRect.top -
      containerRect.top -
      (containerRect.height - elRect.height) / 2;
    container.scrollTop += offset;
  }, [panelOpen, railHoverId, scrollRef, tocVisible]);

  const handleSelect = useCallback(
    async (id: string) => {
      const getScrollElement = () => bottomAnchor?.getScrollElement() ?? null;
      const scrollToRow = (element: HTMLElement) => {
        revealTimelineRow(element, bottomAnchor);
      };
      onNavigateToRow?.(id);

      let row = findTimelineRowElement(getScrollElement(), id);
      if (row) {
        scrollToRow(row);
        return;
      }
      if (jumpInProgressRef.current) return;
      jumpInProgressRef.current = true;
      setPendingJumpId(id);
      const waitForRenderedRow = async () => {
        for (let frame = 0; frame < TOC_JUMP_RENDER_FRAMES; frame++) {
          await waitForAnimationFrame();
          if (!mountedRef.current) return null;
          const renderedRow = findTimelineRowElement(getScrollElement(), id);
          if (renderedRow) return renderedRow;
        }
        return null;
      };
      try {
        if (timelineRows.some((timelineRow) => timelineRow.id === id)) {
          row = await waitForRenderedRow();
          if (!mountedRef.current) return;
        }
        let loads = 0;
        while (!row && hasOlderRef.current && loads < TOC_JUMP_MAX_PAGE_LOADS) {
          loads += 1;
          try {
            await Promise.resolve(loadOlderRef.current());
          } catch {
            break;
          }
          if (!mountedRef.current) return;
          row = await waitForRenderedRow();
          if (!mountedRef.current) return;
        }
        if (!row) row = findTimelineRowElement(getScrollElement(), id);
        if (row) scrollToRow(row);
      } finally {
        jumpInProgressRef.current = false;
        setPendingJumpId(null);
      }
    },
    [bottomAnchor, onNavigateToRow, timelineRows],
  );

  const jumpToSeq = useCallback(
    (seq: number) => {
      const row = timelineRows.find(
        (timelineRow) =>
          timelineRow.kind === "conversation" && timelineRow.messageSeq === seq,
      );
      if (row) {
        void handleSelect(row.id);
        return;
      }
      let target: TocItem | undefined;
      for (const item of userItems) {
        if (item.messageSeq > seq) break;
        target = item;
      }
      target ??= userItems[0];
      if (target) void handleSelect(target.id);
    },
    [handleSelect, timelineRows, userItems],
  );

  const clearRailSelection = useCallback(() => setRailSelection(null), []);

  const updateDragSelection = (clientY: number) => {
    const drag = dragRef.current;
    if (!drag || drag.startId === null) return;
    const endId = nearestTickId(rootElement, clientY);
    if (endId === null) return;
    const selection = selectionFromTicks({
      fromTickId: drag.startId,
      toTickId: endId,
      maxSeq: outlineMaxSeq,
      userTicks: userItems,
    });
    if (selection) setRailSelection(selection);
  };

  const canSelect = extensionTabs.length > 0;
  const applyRailHalf = (half: TocRailHalf) => {
    setRailHalf(half);
    const target = defaultExtensionTab ?? extensionTabs[0];
    setTab(half === "topics" && target ? `ext:${target.key}` : "user");
  };
  const setPickedBand = (entry: (typeof extensionBands)[number] | null) => {
    const previous = pickedBandRef.current;
    if (previous === null && entry === null) return;
    if (previous && entry && sameRange(previous.band, entry.band)) return;
    if (previous) notifyThreadTocBandHover(previous, false, extensionInput);
    pickedBandRef.current = entry;
    setPointerBand(
      entry ? { fromSeq: entry.band.fromSeq, toSeq: entry.band.toSeq } : null,
    );
    if (entry) notifyThreadTocBandHover(entry, true, extensionInput);
  };
  const pickBandAtPointer = (clientY: number) => {
    const tickId = nearestTickId(rootElement, clientY);
    const tickIndex = railItems.findIndex((item) => item.id === tickId);
    const picked =
      tickIndex < 0
        ? null
        : pickBandAtTick(
            railBands.map(({ range }) => range),
            tickIndex,
          );
    setPickedBand(picked === null ? null : (railBands[picked]?.entry ?? null));
  };
  const onRailPointer = (event: ReactPointerEvent<HTMLElement>) => {
    syncRailHalf(event);
    if (dragRef.current?.moved) return;
    const half = canSelect
      ? railHalfAt(event.clientX, event.currentTarget.getBoundingClientRect())
      : "messages";
    setRailHoverId(
      half === "messages" ? nearestTickId(rootElement, event.clientY) : null,
    );
    if (!canSelect) return;
    if (half === "topics") {
      if (event.target instanceof Element && event.target.closest("[data-toc-band]")) return;
      pickBandAtPointer(event.clientY);
    }
    else setPickedBand(null);
  };
  const syncRailHalf = (event: ReactPointerEvent<HTMLElement>) => {
    if (!canSelect || dragRef.current?.moved) return;
    const half = railHalfAt(
      event.clientX,
      event.currentTarget.getBoundingClientRect(),
    );
    if (half === "topics" || railHalf !== "topics") {
      clearHalfTimer();
      if (half !== railHalf) applyRailHalf(half);
      return;
    }
    if (halfTimerRef.current !== null) return;
    halfTimerRef.current = window.setTimeout(() => {
      halfTimerRef.current = null;
      applyRailHalf("messages");
    }, TOC_HALF_SWITCH_DELAY_MS);
  };

  if (userItems.length < TOC_MIN_USER_MESSAGES) {
    return <span ref={setRootElement} aria-hidden className="hidden" />;
  }

  return (
    <div
      ref={setRootElement}
      data-thread-toc=""
      className="group/toc relative w-8"
      onPointerDownCapture={() => {
        pointerFocusRef.current = true;
      }}
      onKeyDownCapture={() => {
        pointerFocusRef.current = false;
      }}
      onWheel={(event) => {
        const scroller = extensionTab ? extScrollRef.current : scrollRef.current;
        if (!scroller || scroller.contains(event.target as Node)) return;
        scroller.scrollTop +=
          event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (
          !pointerFocusRef.current &&
          event.currentTarget.contains(document.activeElement)
        ) {
          return;
        }
        setOpen(false);
 setRailHoverId(null);
      }}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setOpen(false);
 setRailHoverId(null);
        }
      }}
    >
      <div
        className={cn("relative", !tocVisible && "hidden")}
        inert={!tocVisible}
      >
        {tocVisible ? extensionObservers : null}
        <button
          type="button"
          aria-label="Thread table of contents"
          aria-expanded={panelOpen}
          aria-controls={`thread-toc-panel-${threadId}`}
          onClick={() => setOpen(true)}
          data-rail-half={railHalf ?? undefined}
          onPointerEnter={onRailPointer}
          onPointerDown={(event) => {
            syncRailHalf(event);
            if (!canSelect || event.button !== 0) return;
            dragRef.current = {
              startId: nearestTickId(rootElement, event.clientY),
              startY: event.clientY,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) {
              onRailPointer(event);
              return;
            }
            if (
              !drag.moved &&
              Math.abs(event.clientY - drag.startY) < TOC_DRAG_THRESHOLD_PX
            ) {
              return;
            }
            if (!drag.moved) {
              drag.moved = true;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              const first = extensionTabs[0];
              if (first) setTab(`ext:${first.key}`);
            }
            updateDragSelection(event.clientY);
          }}
          onPointerLeave={() => setPickedBand(null)}
          onPointerUp={(event) => {
            const wasDrag = dragRef.current?.moved === true;
            if (wasDrag) updateDragSelection(event.clientY);
            dragRef.current = null;
            if (
              wasDrag ||
              event.button !== 0 ||
              (event.target instanceof Element &&
                event.target.closest("[data-toc-band]"))
            ) {
              return;
            }
            const half = canSelect
              ? railHalfAt(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                )
              : "messages";
            const picked = pickedBandRef.current;
            if (half === "topics") {
              if (!picked) return;
              notifyThreadTocBandClick(picked, extensionInput);
              jumpToSeq(picked.band.fromSeq);
              return;
            }
            const tickId = nearestTickId(rootElement, event.clientY);
            if (tickId) void handleSelect(tickId);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          className="no-scrollbar flex max-h-[calc(100vh-7rem)] w-8 cursor-pointer select-none flex-col items-center gap-2 overflow-y-auto rounded-full py-2"
          style={
            canSelect && railHalf
              ? {
                  backgroundImage: railHalfTint(railHalf),
                }
              : undefined
          }
        >
          <span
            aria-hidden
            className={cn(
              "relative flex w-full flex-col items-center gap-2",
              railBands.length > 0 && "pr-3",
            )}
          >
            {railItems.map((item, tickIndex) => {
              const emphasized =
                highlightedTicks.has(tickIndex) || item.id === railHoverId;
              const selected =
                railSelection !== null &&
                item.messageSeq >= railSelection.fromSeq &&
                item.messageSeq <= railSelection.toSeq;
              return (
                <span
                  key={item.id}
                  data-toc-tick=""
                  data-toc-tick-id={item.id}
                  data-selected={selected ? "" : undefined}
                  className={cn(
                    "h-[3px] shrink-0 rounded-full transition-all duration-150 motion-reduce:transition-none",
                    selected
                      ? "w-5 bg-foreground/70"
                      : emphasized
                        ? "w-5 bg-foreground/50"
                        : item.id === activeUserId
                          ? "w-5 bg-foreground/30 group-hover/toc:bg-foreground/70"
                          : "w-3 bg-foreground/5 group-hover/toc:bg-foreground/20",
                  )}
                />
              );
            })}
            {railBands.length > 0 ? (
              <span
                className="absolute inset-y-0 right-0 grid w-3 gap-y-2"
                style={{ gridTemplateRows: `repeat(${railItems.length}, 3px)` }}
              >
                {railBands.map(({ entry, range, lane, highlighted }, index) => (
                  <span
                    key={`${entry.slot.pluginId}/${entry.slot.id}/${index}`}
                    data-toc-band=""
                    data-rows={`${range.start + 1} / ${range.end + 2}`}
                    data-lane={lane}
                    data-dashed={entry.band.dashed ? "true" : undefined}
                    data-active={entry.band.active ? "true" : undefined}
                    data-highlighted={highlighted ? "true" : undefined}
                    title={entry.band.label}
                    onPointerEnter={() => setPickedBand(entry)}
                    onPointerLeave={(event) => {
                      const rail = event.currentTarget.closest("button");
                      if (
                        event.relatedTarget instanceof Node &&
                        rail?.contains(event.relatedTarget)
                      ) {
                        return;
                      }
                      setPickedBand(null);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      notifyThreadTocBandClick(entry, extensionInput);
                      jumpToSeq(entry.band.fromSeq);
                    }}
                    className="pointer-events-auto relative cursor-pointer rounded-full transition-all duration-150 motion-reduce:transition-none"
                    style={{
                      gridRow: `${range.start + 1} / ${range.end + 2}`,
                      gridColumn: 1,
                      marginLeft: lane * TOC_BAND_LANE_PITCH_PX,
                      width: entry.band.active || highlighted ? 3 : 2,
                      ...(entry.band.dashed
                        ? {
                            backgroundImage: `repeating-linear-gradient(to bottom, ${bandColor(entry.band.hue)} 0 3px, transparent 3px 6px)`,
                          }
                        : { backgroundColor: bandColor(entry.band.hue) }),
                      ...(entry.band.active || highlighted
                        ? {
                            boxShadow: `0 0 6px ${bandColor(entry.band.hue, 0.8)}`,
                          }
                        : {}),
                    }}
                  />
                ))}
              </span>
            ) : null}
          </span>
        </button>

        {panelOpen ? (
          <div
            id={`thread-toc-panel-${threadId}`}
            onPointerEnter={() => {
              clearHalfTimer();
              setPickedBand(null);
            }}
            className="pointer-events-auto absolute right-full top-0 w-[18.25rem] max-w-[calc(100vw-3rem)] pr-1"
          >
            <div
              data-toc-view={extensionTab ? "topics" : "messages"}
              className="rounded-lg border border-border bg-popover p-1 shadow-lg"
            >
              {extensionTab && canSelect ? null : (
              <div className="flex items-center gap-1 pb-1">
                {hasAgentMessages ? (
                  <TocPanelTab
                    label="Agent messages"
                    active={extensionTab === null && activeTab === "agent"}
                    onSelect={() => setTab("agent")}
                  />
                ) : null}
                <TocPanelTab
                  label="Your messages"
                  active={extensionTab === null && activeTab === "user"}
                  onSelect={() => setTab("user")}
                />
              </div>
              )}
              {extensionTab ? (
                <div
                  key={extensionTab.key}
                  ref={extScrollRef}
                  className="max-h-64 overflow-y-auto overflow-x-hidden motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
                >
                  <ThreadTocTabMount
                    slot={extensionTab.slot}
                    threadId={threadId}
                    projectId={projectId}
                    jumpToSeq={jumpToSeq}
                    railSelection={railSelection}
                    clearRailSelection={clearRailSelection}
                    activeSeq={activeSeq}
                    hoveredBand={pointerBand}
                    setHoveredRange={setHoveredRange}
                    openTab={(id) =>
                      openExtensionTab(extensionTab.slot.pluginId, id)
                    }
                  />
                </div>
              ) : (
                <div className="relative isolate motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
                  <div
                    ref={scrollRef}
                    className="max-h-64 overflow-y-auto overflow-x-hidden"
                  >
                    <div
                      ref={topSentinelRef}
                      aria-hidden
                      className="h-px w-full"
                    />
                    <ul className="flex flex-col">
                      {items.map((item) => {
                        const active = item.id === activeId;
                        const pending = item.id === pendingJumpId;
                        const hovered = item.id === railHoverId;
                        return (
                          <li key={item.id}>
                            <button
                              ref={(node) => {
                                if (node) itemEls.current.set(item.id, node);
                                else itemEls.current.delete(item.id);
                              }}
                              type="button"
                              aria-busy={pending}
                              onClick={() => {
                                void handleSelect(item.id);
                              }}
                              className={cn(
                                "flex w-full cursor-pointer rounded-md px-2 py-1.5 text-left transition-colors",
                                active || hovered
                                  ? "bg-state-hover"
                                  : "hover:bg-state-hover",
                              )}
                            >
                              <span
                                className={cn(
                                  "text-xs leading-snug",
                                  active || hovered
                                    ? "text-foreground"
                                    : "text-muted-foreground",
                                  pending && "animate-pulse",
                                )}
                              >
                                <TocItemPreview
                                  item={item}
                                  senderThreadMetadataById={
                                    senderThreadMetadataById
                                  }
                                />
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div
                      ref={bottomSentinelRef}
                      aria-hidden
                      className="h-px w-full"
                    />
                  </div>
                  {aboveOverflow ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-popover/90 via-popover/60 to-transparent"
                    />
                  ) : null}
                  {belowOverflow ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-popover/90 via-popover/60 to-transparent"
                    />
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
