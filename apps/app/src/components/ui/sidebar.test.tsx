// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { memo, startTransition, useState } from "react";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@sandy/shared-ui/hooks/use-compact-viewport";
import {
  Sidebar,
  SidebarCollapsibleBody,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useIsSidebarFramed,
  useIsSidebarShowing,
  useOptionalIsSidebarShowing,
  useSidebar,
  useSidebarKeepsCollapsedRail,
} from "./sidebar";
import { buildBridgeInjectionScript } from "@sandy/mobile-bridge";
import { resetNativeShellForTests } from "@/lib/native-shell/native-shell";

function installNativeShell() {
  Object.defineProperty(window, "ReactNativeWebView", {
    configurable: true,
    value: { postMessage: () => {} },
  });
  // eslint-disable-next-line no-new-func
  new Function(
    "window",
    buildBridgeInjectionScript({
      bridgeVersion: 2,
      appVersion: "0.46.1",
      platform: "ios",
      profileMode: "direct",
      secureContext: true,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      capabilities: [],
      nativeDownloads: true,
    }),
  )(window);
  resetNativeShellForTests();
}

function uninstallNativeShell() {
  Reflect.deleteProperty(window, "ReactNativeWebView");
  Reflect.deleteProperty(window, "sandy");
  resetNativeShellForTests();
}

afterEach(() => {
  uninstallNativeShell();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const MOBILE_TOGGLE_SETTLE_MS = 220;

function settleMobileToggle() {
  act(() => {
    vi.advanceTimersByTime(MOBILE_TOGGLE_SETTLE_MS);
  });
}

function createTouch(clientX: number, clientY: number, identifier = 1): Touch {
  return { identifier, clientX, clientY } as Touch;
}

function createTouchList(...touches: Touch[]): TouchList {
  const touchList = {
    length: touches.length,
    item: (index: number) => touches[index] ?? null,
  };
  touches.forEach((touch, index) => {
    Object.defineProperty(touchList, index, { value: touch });
  });
  return touchList as unknown as TouchList;
}

function fireTouch(
  target: Element | Document | Window,
  type: "touchstart" | "touchmove",
  touch: Touch,
) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.defineProperties(event, {
    touches: { value: createTouchList(touch) },
    changedTouches: { value: createTouchList(touch) },
  });
  fireEvent(target, event);
}

function fireTouchEnd(target: Element | Document | Window, touch: Touch) {
  const event = new Event("touchend", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: createTouchList() },
    changedTouches: { value: createTouchList(touch) },
  });
  fireEvent(target, event);
}

function firePointer(
  target: Element | Document | Window,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
  pointerId = 1,
  isPrimary = true,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    isPrimary: { value: isPrimary },
    button: { value: 0 },
    buttons: { value: 1 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

function renderSelectableSwipeHarness() {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <SidebarProvider>
        <Sidebar>Sidebar content</Sidebar>
        <SidebarInset>
          <div data-sidebar-swipe-selectable>Selectable message prose</div>
        </SidebarInset>
      </SidebarProvider>
    </CompactViewportOverrideProvider>,
  );
}

function OptionalSidebarProbe() {
  const isShowing = useOptionalIsSidebarShowing();
  return <div data-sidebar-showing={String(isShowing)} />;
}

describe("useOptionalIsSidebarShowing", () => {
  it("returns null outside SidebarProvider instead of throwing", () => {
    expect(renderToString(<OptionalSidebarProbe />)).toContain(
      'data-sidebar-showing="null"',
    );
  });
});

describe("useIsSidebarShowing", () => {
  it("re-renders its reader only when the visible bit flips, not on every provider commit", () => {
    vi.useFakeTimers();
    const showingRenders: boolean[] = [];
    const ShowingReader = memo(function ShowingReader() {
      const isShowing = useIsSidebarShowing();
      showingRenders.push(isShowing);
      return <output data-testid="showing">{String(isShowing)}</output>;
    });
    function Controls() {
      const {
        openMobileSidebar,
        closeMobileSidebar,
        setSuppressMobileOpenAnimation,
      } = useSidebar();
      return (
        <>
          <button type="button" onClick={openMobileSidebar}>
            open
          </button>
          <button type="button" onClick={closeMobileSidebar}>
            close
          </button>
          <button
            type="button"
            onClick={() => setSuppressMobileOpenAnimation(true)}
          >
            suppress
          </button>
        </>
      );
    }
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <ShowingReader />
          <Controls />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );
    expect(screen.getByTestId("showing").textContent).toBe("false");
    const settled = showingRenders.length;

    fireEvent.click(screen.getByRole("button", { name: "suppress" }));
    expect(showingRenders).toHaveLength(settled);

    fireEvent.click(screen.getByRole("button", { name: "open" }));
    settleMobileToggle();
    expect(screen.getByTestId("showing").textContent).toBe("true");
    const afterOpen = showingRenders.length;
    expect(afterOpen).toBe(settled + 1);

    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(showingRenders).toHaveLength(afterOpen);
    settleMobileToggle();
    expect(screen.getByTestId("showing").textContent).toBe("false");
    expect(showingRenders).toHaveLength(afterOpen + 1);
  });
});

function CollapsedRailProbe() {
  const keepsCollapsedRail = useSidebarKeepsCollapsedRail();
  const isShowing = useIsSidebarShowing();
  return (
    <output
      data-testid="collapsed-rail-probe"
      data-keeps-rail={String(keepsCollapsedRail)}
      data-showing={String(isShowing)}
    />
  );
}

function getDesktopSidebarParts(): {
  root: HTMLElement;
  gap: HTMLElement;
  panel: HTMLElement;
} {
  const gap = document.querySelector('[data-sidebar="gap"]');
  const panel = document.querySelector('[data-sidebar="panel"]');
  const root = gap?.parentElement;
  if (
    !(gap instanceof HTMLElement) ||
    !(panel instanceof HTMLElement) ||
    !(root instanceof HTMLElement)
  ) {
    throw new Error("Expected the desktop sidebar root, gap, and panel");
  }
  return { root, gap, panel };
}

describe("desktop collapsed rail", () => {
  it("collapses to the rail width instead of sliding off canvas", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider collapsedRailWidth="52px" defaultOpen>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarTrigger />
          <CollapsedRailProbe />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const { root, gap, panel } = getDesktopSidebarParts();
    const probe = screen.getByTestId("collapsed-rail-probe");
    expect(root.dataset.collapsible).toBe("");
    expect(probe.dataset.keepsRail).toBe("true");
    expect(probe.dataset.showing).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    expect(root.dataset.state).toBe("collapsed");
    expect(root.dataset.collapsible).toBe("rail");
    expect(probe.dataset.showing).toBe("false");
    for (const part of [gap, panel]) {
      expect(part.style.getPropertyValue("--sidebar-rail-width")).toBe("52px");
      expect(part.className).toContain(
        "group-data-[collapsible=rail]:w-(--sidebar-rail-width)",
      );
    }
  });

  it("parks the body beside the rail at its expanded width and takes it out of reach", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider collapsedRailWidth="52px" width="333px" defaultOpen>
          <Sidebar>
            <SidebarCollapsibleBody data-testid="body">
              <button type="button">Thread row</button>
            </SidebarCollapsibleBody>
          </Sidebar>
          <SidebarTrigger />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const body = screen.getByTestId("body");
    const content = screen.getByRole("button", {
      name: "Thread row",
    }).parentElement;
    expect(body.hasAttribute("inert")).toBe(false);
    expect(content?.style.width).toBe("calc(281px)");

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    expect(body.hasAttribute("inert")).toBe(true);
    expect(content?.style.width).toBe("calc(281px)");
    expect(body.className).toContain("group-data-[collapsible=rail]:invisible");

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    expect(body.hasAttribute("inert")).toBe(false);
  });

  it("slides fully off canvas when no rail width is configured", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider defaultOpen={false}>
          <Sidebar>Sidebar content</Sidebar>
          <CollapsedRailProbe />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const { root, panel } = getDesktopSidebarParts();
    expect(root.dataset.collapsible).toBe("offcanvas");
    expect(panel.style.getPropertyValue("--sidebar-rail-width")).toBe("");
    expect(screen.getByTestId("collapsed-rail-probe").dataset.keepsRail).toBe(
      "false",
    );
  });

  it("drops the rail on compact viewports, where the drawer hides entirely", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider collapsedRailWidth="52px">
          <Sidebar>Sidebar content</Sidebar>
          <CollapsedRailProbe />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const probe = screen.getByTestId("collapsed-rail-probe");
    expect(probe.dataset.keepsRail).toBe("false");
    expect(probe.dataset.showing).toBe("false");
    expect(document.querySelector('[data-sidebar="gap"]')).toBeNull();
    expect(document.querySelector('[data-collapsible="rail"]')).toBeNull();
  });
});

function FramedProbe() {
  return (
    <output data-testid="framed-probe">{String(useIsSidebarFramed())}</output>
  );
}

describe("framed desktop sidebar", () => {
  it("rounds the leading card corner on whichever surface touches the rail", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider
          framed
          collapsedRailWidth="52px"
          data-testid="wrapper"
          defaultOpen
        >
          <Sidebar>
            <SidebarCollapsibleBody data-testid="body">
              Sidebar content
            </SidebarCollapsibleBody>
          </Sidebar>
          <SidebarInset data-testid="inset" />
          <SidebarTrigger />
          <FramedProbe />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const inset = screen.getByTestId("inset");
    const body = screen.getByTestId("body");
    expect(screen.getByTestId("framed-probe").textContent).toBe("true");
    expect(screen.getByTestId("wrapper").dataset.framed).toBe("");
    expect(
      screen
        .getByTestId("wrapper")
        .classList.contains("pl-(--sandy-window-frame-leading-lip)"),
    ).toBe(false);
    expect(
      screen
        .getByTestId("wrapper")
        .style.getPropertyValue("--sandy-window-card-collapsed-left"),
    ).toBe("52px");
    expect(body.classList.contains("rounded-tl-(--sandy-frame-card-radius)")).toBe(
      true,
    );
    expect(body.classList.contains("rounded-bl-(--sandy-frame-card-radius)")).toBe(
      true,
    );
    expect(
      inset.classList.contains("before:rounded-tl-(--sandy-frame-card-radius)"),
    ).toBe(false);
    expect(
      inset.classList.contains("before:rounded-bl-(--sandy-frame-card-radius)"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    expect(
      inset.classList.contains("before:rounded-tl-(--sandy-frame-card-radius)"),
    ).toBe(true);
    expect(
      inset.classList.contains("before:rounded-bl-(--sandy-frame-card-radius)"),
    ).toBe(true);
  });

  it("keeps a lip of window frame on both sides of and below the card", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider framed data-testid="wrapper">
          <Sidebar data-testid="panel">Sidebar content</Sidebar>
          <SidebarInset data-testid="inset" />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const wrapper = screen.getByTestId("wrapper");
    const inset = screen.getByTestId("inset");
    expect(wrapper.classList.contains("pr-(--sandy-window-frame-lip)")).toBe(true);
    expect(wrapper.classList.contains("pb-(--sandy-window-frame-lip)")).toBe(true);
    expect(
      wrapper.classList.contains("pl-(--sandy-window-frame-leading-lip)"),
    ).toBe(true);
    expect(
      wrapper.style.getPropertyValue("--sandy-window-card-collapsed-left"),
    ).toBe("var(--sandy-window-frame-leading-lip)");
    expect(screen.getByTestId("panel").className).toContain(
      "left-(--sandy-window-frame-leading-lip)",
    );
    expect(screen.getByTestId("panel").className).toContain(
      "var(--sandy-shell-height)_-_var(--sandy-window-frame-top)_-_var(--sandy-window-frame-lip)",
    );
    for (const edge of [
      "before:rounded-tr-(--sandy-frame-card-radius)",
      "before:rounded-br-(--sandy-frame-card-radius)",
      "before:border-r",
      "px-px",
      "pb-px",
    ]) {
      expect(inset.classList.contains(edge)).toBe(true);
    }
    expect(inset.classList.contains("-mt-(--sandy-window-title-bar-height)")).toBe(
      true,
    );
    expect(screen.getByTestId("window-title-bar-drag-region")).toBeTruthy();
  });

  it("leaves compact viewports and unframed sidebars as they were", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider framed data-testid="wrapper">
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset data-testid="inset" />
          <FramedProbe />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    expect(screen.getByTestId("framed-probe").textContent).toBe("false");
    expect(screen.getByTestId("wrapper").dataset.framed).toBeUndefined();
    expect(screen.getByTestId("inset").classList.contains("border-t")).toBe(
      false,
    );
  });
});

describe("SidebarTrigger", () => {
  it("uses the shared sidebar icon on every viewport", () => {
    const markup = renderToString(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(markup).toContain('data-icon="PanelLeft"');
    expect(markup).not.toContain('data-icon="AlignLeft"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain('aria-pressed="');
  });
});

describe("SidebarContent", () => {
  it("owns the sidebar surface used behind transparent and sticky rows", () => {
    render(<SidebarContent data-testid="content">Rows</SidebarContent>);

    expect(screen.getByTestId("content").classList).toContain("bg-sidebar");
  });

  it("publishes its scrollbar lane and keeps it current when the scrollbar style changes", () => {
    const observers: {
      callback: ResizeObserverCallback;
      instance: ResizeObserver;
      targets: Set<Element>;
    }[] = [];
    class StubResizeObserver {
      private readonly targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        observers.push({
          callback,
          instance: this as unknown as ResizeObserver,
          targets: this.targets,
        });
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(256);
    const clientWidth = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockReturnValue(246);

    render(<SidebarContent data-testid="content">Rows</SidebarContent>);
    const content = screen.getByTestId("content");
    expect(content.style.getPropertyValue("--sandy-sidebar-scrollbar-lane")).toBe(
      "10px",
    );

    clientWidth.mockReturnValue(256);
    act(() => {
      for (const { callback, instance, targets } of observers) {
        if (targets.has(content)) {
          callback([], instance);
        }
      }
    });
    expect(content.style.getPropertyValue("--sandy-sidebar-scrollbar-lane")).toBe(
      "0px",
    );
  });
});

function getMobilePanel(): HTMLElement | null {
  const panel = document.querySelector('[data-sidebar="panel"]');
  return panel instanceof HTMLElement ? panel : null;
}

const SHELF_OPEN_TRANSLATE = "360px";
const SHELF_CLOSED_TRANSLATE = "0px";

function getShelfRevealTranslate(): string {
  const backdrop = document.querySelector("[data-sidebar-mobile-backdrop]");
  return backdrop instanceof HTMLElement ? backdrop.style.translate : "";
}

function getShelfInsetTranslate(): string {
  const inset = document.querySelector('[data-sidebar="inset"]');
  return inset instanceof HTMLElement ? inset.style.translate : "";
}

const MOBILE_REALIZE_TIMEOUT_MS = 1000;

function settleMobileRealization() {
  act(() => {
    vi.advanceTimersByTime(MOBILE_REALIZE_TIMEOUT_MS);
  });
}

function renderCompactSidebarHarness() {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <SidebarProvider>
        <Sidebar>Sidebar content</Sidebar>
        <SidebarInset>
          <SidebarTrigger />
          Main content
        </SidebarInset>
      </SidebarProvider>
    </CompactViewportOverrideProvider>,
  );
}

describe("mobile sidebar deferred realization", () => {
  it("mounts the closed panel empty at boot and realizes it after the settle window", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();

    const closedPanel = getMobilePanel();
    expect(closedPanel).not.toBeNull();
    expect(closedPanel?.dataset.state).toBe("closed");
    expect(closedPanel?.hasAttribute("inert")).toBe(true);
    expect(closedPanel?.textContent).not.toContain("Sidebar content");

    settleMobileRealization();

    expect(getMobilePanel()).toBe(closedPanel);
    expect(closedPanel?.dataset.state).toBe("closed");
    expect(closedPanel?.textContent).toContain("Sidebar content");
  });

  it("prefers requestIdleCallback with a bounded timeout when available", () => {
    vi.useFakeTimers();
    let idleCallback: (() => void) | null = null;
    let idleTimeout: number | undefined;
    const cancelIdle = vi.fn();
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: (callback: () => void, options?: { timeout?: number }) => {
        idleCallback = callback;
        idleTimeout = options?.timeout;
        return 1;
      },
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: cancelIdle,
    });
    try {
      renderCompactSidebarHarness();
      expect(idleCallback).not.toBeNull();
      expect(idleTimeout).toBe(MOBILE_REALIZE_TIMEOUT_MS);
      expect(getMobilePanel()?.textContent).not.toContain("Sidebar content");

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(getMobilePanel()?.textContent).not.toContain("Sidebar content");

      act(() => {
        idleCallback?.();
      });
      expect(getMobilePanel()?.textContent).toContain("Sidebar content");
    } finally {
      Reflect.deleteProperty(window, "requestIdleCallback");
      Reflect.deleteProperty(window, "cancelIdleCallback");
    }
  });

  it("realizes the subtree at the start of a deferred open before idle", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    expect(getMobilePanel()?.textContent).not.toContain("Sidebar content");

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    const openingPanel = getMobilePanel();
    expect(openingPanel?.dataset.state).toBe("closed");
    expect(openingPanel?.textContent).toContain("Sidebar content");

    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(getMobilePanel()?.textContent).toContain("Sidebar content");

    fireEvent.click(screen.getByTestId("sidebar-mobile-backdrop"));
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(getMobilePanel()?.textContent).toContain("Sidebar content");
  });

  it("keeps the realize commit out of the open tap's synchronous flush", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });

    let panelStyledForSlideInTap = false;
    let realizedInTapFlush = true;
    act(() => {
      flushSync(() => {
        trigger.click();
      });
      const panel = getMobilePanel();
      panelStyledForSlideInTap =
        getShelfRevealTranslate() === SHELF_OPEN_TRANSLATE;
      realizedInTapFlush =
        panel?.textContent?.includes("Sidebar content") ?? false;
    });

    expect(panelStyledForSlideInTap).toBe(true);
    expect(realizedInTapFlush).toBe(false);
    expect(getMobilePanel()?.textContent).toContain("Sidebar content");

    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
  });

  it("writes the desktop width on the gap and panel, not on the provider wrapper", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider width="333px" data-testid="wrapper">
          <Sidebar>Sidebar content</Sidebar>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const wrapper = screen.getByTestId("wrapper");
    const gap = document.querySelector('[data-sidebar="gap"]');
    const panel = document.querySelector('[data-sidebar="panel"]');
    if (!(gap instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      throw new Error("Expected desktop gap and panel");
    }
    expect(gap.style.getPropertyValue("--sidebar-width")).toBe("333px");
    expect(panel.style.getPropertyValue("--sidebar-width")).toBe("333px");
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("");
  });

  it("renders the desktop sidebar subtree synchronously", () => {
    const markup = renderToString(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    expect(markup).toContain("Sidebar content");
  });
});

describe("mobile sidebar shelf stacking", () => {
  it("keeps the panel beneath the page and moves the page to reveal it", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    settleMobileRealization();

    const panel = getMobilePanel();
    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement) || panel === null) {
      throw new Error("Expected a compact panel and page inset");
    }

    expect(panel.className).toContain("z-0");
    expect(panel.className).toContain("data-[side=left]:border-r");
    expect(inset.className).toContain("max-md:z-30");
    expect(inset.className).toContain("motion-reduce:transition-none!");
    expect(inset.dataset.sidebarShelf).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();

    expect(inset.dataset.sidebarShelf).toBe("open");
    expect(getMobilePanel()?.style.translate).toBe("");
  });

  it("keeps the center pane square for both shelves", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    settleMobileRealization();

    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement)) {
      throw new Error("Expected a page inset");
    }

    expect(inset.className).not.toContain("data-[sidebar-shelf=open]:rounded");
    expect(inset.className).not.toContain("data-[panel-shelf=full]:rounded");
    expect(inset.className).not.toContain(
      "data-[sidebar-shelf=open]:overflow-hidden",
    );
    expect(inset.className).not.toContain(
      "data-[panel-shelf=full]:overflow-hidden",
    );
    expect(inset.className).not.toContain("data-[sidebar-shelf=open]:shadow");
    expect(inset.className).not.toContain("data-[panel-shelf=full]:shadow");
  });

  it("leaves the page untouched by the shelf on desktop", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>Main content</SidebarInset>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement)) {
      throw new Error("Expected a page inset");
    }
    expect(inset.dataset.sidebarShelf).toBeUndefined();
  });
});

describe("mobile sidebar persistence", () => {
  it("closes from an exposed-content swipe after committing the closed state", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();

    const panel = getMobilePanel();
    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement)) {
      throw new Error("Expected a page inset");
    }
    const shelfStatesAtDragStyleClear: string[] = [];
    const removeInsetAttribute = inset.removeAttribute.bind(inset);
    vi.spyOn(inset, "removeAttribute").mockImplementation((name) => {
      if (name === "data-vaul-animate") {
        shelfStatesAtDragStyleClear.push(
          inset.dataset.sidebarShelf ?? "missing",
        );
      }
      removeInsetAttribute(name);
    });
    expect(panel?.dataset.state).toBe("open");

    fireTouch(backdrop, "touchstart", createTouch(360, 160));
    fireTouch(window, "touchmove", createTouch(180, 164));
    fireTouchEnd(window, createTouch(180, 164));
    expect(inset.getAttribute("data-vaul-animate")).toBe("false");
    settleMobileToggle();

    expect(panel?.dataset.state).toBe("closed");
    expect(shelfStatesAtDragStyleClear).toEqual(["closed"]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
  });

  it("stays open when a drawer row gesture claims the swipe's touchmoves", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>
            <div data-testid="claimed-row">Dragged row</div>
          </Sidebar>
          <SidebarInset>
            <SidebarTrigger />
          </SidebarInset>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();
    settleMobileRealization();

    const panel = getMobilePanel();
    const row = screen.getByTestId("claimed-row");
    row.addEventListener("touchmove", (event) => event.preventDefault());

    fireTouch(row, "touchstart", createTouch(220, 160));
    fireTouch(row, "touchmove", createTouch(120, 164));
    fireTouch(row, "touchmove", createTouch(40, 168));
    fireTouchEnd(row, createTouch(40, 168));
    settleMobileToggle();

    expect(panel?.dataset.state).toBe("open");
  });

  it("ignores a closing swipe from the right browser edge", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();

    const panel = getMobilePanel();
    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    const startX = window.innerWidth - 12;

    fireTouch(backdrop, "touchstart", createTouch(startX, 160));
    fireTouch(window, "touchmove", createTouch(startX - 180, 164));
    fireTouchEnd(window, createTouch(startX - 180, 164));
    settleMobileToggle();

    expect(panel?.dataset.state).toBe("open");
  });

  it("keeps closed drawer content mounted, inert, and offscreen", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    settleMobileRealization();

    const closedPanel = getMobilePanel();
    expect(closedPanel).not.toBeNull();
    expect(closedPanel?.textContent).toContain("Sidebar content");
    expect(closedPanel?.dataset.state).toBe("closed");
    expect(closedPanel?.hasAttribute("inert")).toBe(true);
    expect(closedPanel?.className).not.toContain("invisible");

    const inset = document.querySelector('[data-sidebar="inset"]');
    expect(inset?.hasAttribute("inert")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    const openingPanel = getMobilePanel();
    expect(openingPanel?.dataset.state).toBe("closed");
    expect(getShelfInsetTranslate()).toBe(SHELF_OPEN_TRANSLATE);
    settleMobileToggle();

    const openPanel = getMobilePanel();
    expect(openPanel?.dataset.state).toBe("open");
    expect(openPanel?.hasAttribute("inert")).toBe(false);

    const panelParent = openPanel?.parentElement;
    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    for (const sibling of panelParent?.children ?? []) {
      expect(sibling.hasAttribute("inert")).toBe(false);
    }
    expect(inset?.hasAttribute("inert")).toBe(false);

    fireEvent.click(backdrop);
    const closingPanel = getMobilePanel();
    expect(closingPanel?.dataset.state).toBe("open");
    expect(getShelfInsetTranslate()).toBe(SHELF_CLOSED_TRANSLATE);

    settleMobileToggle();

    const reclosedPanel = getMobilePanel();
    expect(reclosedPanel?.dataset.state).toBe("closed");
    expect(reclosedPanel?.hasAttribute("inert")).toBe(true);
    expect(reclosedPanel?.textContent).toContain("Sidebar content");
    expect(inset?.hasAttribute("inert")).toBe(false);
  });

  it("blocks tap-through with the backdrop during the deferred open", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>
            <SidebarTrigger />
            Main content
          </SidebarInset>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(backdrop.style.pointerEvents).toBe("auto");

    fireEvent.click(backdrop);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(backdrop.style.pointerEvents).toBe("");

    fireEvent.click(backdrop);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(backdrop.style.pointerEvents).not.toBe("auto");
  });

  it("keeps the pinned trigger interactive and closes on a second press", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>Main content</SidebarInset>
          {}
          <div data-testid="trigger-overlay">
            <SidebarTrigger />
          </div>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const overlay = screen.getByTestId("trigger-overlay");

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(overlay.hasAttribute("inert")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(getShelfRevealTranslate()).toBe(SHELF_CLOSED_TRANSLATE);

    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(getMobilePanel()?.hasAttribute("inert")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
  });

  it("slides closed in the commit that shows the destination of a pending navigation", async () => {
    vi.useFakeTimers();
    let isDestinationReady = false;
    let resolveDestination = () => {};
    const destinationReady = new Promise<void>((resolve) => {
      resolveDestination = resolve;
    });
    function Destination() {
      if (!isDestinationReady) throw destinationReady;
      return <p>Destination</p>;
    }
    function NavigationHarness() {
      const { closeMobileSidebar } = useSidebar();
      const [route, setRoute] = useState<"origin" | "destination">("origin");
      return (
        <>
          <Sidebar>
            <button
              type="button"
              onClick={() => {
                closeMobileSidebar();
                startTransition(() => {
                  setRoute("destination");
                });
              }}
            >
              Open destination
            </button>
          </Sidebar>
          <SidebarInset>
            <SidebarTrigger />
            {route === "origin" ? <p>Origin</p> : <Destination />}
          </SidebarInset>
        </>
      );
    }
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <NavigationHarness />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();
    fireEvent.click(screen.getByRole("button", { name: "Open destination" }));

    expect(screen.getByText("Origin")).toBeTruthy();
    expect(getShelfRevealTranslate()).not.toBe(SHELF_CLOSED_TRANSLATE);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");

    isDestinationReady = true;
    await act(async () => {
      resolveDestination();
      await destinationReady;
    });

    expect(screen.getByText("Destination")).toBeTruthy();
    expect(getShelfRevealTranslate()).toBe(SHELF_CLOSED_TRANSLATE);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });

  it("traps Tab between the trigger and the open drawer", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>
            <button type="button">Sidebar row</button>
          </Sidebar>
          <SidebarInset>
            <button type="button">Inset action</button>
          </SidebarInset>
          <div data-testid="trigger-overlay">
            <SidebarTrigger />
          </div>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const insetAction = screen.getByRole("button", { name: "Inset action" });

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    const row = screen.getByRole("button", { name: "Sidebar row" });

    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "Tab" });
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(row);

    act(() => insetAction.focus());
    fireEvent.keyDown(insetAction, { key: "Tab" });
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus only when a focus-visible trigger opens the drawer", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>
            <SidebarTrigger />
            Main content
          </SidebarInset>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const panel = getMobilePanel();
    if (!panel) throw new Error("Expected mobile sidebar panel");
    const focusSpy = vi.spyOn(panel, "focus");

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(focusSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sidebar-mobile-backdrop"));
    settleMobileToggle();
    trigger.focus();
    const matches = trigger.matches.bind(trigger);
    vi.spyOn(trigger, "matches").mockImplementation((selector) =>
      selector === '[data-sidebar="trigger"]:focus-visible'
        ? true
        : matches(selector),
    );
    fireEvent.click(trigger);
    settleMobileToggle();

    expect(focusSpy).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(panel);
  });
});

describe("mobile sidebar does not open from a swipe", () => {
  it.each([
    ["from the screen edge", 40],
    ["deep in the content", 120],
  ])("stays closed after a rightward touch swipe %s", (_label, startX) => {
    vi.useFakeTimers();
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");
    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement)) {
      throw new Error("Expected a page inset");
    }

    fireTouch(prose, "touchstart", createTouch(startX, 160));
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperties(move, {
      touches: { value: createTouchList(createTouch(startX + 250, 162)) },
      changedTouches: { value: createTouchList(createTouch(startX + 250, 162)) },
    });
    fireEvent(window, move);
    expect(inset.style.translate).toBe("");
    expect(move.defaultPrevented).toBe(false);
    fireTouchEnd(window, createTouch(startX + 250, 162));
    vi.advanceTimersByTime(500);

    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(inset.style.translate).toBe("");
  });

  it("stays closed after a rightward pointer swipe", () => {
    vi.useFakeTimers();
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");

    firePointer(prose, "pointerdown", 40, 160);
    firePointer(window, "pointermove", 160, 161);
    firePointer(window, "pointermove", 300, 162);
    firePointer(window, "pointerup", 300, 162);
    vi.advanceTimersByTime(500);

    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });

  it("stays closed after an edge swipe inside the native shell", () => {
    vi.useFakeTimers();
    installNativeShell();
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");

    fireTouch(prose, "touchstart", createTouch(4, 160));
    fireTouch(window, "touchmove", createTouch(150, 161));
    fireTouch(window, "touchmove", createTouch(300, 162));
    fireTouchEnd(window, createTouch(300, 162));
    vi.advanceTimersByTime(500);

    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });

  it("stays closed after a horizontal trackpad swipe", () => {
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");

    for (let step = 0; step < 5; step += 1) {
      const wheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: -60,
        clientX: 120,
        clientY: 160,
      });
      fireEvent(prose, wheel);
      expect(wheel.defaultPrevented).toBe(false);
    }

    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });
});
