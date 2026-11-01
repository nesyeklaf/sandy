// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ThreadListEntry, ThreadWithRuntime } from "@sandy/domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  ThreadConversationOutlineItem,
  ThreadConversationOutlineResponse,
  SidebarBootstrapResponse,
  TimelineConversationRow,
  TimelineRow,
} from "@sandy/server-contract";
import { commandRow } from "@/test/fixtures/thread-timeline-rows";

vi.mock("@/components/ui/bottom-anchored-scroll-body.js", () => ({
  useBottomAnchoredScroll: vi.fn(),
}));

vi.mock("@/hooks/queries/thread-panel-queries", () => ({
  useThreadConversationOutline: vi.fn(),
}));

import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useThreadConversationOutline } from "@/hooks/queries/thread-panel-queries";
import {
  sidebarNavigationQueryKey,
  threadListQueryKey,
} from "@/hooks/queries/query-keys";
import type {
  ExperimentalThreadTocBand,
  ExperimentalThreadTocInput,
  ExperimentalThreadTocTabProps,
} from "@sandy-sdk/plugin-sdk";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  findActiveItemIds,
  selectTocRailItems,
  ThreadTableOfContents,
  type TocItem,
} from "./ThreadTableOfContents";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@sandy/test-helpers/domain-fixtures";
import { makeThreadWithRuntime as makeThreadWithRuntimeFixture } from "@sandy/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { createInertScrollPositionKeeper } from "@/test/scroll-position-keeper";

class ResizeObserverMock implements ResizeObserver {
  static readonly instances = new Set<ResizeObserverMock>();
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.add(this);
  }

  static resizeAll() {
    for (const observer of ResizeObserverMock.instances) {
      for (const target of observer.targets) observer.deliver(target);
    }
  }

  observe: ResizeObserver["observe"] = (target) => {
    this.targets.add(target);
    this.deliver(target);
  };

  private deliver(target: Element) {
    const element = target as HTMLElement;
    const paddingX =
      (Number.parseFloat(element.style.paddingLeft) || 0) +
      (Number.parseFloat(element.style.paddingRight) || 0);
    const inlineSize = Math.max(0, element.clientWidth - paddingX);
    this.callback(
      [
        {
          target,
          contentBoxSize: [{ inlineSize, blockSize: 0 }],
          contentRect: { width: inlineSize } as DOMRectReadOnly,
        } as unknown as ResizeObserverEntry,
      ],
      this,
    );
  }
  unobserve: ResizeObserver["unobserve"] = vi.fn();
  disconnect: ResizeObserver["disconnect"] = vi.fn();
}

function userConversationRow(index = 1): TimelineConversationRow {
  return {
    id: `row_user_${index}`,
    threadId: "thr_toc_test",
    turnId: `turn_${index}`,
    sourceSeqStart: index,
    sourceSeqEnd: index,
    messageSeq: index,
    startedAt: index,
    createdAt: index,
    kind: "conversation",
    role: "user",
    text: `Loaded after client-side navigation ${index}`,
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      isGrouped: false,
      kind: "message",
      status: "accepted",
    },
    mentions: [],
  };
}

function TocHost({
  contextBoundarySeq = null,
  hasOlderTimelineRows = false,
  hostPaddingX = 0,
  hostWidth = 1_200,
  loadOlderTimelineRows = () => {},
  onNavigateToRow,
  projectId = "proj_toc_test",
  threadId = "thr_toc_test",
  timelineRows,
}: {
  contextBoundarySeq?: number | null;
  hasOlderTimelineRows?: boolean;
  hostPaddingX?: number;
  hostWidth?: number;
  loadOlderTimelineRows?: () => void | Promise<void>;
  onNavigateToRow?: (rowId: string) => void;
  projectId?: string;
  threadId?: string;
  timelineRows: readonly TimelineRow[];
}) {
  return (
    <div
      ref={(node) => {
        if (!node) return;
        Object.defineProperty(node, "clientWidth", {
          configurable: true,
          value: hostWidth,
        });
      }}
      data-scroll-overlay=""
      style={{
        paddingLeft: `${hostPaddingX}px`,
        paddingRight: `${hostPaddingX}px`,
      }}
    >
      <ThreadTableOfContents
        contextBoundarySeq={contextBoundarySeq}
        threadId={threadId}
        projectId={projectId}
        timelineRows={timelineRows}
        hasOlderTimelineRows={hasOlderTimelineRows}
        loadOlderTimelineRows={loadOlderTimelineRows}
        onNavigateToRow={onNavigateToRow}
      />
    </div>
  );
}

function rect({ bottom, top }: { bottom: number; top: number }): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    toJSON: () => ({}),
    top,
    width: 100,
    x: 0,
    y: top,
  };
}

function createScrollElement({
  clientHeight,
  rows,
  scrollHeight,
  scrollTop,
}: {
  clientHeight: number;
  rows: ReadonlyArray<{ id: string; bottom: number; top: number }>;
  scrollHeight: number;
  scrollTop: number;
}): HTMLElement {
  const scrollElement = document.createElement("div");
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(scrollElement, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(scrollElement, "scrollTop", {
    configurable: true,
    value: scrollTop,
  });
  scrollElement.getBoundingClientRect = () =>
    rect({ bottom: clientHeight, top: 0 });

  for (const row of rows) {
    const rowElement = document.createElement("div");
    rowElement.dataset.timelineRowId = row.id;
    rowElement.getBoundingClientRect = vi.fn(() =>
      rect({ bottom: row.bottom, top: row.top }),
    );
    scrollElement.append(rowElement);
  }

  return scrollElement;
}

function outlineResponse(
  items: ThreadConversationOutlineItem[],
): ThreadConversationOutlineResponse {
  return { items, maxSeq: items.length };
}

function setOutline(
  items: ThreadConversationOutlineItem[] | undefined,
  maxSeq = items?.length ?? 0,
): void {
  vi.mocked(useThreadConversationOutline).mockImplementation(
    (_threadId, role) =>
      ({
        data:
          items === undefined
            ? undefined
            : {
                ...outlineResponse(items.filter((item) => item.role === role)),
                maxSeq,
              },
      }) as ReturnType<typeof useThreadConversationOutline>,
  );
}

function lastOutlineOptions(role: "user" | "assistant") {
  return vi
    .mocked(useThreadConversationOutline)
    .mock.calls.filter(([, callRole]) => callRole === role)
    .at(-1)?.[2];
}

function timelineRowElement(id: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-timeline-row-id", id);
  return el;
}

function threadWithRuntime(
  thread: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return makeThreadWithRuntimeFixture({
    id: "thr_worker",
    projectId: "proj_toc",
    environmentId: "env_toc",
    title: null,
    titleFallback: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "idle",
    },
    ...thread,
  });
}

function threadListEntry(
  thread: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntryFixture({
    ...threadWithRuntime(),
    environmentHostId: "host_toc",
    environmentName: "ToC environment",
    environmentBranchName: "main",
    ...thread,
  });
}

function sidebarNavigation(
  threads: ThreadListEntry[],
): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "proj_toc",
        name: "ToC project",
        createdAt: 1,
        updatedAt: 1,
        threads,
      }),
    ],
  });
}

const userItems: TocItem[] = [
  { id: "user-1", label: "First prompt", role: "user", messageSeq: 0 },
  { id: "user-2", label: "Second prompt", role: "user", messageSeq: 0 },
];

const agentItems: TocItem[] = [
  { id: "agent-1", label: "First response", role: "assistant", messageSeq: 0 },
  { id: "agent-2", label: "Second response", role: "assistant", messageSeq: 0 },
];

function manyUserItems(count: number): TocItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `user-${index + 1}`,
    label: `Question ${index + 1}`,
    role: "user",
    messageSeq: index + 1,
  }));
}

let scrollElement: HTMLElement;
let scrollElementIntoView: ReturnType<typeof vi.fn>;

function openTocPanel(): void {
  const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
  if (!toc) throw new Error("Expected the thread table of contents.");
  fireEvent.mouseEnter(toc);
}

beforeEach(() => {
  ResizeObserverMock.instances.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  scrollElement = document.createElement("div");
  scrollElementIntoView = vi.fn();
  vi.mocked(useBottomAnchoredScroll).mockReturnValue({
    getScrollElement: () => scrollElement,
    isAtBottom: false,
    scrollToBottom: vi.fn(),
    scrollElementIntoView,
    positionKeeper: createInertScrollPositionKeeper(),
    holdContentPosition: vi.fn(),
  } as unknown as ReturnType<typeof useBottomAnchoredScroll>);

  setOutline(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("selectTocRailItems", () => {
  it("caps long thread rails to evenly sampled markers", () => {
    const items = manyUserItems(50);

    const railItems = selectTocRailItems({ activeId: null, items });

    expect(railItems).toHaveLength(20);
    expect(railItems.at(0)?.id).toBe("user-1");
    expect(railItems.at(-1)?.id).toBe("user-50");
    expect(railItems.map((item) => item.id)).not.toEqual(
      items.slice(0, 20).map((item) => item.id),
    );
  });

  it("keeps the active marker when the rail is capped", () => {
    const items = manyUserItems(50);

    const railItems = selectTocRailItems({
      activeId: "user-20",
      items,
    });

    expect(railItems).toHaveLength(20);
    expect(railItems.map((item) => item.id)).toContain("user-20");
  });
});

describe("ThreadTableOfContents", () => {
  it("does not restore an outline cached before the current context boundary", async () => {
    setOutline(
      [1, 2, 3].map((index) => ({
        id: `old-${index}`,
        role: "user" as const,
        preview: `Old message ${index}`,
        attachmentSummary: null,
        messageSeq: 0,
      })),
      5,
    );

    render(
      <TocHost
        contextBoundarySeq={10}
        timelineRows={[
          userConversationRow(10),
          userConversationRow(11),
          userConversationRow(12),
        ]}
      />,
    );
    openTocPanel();

    expect(await screen.findByText("Your messages")).not.toBeNull();
    expect(screen.queryByText("Old message 1")).toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 10"),
    ).not.toBeNull();
  });

  it("defers the full outline request until the latest timeline is available", () => {
    const view = render(<TocHost timelineRows={[]} />);

    expect(lastOutlineOptions("user")).toEqual({ enabled: false });

    view.rerender(<TocHost timelineRows={[userConversationRow(1)]} />);

    expect(lastOutlineOptions("user")).toEqual({ enabled: true });
  });

  it("requests agent previews only once the Agent tab is chosen", () => {
    setOutline([
      ...[1, 2, 3].map((index) => ({
        id: `u${index}`,
        role: "user" as const,
        preview: `Question ${index}`,
        attachmentSummary: null,
        messageSeq: 0,
      })),
      {
        id: "a1",
        role: "assistant",
        preview: "Agent answer",
        attachmentSummary: null,
        messageSeq: 0,
      },
    ]);
    render(<TocHost timelineRows={[userConversationRow(1)]} />);

    expect(lastOutlineOptions("user")).toEqual({ enabled: true });
    expect(lastOutlineOptions("assistant")).toEqual({ enabled: false });

    openTocPanel();
    expect(lastOutlineOptions("assistant")).toEqual({ enabled: false });

    fireEvent.click(screen.getByText("Agent messages"));
    expect(lastOutlineOptions("assistant")).toEqual({ enabled: true });
    expect(screen.getByText("Agent answer")).not.toBeNull();
  });

  it("keeps the active agent message in view when agent previews arrive", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const agentRow: TimelineConversationRow = {
      id: "row_agent_4",
      threadId: "thr_toc_test",
      turnId: "turn_4",
      sourceSeqStart: 4,
      sourceSeqEnd: 4,
      messageSeq: 4,
      startedAt: 4,
      createdAt: 4,
      kind: "conversation",
      role: "assistant",
      text: "Latest agent answer",
      attachments: null,
      turnRequest: null,
    };
    const rows = [1, 2, 3].map(userConversationRow).concat(agentRow);
    scrollElement = createScrollElement({
      clientHeight: 400,
      scrollHeight: 400,
      scrollTop: 0,
      rows: [
        { id: "row_user_1", top: 10, bottom: 30 },
        { id: "row_user_2", top: 60, bottom: 80 },
        { id: "row_user_3", top: 110, bottom: 130 },
        { id: "row_agent_4", top: 160, bottom: 180 },
      ],
    });
    let agentPreviewsReady = false;
    vi.mocked(useThreadConversationOutline).mockImplementation(
      (_threadId, role) =>
        ({
          data:
            role === "assistant" && !agentPreviewsReady
              ? undefined
              : outlineResponse(
                  role === "assistant"
                    ? [1, 2, 3].map((index) => ({
                        id: `earlier_agent_${index}`,
                        role: "assistant" as const,
                        preview: `Earlier agent answer ${index}`,
                        attachmentSummary: null,
                        messageSeq: 0,
                      }))
                    : [],
                ),
        }) as ReturnType<typeof useThreadConversationOutline>,
    );

    try {
      const view = render(<TocHost timelineRows={rows} />);
      openTocPanel();
      fireEvent.click(screen.getByText("Agent messages"));
      await waitFor(() => {
        expect(scrollTo).toHaveBeenCalled();
      });
      const callsBeforePreviews = scrollTo.mock.calls.length;

      agentPreviewsReady = true;
      view.rerender(<TocHost timelineRows={rows} />);

      expect(await screen.findByText("Earlier agent answer 1")).not.toBeNull();
      await waitFor(() => {
        expect(scrollTo.mock.calls.length).toBeGreaterThan(callsBeforePreviews);
      });
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });

  it("does not request the hidden outline in a compact thread pane", () => {
    render(<TocHost hostWidth={400} timelineRows={[userConversationRow(1)]} />);

    expect(lastOutlineOptions("user")).toEqual({ enabled: false });
  });

  it("does not request the outline when padding hides the TOC", () => {
    render(
      <TocHost
        hostPaddingX={12}
        hostWidth={900}
        timelineRows={[userConversationRow(1)]}
      />,
    );

    expect(lastOutlineOptions("user")).toEqual({ enabled: false });
  });

  it("requests the outline once the padded content box reaches the breakpoint", () => {
    render(
      <TocHost
        hostPaddingX={12}
        hostWidth={920}
        timelineRows={[userConversationRow(1)]}
      />,
    );

    expect(lastOutlineOptions("user")).toEqual({ enabled: true });
  });

  it("keeps the rail mounted but hidden while the pane is too narrow", () => {
    const rows = [
      userConversationRow(1),
      userConversationRow(2),
      userConversationRow(3),
    ];
    const view = render(<TocHost hostWidth={1_200} timelineRows={rows} />);
    const rail = screen.getByRole("button", {
      name: "Thread table of contents",
    });
    const wrapper = rail.parentElement!;
    expect(wrapper.hasAttribute("inert")).toBe(false);

    view.rerender(<TocHost hostWidth={400} timelineRows={rows} />);
    act(() => ResizeObserverMock.resizeAll());

    expect(rail.isConnected).toBe(true);
    expect(wrapper.classList.contains("hidden")).toBe(true);
    expect(wrapper.hasAttribute("inert")).toBe(true);

    view.rerender(<TocHost hostWidth={1_200} timelineRows={rows} />);
    act(() => ResizeObserverMock.resizeAll());

    expect(rail.isConnected).toBe(true);
    expect(wrapper.classList.contains("hidden")).toBe(false);
    expect(wrapper.hasAttribute("inert")).toBe(false);
  });

  it("shows after timeline rows arrive following an empty initial render", async () => {
    const view = render(<TocHost timelineRows={[]} />);

    expect(screen.queryByText("Your messages")).toBeNull();

    view.rerender(
      <TocHost
        timelineRows={[
          userConversationRow(1),
          userConversationRow(2),
          userConversationRow(3),
        ]}
      />,
    );
    openTocPanel();

    expect(await screen.findByText("Your messages")).not.toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 1"),
    ).not.toBeNull();
  });

  it("stays hidden until there are at least three user messages", () => {
    const view = render(
      <TocHost
        timelineRows={[userConversationRow(1), userConversationRow(2)]}
      />,
    );

    expect(screen.queryByText("Your messages")).toBeNull();

    view.rerender(
      <TocHost
        timelineRows={[
          userConversationRow(1),
          userConversationRow(2),
          userConversationRow(3),
        ]}
      />,
    );
    openTocPanel();

    expect(screen.queryByText("Your messages")).not.toBeNull();
  });

  it("measures fresh geometry only after scrolling settles", () => {
    vi.useFakeTimers();
    const rows = [
      userConversationRow(1),
      userConversationRow(2),
      userConversationRow(3),
    ];
    const rowElements = rows.map((row) => {
      const element = timelineRowElement(row.id);
      scrollElement.append(element);
      return element;
    });
    const positions = [
      { top: 0, bottom: 20 },
      { top: 100, bottom: 120 },
      { top: 200, bottom: 220 },
    ];
    rowElements.forEach((element, index) => {
      element.getBoundingClientRect = vi.fn(() => rect(positions[index]!));
    });
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 400 },
    });
    scrollElement.getBoundingClientRect = () => rect({ top: 0, bottom: 100 });

    render(<TocHost timelineRows={rows} />);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });

    const railTicks = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-thread-toc] [aria-hidden] > span",
        ),
      );
    expect(railTicks()[0]?.classList.contains("w-5")).toBe(true);

    act(() => {
      positions[0] = { top: -30, bottom: -10 };
      positions[1] = { top: 0, bottom: 20 };
      fireEvent.scroll(scrollElement);
      vi.advanceTimersByTime(119);
    });
    expect(railTicks()[0]?.classList.contains("w-5")).toBe(true);
    expect(railTicks()[1]?.classList.contains("w-5")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(railTicks()[0]?.classList.contains("w-5")).toBe(false);
    expect(railTicks()[1]?.classList.contains("w-5")).toBe(true);
  });

  it("opens consistently from pointer and keyboard activation and preserves focus", () => {
    render(
      <TocHost
        timelineRows={[
          userConversationRow(1),
          userConversationRow(2),
          userConversationRow(3),
        ]}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Thread table of contents",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Your messages")).toBeNull();

    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    fireEvent.mouseEnter(toc);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(toc);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Your messages")).not.toBeNull();

    const firstMessage = screen.getByRole("button", {
      name: "Loaded after client-side navigation 1",
    });
    act(() => firstMessage.focus());
    fireEvent.mouseLeave(toc);

    expect(document.activeElement).toBe(firstMessage);
    expect(screen.getByText("Your messages")).not.toBeNull();
  });

  it("closes on mouse leave after a mouse click left focus on a row", () => {
    render(
      <TocHost
        timelineRows={[
          userConversationRow(1),
          userConversationRow(2),
          userConversationRow(3),
        ]}
      />,
    );
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    const trigger = screen.getByRole("button", {
      name: "Thread table of contents",
    });
    fireEvent.mouseEnter(toc);
    const row = screen.getByRole("button", {
      name: "Loaded after client-side navigation 1",
    });
    fireEvent.pointerDown(row);
    act(() => row.focus());
    fireEvent.click(row);
    fireEvent.mouseLeave(toc);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when a pointer goes down outside the rail, even while the pointer still counts as inside", () => {
    render(<TocHost timelineRows={[userConversationRow(1), userConversationRow(2), userConversationRow(3)]} />);
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    const trigger = screen.getByRole("button", { name: "Thread table of contents" });
    fireEvent.mouseEnter(toc);
    act(() => trigger.focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("highlights and centers the message nearest the pointer while it moves along the rail", () => {
    {
      render(<TocHost timelineRows={Array.from({ length: 6 }, (_, index) => userConversationRow(index + 1))} />);
      const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
      if (!toc) throw new Error("Expected the thread table of contents.");
      const trigger = screen.getByRole("button", { name: "Thread table of contents" });
      const ticks = Array.from(toc.querySelectorAll<HTMLElement>("[data-toc-tick]"));
      ticks.forEach((tick, index) => {
        tick.getBoundingClientRect = () => rect({ top: index * 10, bottom: index * 10 + 3 });
      });
      fireEvent.mouseEnter(toc);
      const target = ticks[1]?.dataset.tocTickId;
      expect(target).toBeTruthy();
      fireEvent.pointerMove(trigger, { clientX: 5, clientY: 11 });
      const rows = screen.getAllByRole("button", { name: /Loaded after client-side navigation/ });
      const hovered = rows.filter((row) => row.className.includes("bg-state-hover") && !row.className.includes("hover:bg-state-hover"));
      expect(hovered.some((row) => row.textContent?.includes("navigation 2"))).toBe(true);
    }
  });

  it("jumps to the message nearest the pointer when the rail is clicked", () => {
    const onNavigateToRow = vi.fn();
    render(
      <TocHost
        onNavigateToRow={onNavigateToRow}
        timelineRows={Array.from({ length: 6 }, (_, index) => userConversationRow(index + 1))}
      />,
    );
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    const trigger = screen.getByRole("button", { name: "Thread table of contents" });
    const ticks = Array.from(toc.querySelectorAll<HTMLElement>("[data-toc-tick]"));
    ticks.forEach((tick, index) => {
      tick.getBoundingClientRect = () => rect({ top: index * 10, bottom: index * 10 + 3 });
    });
    fireEvent.pointerUp(trigger, { button: 0, clientX: 5, clientY: 21, pointerId: 1 });
    expect(onNavigateToRow).toHaveBeenCalledWith(ticks[2]?.dataset.tocTickId);
  });

  it("scrolls the message list when the wheel turns over the popover padding", () => {
    render(<TocHost timelineRows={Array.from({ length: 30 }, (_, index) => userConversationRow(index + 1))} />);
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    fireEvent.mouseEnter(toc);
    const row = screen.getByRole("button", { name: "Loaded after client-side navigation 1" });
    const scroller = row.closest<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("Expected the list scroller.");
    scroller.scrollTop = 0;
    const panel = document.querySelector<HTMLElement>("[id^=thread-toc-panel-]");
    if (!panel) throw new Error("Expected the panel.");
    fireEvent.wheel(panel, { deltaY: 120 });
    expect(scroller.scrollTop).toBe(120);
  });

  it("tracks overflow when an initially closed panel opens and reopens", () => {
    render(
      <TocHost
        timelineRows={Array.from({ length: 30 }, (_, index) =>
          userConversationRow(index + 1),
        )}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Thread table of contents",
    });
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]");
    if (!toc) throw new Error("Expected the thread table of contents.");
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      }),
    );
    const flushAnimationFrames = () => {
      act(() => {
        for (const callback of animationFrames.splice(0)) callback(0);
      });
    };

    const openAndOverflow = () => {
      fireEvent.click(trigger);
      const scrollRegion = document.querySelector<HTMLElement>(
        '[id^="thread-toc-panel-"] .max-h-64',
      );
      if (!scrollRegion) throw new Error("Expected the TOC scroll region.");
      Object.defineProperties(scrollRegion, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 500 },
        scrollTop: { configurable: true, writable: true, value: 0 },
      });
      flushAnimationFrames();
      expect(
        document.querySelector('[class*="bg-gradient-to-t"]'),
      ).not.toBeNull();

      scrollRegion.scrollTop = 400;
      fireEvent.scroll(scrollRegion);
      flushAnimationFrames();
      expect(
        document.querySelector('[class*="bg-gradient-to-b"]'),
      ).not.toBeNull();
      expect(document.querySelector('[class*="bg-gradient-to-t"]')).toBeNull();
    };

    openAndOverflow();
    fireEvent.mouseLeave(toc);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    openAndOverflow();
  });

  it("renders the full conversation outline, including attachment-only labels", async () => {
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "a1",
        role: "assistant",
        preview: "First answer",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u2",
        role: "user",
        preview: "Second question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u3",
        role: "user",
        preview: "",
        attachmentSummary: { imageCount: 1, fileCount: 0 },
        messageSeq: 2,
      },
    ]);

    render(<TocHost timelineRows={[]} />);
    openTocPanel();

    expect(await screen.findByText("First question")).not.toBeNull();
    expect(screen.getByText("Second question")).not.toBeNull();
    expect(screen.getByText("Image attachment")).not.toBeNull();
    expect(screen.getByText("Agent messages")).not.toBeNull();
  });

  it("merges live timeline messages into the cached full outline", async () => {
    setOutline([
      {
        id: "row_user_1",
        role: "user",
        preview: "First cached question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "row_user_2",
        role: "user",
        preview: "Second cached question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "row_user_3",
        role: "user",
        preview: "Stale third question",
        attachmentSummary: null,
        messageSeq: 0,
      },
    ]);

    render(
      <TocHost
        timelineRows={[userConversationRow(3), userConversationRow(4)]}
      />,
    );
    openTocPanel();

    expect(await screen.findByText("First cached question")).not.toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 3"),
    ).not.toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 4"),
    ).not.toBeNull();
    expect(screen.queryByText("Stale third question")).toBeNull();
  });

  it("renders an agent-to-agent message source as a thread mention", async () => {
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u2",
        role: "user",
        preview:
          "[sandy message from thread:thr_worker] Release bug report: the calendar is stale.",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
        messageSeq: 0,
      },
    ]);

    render(<TocHost timelineRows={[]} />);
    openTocPanel();

    expect(await screen.findByText("Agent")).not.toBeNull();
    expect(
      screen.getByText("Release bug report: the calendar is stale."),
    ).not.toBeNull();
    expect(
      screen.queryByText(/\[sandy message from thread:thr_worker\]/),
    ).toBeNull();
  });

  it("uses and refreshes a sender title with a nested thread mention", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const nestedThread = threadListEntry({
      id: "thr_nested",
      title: "Calendar specialist",
    });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      sidebarNavigation([
        threadListEntry({ title: "Ask @thread:thr_nested" }),
        nestedThread,
      ]),
    );
    queryClient.setQueryData(threadListQueryKey({ archived: false }), [
      threadListEntry({ title: "Ask @thread:thr_nested" }),
      nestedThread,
    ]);
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u2",
        role: "user",
        preview:
          "[sandy message from thread:thr_worker] Release bug report: the calendar is stale.",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
        messageSeq: 0,
      },
    ]);

    render(
      <QueryClientProvider client={queryClient}>
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map([[nestedThread.id, nestedThread]])}
        >
          <TocHost timelineRows={[]} />
        </ThreadTitleMentionResourcesProvider>
      </QueryClientProvider>,
    );
    openTocPanel();

    expect(await screen.findByText("Ask Calendar specialist")).not.toBeNull();
    expect(screen.queryByText("@thread:thr_nested")).toBeNull();

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      sidebarNavigation([
        threadListEntry({ title: "Updated @thread:thr_nested" }),
        nestedThread,
      ]),
    );

    expect(
      await screen.findByText("Updated Calendar specialist"),
    ).not.toBeNull();
  });

  it("scrolls straight to a message already loaded in the window", async () => {
    const target = timelineRowElement("u2");
    scrollElement.appendChild(target);
    const loadOlder = vi.fn();
    const onNavigateToRow = vi.fn();
    setOutline([
      {
        id: "u1",
        role: "user",
        preview: "First question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u2",
        role: "user",
        preview: "Loaded question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
        messageSeq: 0,
      },
    ]);

    render(
      <TocHost
        timelineRows={[]}
        hasOlderTimelineRows
        loadOlderTimelineRows={loadOlder}
        onNavigateToRow={onNavigateToRow}
      />,
    );
    openTocPanel();
    fireEvent.click(await screen.findByText("Loaded question"));

    await waitFor(() => expect(scrollElementIntoView).toHaveBeenCalledTimes(1));
    expect(target.classList.contains("sandy-search-flash")).toBe(true);
    expect(onNavigateToRow).toHaveBeenCalledWith("u2");
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("waits for a loaded but unmounted message to render instead of paginating", async () => {
    const loadOlder = vi.fn();
    const onNavigateToRow = vi.fn((rowId: string) => {
      queueMicrotask(() => {
        scrollElement.appendChild(timelineRowElement(rowId));
      });
    });
    const timelineRows = [1, 2, 3].map((index) => userConversationRow(index));

    render(
      <TocHost
        timelineRows={timelineRows}
        hasOlderTimelineRows
        loadOlderTimelineRows={loadOlder}
        onNavigateToRow={onNavigateToRow}
      />,
    );
    openTocPanel();
    fireEvent.click(
      await screen.findByText("Loaded after client-side navigation 1"),
    );

    await waitFor(() =>
      expect(scrollElementIntoView).toHaveBeenCalledWith({
        element: scrollElement.querySelector(
          '[data-timeline-row-id="row_user_1"]',
        ),
        options: { block: "start", inline: "nearest" },
      }),
    );
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("auto-paginates older pages to reach an unloaded message, then scrolls to it", async () => {
    const loadOlder = vi.fn(() => {
      scrollElement.appendChild(timelineRowElement("u_old"));
    });
    setOutline([
      {
        id: "u_old",
        role: "user",
        preview: "Ancient question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u2",
        role: "user",
        preview: "Second question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
        messageSeq: 0,
      },
    ]);

    render(
      <TocHost
        timelineRows={[]}
        hasOlderTimelineRows
        loadOlderTimelineRows={loadOlder}
      />,
    );
    openTocPanel();
    fireEvent.click(await screen.findByText("Ancient question"));

    await waitFor(() => expect(loadOlder).toHaveBeenCalled());
    await waitFor(() => expect(scrollElementIntoView).toHaveBeenCalled());
  });

  it("does not paginate when there are no older pages to load", async () => {
    const loadOlder = vi.fn();
    setOutline([
      {
        id: "missing",
        role: "user",
        preview: "Unreachable",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u2",
        role: "user",
        preview: "Second question",
        attachmentSummary: null,
        messageSeq: 0,
      },
      {
        id: "u3",
        role: "user",
        preview: "Third question",
        attachmentSummary: null,
        messageSeq: 0,
      },
    ]);

    render(
      <TocHost
        timelineRows={[]}
        hasOlderTimelineRows={false}
        loadOlderTimelineRows={loadOlder}
      />,
    );
    openTocPanel();
    fireEvent.click(await screen.findByText("Unreachable"));

    await waitFor(() => expect(loadOlder).not.toHaveBeenCalled());
    expect(scrollElementIntoView).not.toHaveBeenCalled();
  });

  it("tracks the conversation item nearest the viewport top away from bottom", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 400,
      rows: [
        { id: "user-1", top: 10, bottom: 30 },
        { id: "agent-1", top: 35, bottom: 55 },
        { id: "user-2", top: 80, bottom: 100 },
        { id: "agent-2", top: 105, bottom: 125 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-1",
        user: "user-1",
      },
    );
  });

  it("ignores conversation items above the viewport", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 400,
      rows: [
        { id: "user-1", top: -30, bottom: -10 },
        { id: "agent-1", top: -8, bottom: -1 },
        { id: "user-2", top: 30, bottom: 50 },
        { id: "agent-2", top: 60, bottom: 80 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-2",
        user: "user-2",
      },
    );
  });

  it("tracks the latest visible conversation item at the bottom", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 900,
      rows: [
        { id: "user-1", top: 10, bottom: 30 },
        { id: "agent-1", top: 35, bottom: 55 },
        { id: "user-2", top: 80, bottom: 100 },
        { id: "agent-2", top: 90, bottom: 110 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-2",
        user: "user-2",
      },
    );
  });

  it("does not mark a role active at the bottom when that role is offscreen", () => {
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 1_000,
      scrollTop: 900,
      rows: [
        { id: "user-1", top: -120, bottom: -80 },
        { id: "user-2", top: -60, bottom: -20 },
        { id: "agent-2", top: 20, bottom: 90 },
      ],
    });

    expect(findActiveItemIds({ agentItems, scrollElement, userItems })).toEqual(
      {
        agent: "agent-2",
        user: null,
      },
    );
  });

  it("finds active items with logarithmic row measurements", () => {
    const allItems = Array.from(
      { length: 256 },
      (_, index): TocItem => ({
        id: `item-${index}`,
        label: `Message ${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        messageSeq: index,
      }),
    );
    const manyUserItems = allItems.filter((item) => item.role === "user");
    const manyAgentItems = allItems.filter((item) => item.role === "assistant");
    const visibleIndex = 200;
    const scrollElement = createScrollElement({
      clientHeight: 100,
      scrollHeight: 3_000,
      scrollTop: 400,
      rows: allItems.map((item, index) => {
        const top = (index - visibleIndex) * 10;
        return { id: item.id, top, bottom: top + 10 };
      }),
    });

    expect(
      findActiveItemIds({
        agentItems: manyAgentItems,
        scrollElement,
        userItems: manyUserItems,
      }),
    ).toEqual({
      agent: "item-201",
      user: "item-200",
    });
    const rowMeasurementCount = Array.from(
      scrollElement.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
    ).reduce(
      (count, row) =>
        count + vi.mocked(row.getBoundingClientRect).mock.calls.length,
      0,
    );
    expect(rowMeasurementCount).toBeLessThanOrEqual(16);
  });
});

function withCountedTextReads(
  row: TimelineConversationRow,
  onRead: () => void,
): TimelineConversationRow {
  const { text } = row;
  const counted = { ...row };
  Object.defineProperty(counted, "text", {
    enumerable: true,
    get: () => {
      onRead();
      return text;
    },
  });
  return counted;
}

function placeRowElements(
  positions: ReadonlyMap<string, { bottom: number; top: number }>,
): void {
  for (const [id, position] of positions) {
    const element =
      scrollElement.querySelector<HTMLElement>(
        `[data-timeline-row-id="${id}"]`,
      ) ?? scrollElement.appendChild(timelineRowElement(id));
    element.getBoundingClientRect = () => rect(position);
  }
}

function activeRailTickIndexes(): number[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-thread-toc] [aria-hidden] > span",
    ),
  ).flatMap((tick, index) => (tick.classList.contains("w-5") ? [index] : []));
}

describe("ThreadTableOfContents timeline item cache", () => {
  it("normalizes a message label again only when its row object changes", () => {
    let textReads = 0;
    const countRead = () => {
      textReads += 1;
    };
    const conversationRows = [1, 2, 3].map((index) =>
      withCountedTextReads(userConversationRow(index), countRead),
    );
    const view = render(<TocHost timelineRows={conversationRows} />);
    const readsAfterMount = textReads;

    expect(readsAfterMount).toBe(3);

    view.rerender(
      <TocHost
        timelineRows={[
          ...conversationRows,
          commandRow({
            command: "pnpm test",
            seq: 4,
            threadId: "thr_toc_test",
          }),
        ]}
      />,
    );

    expect(textReads).toBe(readsAfterMount);

    const streamedRow = withCountedTextReads(
      {
        ...userConversationRow(2),
        sourceSeqEnd: 3,
        text: "Loaded   after\n client-side navigation, then more",
      },
      countRead,
    );
    const attachmentOnlyRow = withCountedTextReads(
      {
        ...userConversationRow(3),
        attachments: {
          imageUrls: [],
          localFilePaths: [],
          localFileDetails: [],
          localFiles: 0,
          localImagePaths: ["/tmp/screenshot.png"],
          localImages: 1,
          webImages: 0,
        },
        sourceSeqEnd: 4,
        text: " \n ",
      },
      countRead,
    );
    view.rerender(
      <TocHost
        timelineRows={[conversationRows[0]!, streamedRow, attachmentOnlyRow]}
      />,
    );
    openTocPanel();

    expect(textReads).toBe(readsAfterMount + 2);
    expect(
      screen.getByText("Loaded after client-side navigation, then more", {
        normalizer: (text) => text,
      }),
    ).not.toBeNull();
    expect(screen.getByText("Image attachment")).not.toBeNull();
  });

  it("re-measures the active item 120 ms after an update that only changes work rows", async () => {
    vi.useFakeTimers();
    scrollElement = createScrollElement({
      clientHeight: 100,
      rows: [
        { id: "row_user_1", top: -200, bottom: -180 },
        { id: "row_user_2", top: 80, bottom: 120 },
        { id: "row_user_3", top: 300, bottom: 320 },
      ],
      scrollHeight: 1_000,
      scrollTop: 400,
    });
    const rows = [1, 2, 3].map((index) => userConversationRow(index));
    const workRow = commandRow({
      command: "pnpm test",
      output: "running",
      seq: 2,
      status: "pending",
      threadId: "thr_toc_test",
    });
    const view = render(
      <TocHost timelineRows={[rows[0]!, workRow, rows[1]!, rows[2]!]} />,
    );
    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(activeRailTickIndexes()).toEqual([1]);

    placeRowElements(
      new Map([
        ["row_user_2", { top: 130, bottom: 170 }],
        ["row_user_3", { top: 350, bottom: 370 }],
      ]),
    );
    view.rerender(
      <TocHost
        timelineRows={[
          rows[0]!,
          { ...workRow, output: "running\nmore output" },
          rows[1]!,
          rows[2]!,
        ]}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(119);
    });

    expect(activeRailTickIndexes()).toEqual([1]);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(activeRailTickIndexes()).toEqual([]);
  });
});

describe("ThreadTableOfContents plugin extension", () => {
  const PLUGIN_ID = "demo";
  let tabProps: ExperimentalThreadTocTabProps | null;
  let bands: readonly ExperimentalThreadTocBand[];
  let onBandClick: Mock<
    (band: ExperimentalThreadTocBand, input: ExperimentalThreadTocInput) => void
  >;
  let tickRects: number[];

  function TabComponent(props: ExperimentalThreadTocTabProps) {
    useEffect(() => {
      tabProps = props;
    });
    return <div data-testid="topics-tab">Topics content</div>;
  }

  function register({
    withTab = true,
    isDefault,
    onBandHover,
  }: {
    withTab?: boolean;
    isDefault?: boolean;
    onBandHover?: Mock<
      (
        band: ExperimentalThreadTocBand | null,
        input: ExperimentalThreadTocInput,
      ) => void
    >;
  } = {}) {
    setPluginSlotRegistrations(
      PLUGIN_ID,
      makePluginRegistrationSet({
        threadTocExtensions: [
          {
            id: "topics",
            title: "Topics",
            useBands: () => bands,
            onBandClick,
            ...(onBandHover ? { onBandHover } : {}),
            ...(withTab
              ? {
                  tab: {
                    label: "Topics",
                    component: TabComponent,
                    ...(isDefault === undefined
                      ? {}
                      : { experimental_default: isDefault }),
                  },
                }
              : {}),
          },
        ],
      }),
    );
  }

  function rows(seqs: readonly number[]): TimelineConversationRow[] {
    return seqs.map((seq) => userConversationRow(seq));
  }

  function bandElements(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-toc-band]"),
    );
  }

  function ticks(): HTMLElement[] {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-toc-tick]"),
    );
    elements.forEach((element, index) => {
      const top = tickRects[index] ?? index * 11;
      element.getBoundingClientRect = () => rect({ top, bottom: top + 3 });
    });
    return elements;
  }

  function trigger(): HTMLElement {
    const element = screen.getByRole("button", {
      name: "Thread table of contents",
    });
    element.getBoundingClientRect = () => rect({ top: 0, bottom: 200 });
    return element;
  }

  async function hoverHalf(half: "messages" | "topics") {
    fireEvent.pointerMove(trigger(), {
      clientX: half === "topics" ? 75 : 25,
      clientY: 5,
      pointerId: 1,
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
  }

  function dragFromTo(from: number, to: number) {
    const elements = ticks();
    const start = elements[from]!.getBoundingClientRect().top + 1;
    const end = elements[to]!.getBoundingClientRect().top + 1;
    fireEvent.pointerDown(trigger(), {
      clientY: start,
      pointerId: 1,
      button: 0,
    });
    fireEvent.pointerMove(trigger(), {
      clientY: (start + end) / 2,
      pointerId: 1,
    });
    fireEvent.pointerMove(trigger(), { clientY: end, pointerId: 1 });
    fireEvent.pointerUp(trigger(), { clientY: end, pointerId: 1 });
  }

  beforeEach(() => {
    tabProps = null;
    bands = [];
    tickRects = [];
    onBandClick = vi.fn();
  });

  afterEach(() => {
    removePluginSlotRegistrations(PLUGIN_ID);
    resetAllCrashedPluginSlotsForTest();
  });

  it("renders no brackets, tab or selection state without a registered slot", () => {
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();

    expect(bandElements()).toHaveLength(0);
    expect(document.querySelectorAll("[data-toc-tick]")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Topics" })).toBeNull();
  });

  it("draws one bracket per band across the ticks whose message seq is in range", () => {
    bands = [
      { fromSeq: 2, toSeq: 4, hue: 200, label: "Topic A" },
      { fromSeq: 3, toSeq: 3, hue: 20, dashed: true },
      { fromSeq: 1, toSeq: 1, hue: 90, active: true },
    ];
    register();
    render(<TocHost timelineRows={rows([1, 2, 3, 4, 5])} />);

    const [a, b, c] = bandElements();
    expect(bandElements()).toHaveLength(3);
    expect(a?.dataset.rows).toBe("2 / 5");
    expect(a?.getAttribute("title")).toBe("Topic A");
    expect(a?.dataset.dashed).toBeUndefined();
    expect(b?.dataset.rows).toBe("3 / 4");
    expect(b?.dataset.dashed).toBe("true");
    expect(c?.dataset.rows).toBe("1 / 2");
    expect(c?.dataset.active).toBe("true");
    expect(a?.dataset.lane).toBe("0");
    expect(b?.dataset.lane).toBe("1");
    expect(c?.dataset.lane).toBe("0");
  });

  it("snaps a range that holds no tick to the next tick, or the last one", () => {
    bands = [
      { fromSeq: 4, toSeq: 4, hue: 10 },
      { fromSeq: 8, toSeq: 9, hue: 10 },
    ];
    register();
    render(<TocHost timelineRows={rows([1, 3, 5, 7])} />);

    const [between, after] = bandElements();
    expect(between?.dataset.rows).toBe("3 / 4");
    expect(after?.dataset.rows).toBe("4 / 5");
  });

  it("reports a bracket click to the extension without opening a jump", () => {
    const band = { fromSeq: 2, toSeq: 3, hue: 120 };
    bands = [band];
    register();
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);

    fireEvent.click(bandElements()[0]!);

    expect(onBandClick).toHaveBeenCalledWith(band, {
      threadId: "thr_toc_test",
      projectId: "proj_toc_test",
    });
  });

  it("shows the extension tab while the pointer is on the right half and passes it the rail props", async () => {
    register();
    const onNavigateToRow = vi.fn();
    render(
      <TocHost
        onNavigateToRow={onNavigateToRow}
        timelineRows={rows([1, 2, 3, 4])}
      />,
    );
    openTocPanel();

    await hoverHalf("topics");

    expect(screen.getByTestId("topics-tab")).not.toBeNull();
    expect(
      screen.queryByText("Loaded after client-side navigation 1"),
    ).toBeNull();
    expect(tabProps).toMatchObject({
      threadId: "thr_toc_test",
      projectId: "proj_toc_test",
      railSelection: null,
    });

    act(() => tabProps?.jumpToSeq(3));
    expect(onNavigateToRow).toHaveBeenCalledWith("row_user_3");

    await hoverHalf("messages");
    expect(screen.queryByTestId("topics-tab")).toBeNull();
    expect(screen.getByText("Your messages")).not.toBeNull();
  });

  it("jumps to the nearest user message at or before a seq that is not loaded as a row", async () => {
    register();
    const onNavigateToRow = vi.fn();
    const items = [1, 3, 5].map((seq) => ({
      id: `row_user_${seq}`,
      role: "user" as const,
      preview: `Q ${seq}`,
      attachmentSummary: null,
      messageSeq: seq,
    }));
    setOutline(items, 9);
    render(
      <TocHost onNavigateToRow={onNavigateToRow} timelineRows={rows([5])} />,
    );
    openTocPanel();
    await hoverHalf("topics");

    act(() => tabProps?.jumpToSeq(4));

    expect(onNavigateToRow).toHaveBeenCalledWith("row_user_3");
  });

  it("selects a range by dragging along the ticks and keeps the panel open", () => {
    register();
    render(<TocHost timelineRows={rows([1, 2, 3, 4, 5])} />);

    dragFromTo(1, 2);

    expect(screen.getByTestId("topics-tab")).not.toBeNull();
    expect(tabProps?.railSelection).toEqual({ fromSeq: 2, toSeq: 3 });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    const toc = document.querySelector<HTMLElement>("[data-thread-toc]")!;
    fireEvent.mouseLeave(toc);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("extends the last tick's selection to the newest message", () => {
    register();
    setOutline(
      [1, 2, 3].map((seq) => ({
        id: `row_user_${seq}`,
        role: "user" as const,
        preview: `Q ${seq}`,
        attachmentSummary: null,
        messageSeq: seq,
      })),
      9,
    );
    render(<TocHost timelineRows={rows([1, 2, 3])} />);

    dragFromTo(2, 1);

    expect(tabProps?.railSelection).toEqual({ fromSeq: 2, toSeq: 9 });
  });

  it("keeps a plain click free of any selection", () => {
    register();
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    const elements = ticks();
    const y = elements[1]!.getBoundingClientRect().top + 1;

    fireEvent.pointerDown(trigger(), { clientY: y, pointerId: 1, button: 0 });
    fireEvent.pointerUp(trigger(), { clientY: y, pointerId: 1 });
    fireEvent.click(trigger());

    expect(tabProps).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]")!;
    fireEvent.mouseLeave(toc);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("clears the selection on Escape and through clearRailSelection", () => {
    register();
    render(<TocHost timelineRows={rows([1, 2, 3, 4, 5])} />);

    dragFromTo(0, 1);
    expect(tabProps?.railSelection).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    act(() => tabProps?.clearRailSelection());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-selected]")).toBeNull();

    dragFromTo(0, 1);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-selected]")).toBeNull();
  });

  it("does not select by drag when no extension offers a tab", () => {
    register({ withTab: false });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);

    dragFromTo(0, 2);

    expect(tabProps).toBeNull();
    expect(document.querySelector("[data-toc-tick][data-selected]")).toBeNull();
  });

  it("opens on the Your messages tab unless a tab asks to be the default", () => {
    register({ isDefault: false });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();

    expect(screen.queryByTestId("topics-tab")).toBeNull();
    expect(
      screen.getByText("Loaded after client-side navigation 1"),
    ).not.toBeNull();
  });

  it("opens on a default extension tab and lets the pointer half decide the view", async () => {
    register({ isDefault: true });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();

    expect(screen.getByTestId("topics-tab")).not.toBeNull();
    expect(
      screen.queryByText("Loaded after client-side navigation 1"),
    ).toBeNull();

    await hoverHalf("messages");
    expect(screen.queryByTestId("topics-tab")).toBeNull();
    await hoverHalf("topics");
    expect(screen.getByTestId("topics-tab")).not.toBeNull();

    await hoverHalf("messages");
    const toc = document.querySelector<HTMLElement>("[data-thread-toc]")!;
    fireEvent.mouseLeave(toc);
    openTocPanel();
    expect(screen.getByTestId("topics-tab")).not.toBeNull();
  });

  it("picks the topic nearest to the pointer in the topic half without aiming at its line", () => {
    const near = { fromSeq: 1, toSeq: 1, hue: 10 };
    const far = { fromSeq: 4, toSeq: 4, hue: 120 };
    bands = [near, far];
    const onBandHover = vi.fn();
    register({ isDefault: true, onBandHover });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();
    const elements = ticks();
    const at = (index: number) => elements[index]!.getBoundingClientRect().top + 1;

    fireEvent.pointerMove(trigger(), { clientX: 75, clientY: at(0), pointerId: 1 });
    expect(tabProps?.hoveredBand).toEqual({ fromSeq: 1, toSeq: 1 });

    fireEvent.pointerMove(trigger(), { clientX: 75, clientY: at(2), pointerId: 1 });
    expect(tabProps?.hoveredBand).toEqual({ fromSeq: 4, toSeq: 4 });
    expect(onBandHover).toHaveBeenLastCalledWith(far, expect.anything());

    fireEvent.pointerDown(trigger(), { clientX: 75, clientY: at(2), pointerId: 1, button: 0 });
    fireEvent.pointerUp(trigger(), { clientX: 75, clientY: at(2), pointerId: 1, button: 0 });
    expect(onBandClick).toHaveBeenCalledWith(far, expect.anything());

    fireEvent.pointerMove(trigger(), { clientX: 25, clientY: at(0), pointerId: 1 });
    expect(tabProps?.hoveredBand ?? null).toBeNull();
  });

  it("keeps the view while the pointer stays inside one half", async () => {
    register({ isDefault: true });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();

    await hoverHalf("messages");
    fireEvent.pointerMove(trigger(), { clientX: 10, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(trigger(), { clientX: 45, clientY: 60, pointerId: 1 });
    expect(screen.queryByTestId("topics-tab")).toBeNull();
    expect(trigger().getAttribute("data-rail-half")).toBe("messages");

    await hoverHalf("topics");
    expect(trigger().getAttribute("data-rail-half")).toBe("topics");
    expect(screen.getByTestId("topics-tab")).not.toBeNull();
  });

  it("keeps the topic view when the pointer only crosses the message half on its way to the panel", async () => {
    register({ isDefault: true });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();
    await hoverHalf("topics");

    fireEvent.pointerMove(trigger(), { clientX: 25, clientY: 5, pointerId: 1 });
    const panel = document.querySelector<HTMLElement>(
      '[id^="thread-toc-panel-"]',
    )!;
    fireEvent.pointerEnter(panel);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    });

    expect(screen.getByTestId("topics-tab")).not.toBeNull();
    expect(trigger().getAttribute("data-rail-half")).toBe("topics");
  });

  it("lets the first default registration win", () => {
    function SecondTab() {
      return <div data-testid="second-tab">Second</div>;
    }
    setPluginSlotRegistrations(
      PLUGIN_ID,
      makePluginRegistrationSet({
        threadTocExtensions: [
          {
            id: "first",
            title: "First",
            useBands: () => [],
            tab: {
              label: "First",
              component: TabComponent,
              experimental_default: true,
            },
          },
          {
            id: "second",
            title: "Second",
            useBands: () => [],
            tab: {
              label: "Second",
              component: SecondTab,
              experimental_default: true,
            },
          },
        ],
      }),
    );
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();

    expect(screen.getByTestId("topics-tab")).not.toBeNull();
    expect(screen.queryByTestId("second-tab")).toBeNull();
  });

  function registerTopicsAndManage() {
    function ManageTab(props: ExperimentalThreadTocTabProps) {
      useEffect(() => {
        tabProps = props;
      });
      return <div data-testid="manage-tab">Manage content</div>;
    }
    setPluginSlotRegistrations(
      PLUGIN_ID,
      makePluginRegistrationSet({
        threadTocExtensions: [
          {
            id: "topics",
            title: "Topics",
            useBands: () => bands,
            tab: {
              label: "Topics",
              component: TabComponent,
              experimental_default: true,
            },
          },
          {
            id: "topics-manage",
            title: "Manage",
            useBands: () => [],
            tab: { label: "Manage", component: ManageTab },
          },
        ],
      }),
    );
  }

  it("shows no tab strip in the topic view and draws every registration's brackets", async () => {
    bands = [{ fromSeq: 2, toSeq: 3, hue: 120 }];
    registerTopicsAndManage();
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();

    const tabButtons = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("button[aria-pressed]"),
      ).map((button) => button.textContent);
    expect(tabButtons()).toEqual([]);
    expect(screen.getByTestId("topics-tab")).not.toBeNull();
    await hoverHalf("messages");
    expect(tabButtons()).toEqual(["Your messages"]);
    expect(bandElements()).toHaveLength(1);
  });

  it("opens another registration's tab of the same plugin with openTab", () => {
    registerTopicsAndManage();
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();
    expect(screen.queryByTestId("manage-tab")).toBeNull();

    act(() => tabProps?.openTab("topics-manage"));
    expect(screen.getByTestId("manage-tab")).not.toBeNull();
    expect(screen.queryByTestId("topics-tab")).toBeNull();

    act(() => tabProps?.openTab("topics"));
    expect(screen.getByTestId("topics-tab")).not.toBeNull();
  });

  it("ignores openTab for an id without a tab", () => {
    registerTopicsAndManage();
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();

    act(() => tabProps?.openTab("missing"));
    expect(screen.getByTestId("topics-tab")).not.toBeNull();
  });

  it("passes the seq of the active user message as activeSeq", async () => {
    vi.useFakeTimers();
    register({ isDefault: true });
    const userRows = rows([1, 2, 3, 4]);
    const [, second] = userRows;
    scrollElement.getBoundingClientRect = () => rect({ top: 0, bottom: 100 });
    for (const row of userRows) {
      const element = document.createElement("div");
      element.dataset.timelineRowId = row.id;
      element.getBoundingClientRect = () =>
        row.id === second?.id
          ? rect({ top: 10, bottom: 40 })
          : rect({ top: 500, bottom: 530 });
      scrollElement.appendChild(element);
    }
    render(<TocHost timelineRows={userRows} />);
    openTocPanel();
    expect(tabProps?.activeSeq).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(tabProps?.activeSeq).toBe(2);
  });

  it("reports the bracket under the pointer to the registration and the tab", () => {
    const band = { fromSeq: 2, toSeq: 3, hue: 120 };
    bands = [band, { fromSeq: 1, toSeq: 1, hue: 10 }];
    const onBandHover = vi.fn();
    register({ isDefault: true, onBandHover });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();
    expect(tabProps?.hoveredBand).toBeNull();

    fireEvent.pointerEnter(bandElements()[0]!);
    expect(onBandHover).toHaveBeenLastCalledWith(band, {
      threadId: "thr_toc_test",
      projectId: "proj_toc_test",
    });
    expect(tabProps?.hoveredBand).toEqual({ fromSeq: 2, toSeq: 3 });
    expect(bandElements()[0]?.dataset.highlighted).toBe("true");
    expect(bandElements()[1]?.dataset.highlighted).toBeUndefined();

    fireEvent.pointerLeave(bandElements()[0]!);
    expect(onBandHover).toHaveBeenLastCalledWith(null, {
      threadId: "thr_toc_test",
      projectId: "proj_toc_test",
    });
    expect(tabProps?.hoveredBand).toBeNull();
    expect(bandElements()[0]?.dataset.highlighted).toBeUndefined();
  });

  it("highlights the bracket and widens its ticks for a range the tab hovers", () => {
    bands = [
      { fromSeq: 2, toSeq: 3, hue: 120 },
      { fromSeq: 4, toSeq: 4, hue: 10 },
    ];
    register({ isDefault: true });
    render(<TocHost timelineRows={rows([1, 2, 3, 4, 5])} />);
    openTocPanel();
    const wide = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-toc-tick]"))
        .filter((tick) => tick.classList.contains("w-5"))
        .map((tick) => tick.dataset.tocTickId);

    act(() => tabProps?.setHoveredRange({ fromSeq: 2, toSeq: 3 }));
    expect(bandElements()[0]?.dataset.highlighted).toBe("true");
    expect(bandElements()[1]?.dataset.highlighted).toBeUndefined();
    expect(wide()).toEqual(["row_user_2", "row_user_3"]);

    act(() => tabProps?.setHoveredRange(null));
    expect(bandElements()[0]?.dataset.highlighted).toBeUndefined();
    expect(wide()).toEqual([]);
  });

  it("drops a hovered range when the panel closes", () => {
    bands = [{ fromSeq: 2, toSeq: 3, hue: 120 }];
    register({ isDefault: true });
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);
    openTocPanel();
    act(() => tabProps?.setHoveredRange({ fromSeq: 2, toSeq: 3 }));
    expect(bandElements()[0]?.dataset.highlighted).toBe("true");

    const toc = document.querySelector<HTMLElement>("[data-thread-toc]")!;
    fireEvent.mouseLeave(toc);

    expect(bandElements()[0]?.dataset.highlighted).toBeUndefined();
  });

  it("marks the selected ticks and drops animation under reduced motion", () => {
    bands = [{ fromSeq: 1, toSeq: 2, hue: 5, active: true }];
    register();
    render(<TocHost timelineRows={rows([1, 2, 3, 4])} />);

    dragFromTo(1, 2);

    const selected = Array.from(
      document.querySelectorAll<HTMLElement>("[data-toc-tick][data-selected]"),
    );
    expect(selected).toHaveLength(2);
    expect(bandElements()[0]?.className).toContain(
      "motion-reduce:transition-none",
    );
  });
});
