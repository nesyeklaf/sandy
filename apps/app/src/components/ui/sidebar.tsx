import * as React from "react";
import { flushSync } from "react-dom";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { Slot } from "@radix-ui/react-slot";

import { useIsCompactViewport } from "@sandy/shared-ui/hooks/use-compact-viewport";
import { cn } from "@sandy/shared-ui/lib/utils";
import { Button } from "@sandy/shared-ui/button";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@sandy/shared-ui/coarse-pointer-sizing";
import { Icon } from "@sandy/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@sandy/shared-ui/tooltip";
import { setCompactSidebarDrawerShowing } from "./sidebar-mobile-drawer-visibility.js";
import { usePanelShelfState } from "./secondary-panel-shelf-visibility.js";
import { useHorizontalDismissDrag } from "./use-horizontal-dismiss-drag.js";
import { MACOS_WINDOW_DRAG_CLASS } from "@/lib/sandy-desktop";

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_MOBILE_VIEWPORT_FRACTION = 0.86;
const SIDEBAR_MOBILE_MAX_WIDTH_PX = 360;
const SIDEBAR_WIDTH_MOBILE = `min(${SIDEBAR_MOBILE_VIEWPORT_FRACTION * 100}vw, ${SIDEBAR_MOBILE_MAX_WIDTH_PX}px)`;
const SIDEBAR_MOBILE_DRAG_SETTLE_MS = 220;
const SIDEBAR_MOBILE_REALIZE_TIMEOUT_MS = 1000;
const SIDEBAR_MOBILE_DRAG_SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const SIDEBAR_MOBILE_SHELF_SETTLE_TRANSITION = `translate ${SIDEBAR_MOBILE_DRAG_SETTLE_MS}ms ${SIDEBAR_MOBILE_DRAG_SETTLE_EASING}`;
const SIDEBAR_MOBILE_SHELF_BACKDROP_SETTLE_TRANSITION = `opacity ${SIDEBAR_MOBILE_DRAG_SETTLE_MS}ms ${SIDEBAR_MOBILE_DRAG_SETTLE_EASING}, translate ${SIDEBAR_MOBILE_DRAG_SETTLE_MS}ms ${SIDEBAR_MOBILE_DRAG_SETTLE_EASING}`;
const SIDEBAR_MOBILE_SHELF_INSET_TRANSITION_CLASS =
  "max-md:[transition:translate_220ms_cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none!";
const SIDEBAR_MOBILE_BACKDROP_TRANSITION_CLASS =
  "[transition:opacity_220ms_cubic-bezier(0.32,0.72,0,1),translate_220ms_cubic-bezier(0.32,0.72,0,1)]";

const SIDEBAR_FRAME_CLASS =
  "bg-sidebar bg-[linear-gradient(var(--surface-recessed),var(--surface-recessed))] pt-(--sandy-window-title-bar-height) pr-(--sandy-window-frame-lip) pb-(--sandy-window-frame-lip) [--sandy-window-frame-top:var(--sandy-window-title-bar-height)] [--sandy-window-frame-lip:var(--sandy-frame-window-lip)]";
const SIDEBAR_FRAME_LEADING_LIP_CLASS =
  "pl-(--sandy-window-frame-leading-lip) [--sandy-window-frame-leading-lip:var(--sandy-window-frame-lip)]";
const SIDEBAR_FRAMED_PANEL_CLASS =
  "group-data-[framed]/sidebar-wrapper:top-(--sandy-window-frame-top) group-data-[framed]/sidebar-wrapper:h-[calc(var(--sandy-shell-height)_-_var(--sandy-window-frame-top)_-_var(--sandy-window-frame-lip))] group-data-[framed]/sidebar-wrapper:border-r-0! group-data-[framed]/sidebar-wrapper:bg-transparent";
const SIDEBAR_FRAMED_CARD_EDGE_CLASS = "border-y border-l border-border";
const SIDEBAR_FRAMED_INSET_CLASS =
  "isolate px-px pb-px [mask-repeat:no-repeat] [mask-size:100%_100%] -mt-(--sandy-window-title-bar-height) h-[calc(100%+var(--sandy-window-title-bar-height))] bg-transparent [clip-path:inset(0_round_0_0_var(--sandy-frame-card-radius)_0)] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:top-(--sandy-window-title-bar-height) before:-z-10 before:rounded-tr-(--sandy-frame-card-radius) before:rounded-br-(--sandy-frame-card-radius) before:border-y before:border-r before:border-l before:border-border before:bg-background";
const SIDEBAR_FRAMED_EXPANDED_INSET_CLASS =
  "[mask-image:var(--sandy-window-card-mask-square-left)] after:pointer-events-none after:absolute after:top-0 after:left-0 after:h-(--sandy-window-title-bar-height) after:w-px after:bg-border";
const SIDEBAR_FRAMED_COLLAPSED_INSET_CLASS =
  "[mask-image:var(--sandy-window-card-mask)] [clip-path:inset(0_round_0_0_var(--sandy-frame-card-radius)_var(--sandy-frame-card-radius))] before:rounded-tl-(--sandy-frame-card-radius) before:rounded-bl-(--sandy-frame-card-radius) [transition:clip-path_0s_linear_200ms] before:[transition:border-top-left-radius_0s_linear_200ms,border-bottom-left-radius_0s_linear_200ms]";

type SidebarMobileWidthStyle = React.CSSProperties & {
  "--sidebar-width-mobile": string;
};

const sidebarMobileWidthStyle: SidebarMobileWidthStyle = {
  "--sidebar-width-mobile": SIDEBAR_WIDTH_MOBILE,
};

function getSidebarMobilePanelWidth(): number {
  if (typeof window === "undefined") {
    return SIDEBAR_MOBILE_MAX_WIDTH_PX;
  }

  return Math.min(
    window.innerWidth * SIDEBAR_MOBILE_VIEWPORT_FRACTION,
    SIDEBAR_MOBILE_MAX_WIDTH_PX,
  );
}

function getSidebarMobileMotionNodes(): {
  panel: HTMLElement | null;
  backdrop: HTMLElement | null;
  inset: HTMLElement | null;
} {
  if (typeof document === "undefined") {
    return { panel: null, backdrop: null, inset: null };
  }

  const panel = document.querySelector(
    '[data-sidebar="panel"][data-vaul-drawer-direction]',
  );
  const backdrop = document.querySelector("[data-sidebar-mobile-backdrop]");
  const inset = document.querySelector('[data-sidebar="inset"]');

  return {
    panel: panel instanceof HTMLElement ? panel : null,
    backdrop: backdrop instanceof HTMLElement ? backdrop : null,
    inset: inset instanceof HTMLElement ? inset : null,
  };
}

function applySidebarMobileDragStyles({
  progress,
  settling,
}: {
  progress: number;
  settling: boolean;
}) {
  const { panel, backdrop, inset } = getSidebarMobileMotionNodes();
  const translate = `${getSidebarMobilePanelWidth() * progress}px`;

  panel?.setAttribute("data-vaul-animate", "false");

  if (inset !== null) {
    inset.setAttribute("data-vaul-animate", "false");
    inset.style.translate = translate;
    inset.style.transition = settling
      ? SIDEBAR_MOBILE_SHELF_SETTLE_TRANSITION
      : "none";
  }

  if (backdrop !== null) {
    backdrop.setAttribute("data-vaul-animate", "false");
    backdrop.style.translate = translate;
    backdrop.style.opacity = String(progress);
    backdrop.style.transition = settling
      ? SIDEBAR_MOBILE_SHELF_BACKDROP_SETTLE_TRANSITION
      : "none";
    backdrop.style.pointerEvents = progress > 0 ? "auto" : "";
  }
}

function clearSidebarMobileDragAttributes() {
  const { panel, backdrop, inset } = getSidebarMobileMotionNodes();
  panel?.removeAttribute("data-vaul-animate");
  backdrop?.removeAttribute("data-vaul-animate");
  inset?.removeAttribute("data-vaul-animate");
}

function clearSidebarMobileDragStyles() {
  const { panel, backdrop, inset } = getSidebarMobileMotionNodes();

  panel?.removeAttribute("data-vaul-animate");

  if (inset !== null) {
    inset.removeAttribute("data-vaul-animate");
    inset.style.translate = "";
    inset.style.transition = "";
  }

  if (backdrop !== null) {
    backdrop.removeAttribute("data-vaul-animate");
    backdrop.style.translate = "";
    backdrop.style.opacity = "";
    backdrop.style.transition = "";
    backdrop.style.pointerEvents = "";
  }
}

function scheduleSidebarMobileRealization(realize: () => void): () => void {
  let settled = false;
  let idleHandle: number | null = null;
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  const cancel = () => {
    if (idleHandle !== null) {
      window.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
    if (firstFrame !== null) {
      window.cancelAnimationFrame(firstFrame);
      firstFrame = null;
    }
    if (secondFrame !== null) {
      window.cancelAnimationFrame(secondFrame);
      secondFrame = null;
    }
    window.clearTimeout(timeout);
  };
  const run = () => {
    if (settled) {
      return;
    }
    settled = true;
    cancel();
    realize();
  };
  const timeout = window.setTimeout(run, SIDEBAR_MOBILE_REALIZE_TIMEOUT_MS);
  if (typeof window.requestIdleCallback === "function") {
    idleHandle = window.requestIdleCallback(
      () => {
        idleHandle = null;
        run();
      },
      { timeout: SIDEBAR_MOBILE_REALIZE_TIMEOUT_MS },
    );
  } else {
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        run();
      });
    });
  }
  return () => {
    settled = true;
    cancel();
  };
}

type SidebarContext = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  isMobileSidebarClosing: boolean;
  isMobileSidebarRealized: boolean;
  suppressMobileOpenAnimation: boolean;
  setSuppressMobileOpenAnimation: (suppress: boolean) => void;
  suppressMobileCloseAnimation: boolean;
  setSuppressMobileCloseAnimation: (suppress: boolean) => void;
  isCompactViewport: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContext | null>(null);

const SidebarWidthContext = React.createContext<string>(SIDEBAR_WIDTH);

const SidebarShowingContext = React.createContext<boolean | null>(null);

const SidebarCollapsedRailWidthContext = React.createContext<string | null>(
  null,
);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function useIsSidebarShowing(): boolean {
  const isShowing = React.useContext(SidebarShowingContext);
  if (isShowing === null) {
    throw new Error(
      "useIsSidebarShowing must be used within a SidebarProvider.",
    );
  }
  return isShowing;
}

function useOptionalIsSidebarShowing(): boolean | null {
  return React.useContext(SidebarShowingContext);
}

const SidebarFramedContext = React.createContext(false);

function useIsSidebarFramed(): boolean {
  return React.useContext(SidebarFramedContext);
}

function useSidebarKeepsCollapsedRail(): boolean {
  return React.useContext(SidebarCollapsedRailWidthContext) !== null;
}

function useCloseMobileSidebar() {
  const { closeMobileSidebar } = useSidebar();
  return closeMobileSidebar;
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    width?: string;
    collapsedRailWidth?: string;
    framed?: boolean;
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange: setOpenProp,
      width = SIDEBAR_WIDTH,
      collapsedRailWidth,
      framed = false,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const isCompactViewport = useIsCompactViewport();
    const desktopCollapsedRailWidth = isCompactViewport
      ? null
      : (collapsedRailWidth ?? null);
    const isFramed = framed && !isCompactViewport;
    const [openMobile, setOpenMobile] = React.useState(false);
    const [suppressMobileOpenAnimation, setSuppressMobileOpenAnimation] =
      React.useState(false);
    const [suppressMobileCloseAnimation, setSuppressMobileCloseAnimation] =
      React.useState(false);
    const [isMobileSidebarClosing, setIsMobileSidebarClosing] =
      React.useState(false);
    const [hasRealizedMobileSidebar, setHasRealizedMobileSidebar] =
      React.useState(false);
    const realizeMobileSidebar = React.useCallback(() => {
      setHasRealizedMobileSidebar(true);
    }, []);
    const mobileSettleTimeoutRef = React.useRef<number | null>(null);

    const clearMobileSettleTimeout = React.useCallback(() => {
      if (mobileSettleTimeoutRef.current !== null) {
        window.clearTimeout(mobileSettleTimeoutRef.current);
        mobileSettleTimeoutRef.current = null;
      }
    }, []);

    const openMobileRef = React.useRef(openMobile);
    React.useEffect(() => {
      openMobileRef.current = openMobile;
    }, [openMobile]);

    React.useEffect(() => {
      setCompactSidebarDrawerShowing(isCompactViewport && openMobile);
      return () => {
        setCompactSidebarDrawerShowing(false);
      };
    }, [isCompactViewport, openMobile]);

    const closeMobileSidebar = React.useCallback(() => {
      if (!openMobileRef.current || mobileSettleTimeoutRef.current !== null) {
        return;
      }

      React.startTransition(() => {
        setIsMobileSidebarClosing(true);
      });
    }, []);

    React.useLayoutEffect(() => {
      if (!isMobileSidebarClosing || mobileSettleTimeoutRef.current !== null) {
        return;
      }

      applySidebarMobileDragStyles({ progress: 0, settling: true });
      mobileSettleTimeoutRef.current = window.setTimeout(() => {
        mobileSettleTimeoutRef.current = null;
        flushSync(() => {
          setSuppressMobileOpenAnimation(false);
          setSuppressMobileCloseAnimation(true);
          setIsMobileSidebarClosing(false);
          setOpenMobile(false);
        });
        clearSidebarMobileDragAttributes();
      }, SIDEBAR_MOBILE_DRAG_SETTLE_MS);
    }, [isMobileSidebarClosing]);

    const openMobileSidebar = React.useCallback(() => {
      if (openMobileRef.current || mobileSettleTimeoutRef.current !== null) {
        return;
      }

      React.startTransition(() => {
        realizeMobileSidebar();
      });
      applySidebarMobileDragStyles({ progress: 1, settling: true });
      mobileSettleTimeoutRef.current = window.setTimeout(() => {
        mobileSettleTimeoutRef.current = null;
        flushSync(() => {
          setSuppressMobileOpenAnimation(true);
          setSuppressMobileCloseAnimation(false);
          setOpenMobile(true);
        });
        clearSidebarMobileDragAttributes();
      }, SIDEBAR_MOBILE_DRAG_SETTLE_MS);
    }, [realizeMobileSidebar]);

    React.useEffect(
      () => () => {
        clearMobileSettleTimeout();
      },
      [clearMobileSettleTimeout],
    );

    if (isCompactViewport && openMobile && !hasRealizedMobileSidebar) {
      setHasRealizedMobileSidebar(true);
    }
    const isMobileSidebarRealized =
      isCompactViewport && hasRealizedMobileSidebar;
    React.useEffect(() => {
      if (!isCompactViewport || hasRealizedMobileSidebar) {
        return;
      }
      return scheduleSidebarMobileRealization(realizeMobileSidebar);
    }, [hasRealizedMobileSidebar, isCompactViewport, realizeMobileSidebar]);

    React.useEffect(() => {
      if (openMobile) {
        setSuppressMobileCloseAnimation(false);
      } else {
        setSuppressMobileOpenAnimation(false);
      }
    }, [openMobile]);

    const [_open, _setOpen] = React.useState(defaultOpen);
    const open = openProp ?? _open;
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === "function" ? value(open) : value;
        if (setOpenProp) {
          setOpenProp(openState);
        } else {
          _setOpen(openState);
        }
      },
      [setOpenProp, open],
    );

    const toggleSidebar = React.useCallback(() => {
      if (!isCompactViewport) {
        setOpen((open) => !open);
        return;
      }
      if (openMobile) {
        closeMobileSidebar();
        return;
      }
      openMobileSidebar();
    }, [
      closeMobileSidebar,
      isCompactViewport,
      openMobile,
      openMobileSidebar,
      setOpen,
    ]);

    const state = open ? "expanded" : "collapsed";

    const contextValue = React.useMemo<SidebarContext>(
      () => ({
        state,
        open,
        setOpen,
        isCompactViewport,
        openMobile,
        setOpenMobile,
        openMobileSidebar,
        closeMobileSidebar,
        isMobileSidebarClosing,
        isMobileSidebarRealized,
        suppressMobileOpenAnimation,
        setSuppressMobileOpenAnimation,
        suppressMobileCloseAnimation,
        setSuppressMobileCloseAnimation,
        toggleSidebar,
      }),
      [
        state,
        open,
        setOpen,
        isCompactViewport,
        openMobile,
        setOpenMobile,
        openMobileSidebar,
        closeMobileSidebar,
        isMobileSidebarClosing,
        isMobileSidebarRealized,
        suppressMobileOpenAnimation,
        setSuppressMobileOpenAnimation,
        suppressMobileCloseAnimation,
        setSuppressMobileCloseAnimation,
        toggleSidebar,
      ],
    );

    const isSidebarShowing = isCompactViewport ? openMobile : open;

    return (
      <SidebarContext.Provider value={contextValue}>
        <SidebarShowingContext.Provider value={isSidebarShowing}>
          <SidebarWidthContext.Provider value={width}>
            <SidebarCollapsedRailWidthContext.Provider
              value={desktopCollapsedRailWidth}
            >
              <SidebarFramedContext.Provider value={isFramed}>
                {}
                <div
                  data-framed={isFramed ? "" : undefined}
                  style={
                    {
                      ...sidebarMobileWidthStyle,
                      ...(isFramed
                        ? {
                            "--sandy-window-card-collapsed-left":
                              desktopCollapsedRailWidth ??
                              "var(--sandy-window-frame-leading-lip)",
                          }
                        : {}),
                      ...style,
                    } as React.CSSProperties
                  }
                  className={cn(
                    "group/sidebar-wrapper flex h-full min-h-0 w-full max-md:overflow-clip",
                    isFramed && SIDEBAR_FRAME_CLASS,
                    isFramed &&
                      desktopCollapsedRailWidth === null &&
                      SIDEBAR_FRAME_LEADING_LIP_CLASS,
                    className,
                  )}
                  ref={ref}
                  {...props}
                >
                  {isFramed ? (
                    <div
                      aria-hidden="true"
                      data-testid="window-title-bar-drag-region"
                      className={cn(
                        "fixed inset-x-0 top-0 h-(--sandy-window-title-bar-height)",
                        MACOS_WINDOW_DRAG_CLASS,
                      )}
                    />
                  ) : null}
                  {children}
                </div>
              </SidebarFramedContext.Provider>
            </SidebarCollapsedRailWidthContext.Provider>
          </SidebarWidthContext.Provider>
        </SidebarShowingContext.Provider>
      </SidebarContext.Provider>
    );
  },
);
SidebarProvider.displayName = "SidebarProvider";

const Sidebar = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, style, children, ...props }, ref) => {
    const {
      isCompactViewport,
      state,
      openMobile,
      setOpenMobile,
      closeMobileSidebar,
      isMobileSidebarRealized,
      suppressMobileOpenAnimation,
      setSuppressMobileOpenAnimation,
      suppressMobileCloseAnimation,
      setSuppressMobileCloseAnimation,
    } = useSidebar();
    const width = React.useContext(SidebarWidthContext);
    const collapsedRailWidth = React.useContext(
      SidebarCollapsedRailWidthContext,
    );
    const widthStyle = {
      "--sidebar-width": width,
      ...(collapsedRailWidth === null
        ? {}
        : { "--sidebar-rail-width": collapsedRailWidth }),
    } as React.CSSProperties;
    const handleOpenMobileChange = React.useCallback(
      (nextOpen: boolean) => {
        if (nextOpen) {
          setSuppressMobileCloseAnimation(false);
        } else {
          setSuppressMobileOpenAnimation(false);
        }
        setOpenMobile(nextOpen);
      },
      [
        setOpenMobile,
        setSuppressMobileCloseAnimation,
        setSuppressMobileOpenAnimation,
      ],
    );
    const shouldSuppressMobileCloseAnimation =
      !openMobile && suppressMobileCloseAnimation;
    const mobileBackdropStyle = React.useMemo<
      React.CSSProperties | undefined
    >(() => {
      if (shouldSuppressMobileCloseAnimation) {
        return {
          opacity: 0,
          translate: "0px",
          pointerEvents: "none",
          transition: "none",
        };
      }

      return undefined;
    }, [shouldSuppressMobileCloseAnimation]);

    if (isCompactViewport) {
      return (
        <SidebarMobilePanel
          ref={ref}
          open={openMobile}
          onOpenChange={handleOpenMobileChange}
          onDismiss={closeMobileSidebar}
          suppressOpenAnimation={suppressMobileOpenAnimation}
          backdropStyle={mobileBackdropStyle}
          className={className}
          style={style}
          {...props}
        >
          {isMobileSidebarRealized ? children : null}
        </SidebarMobilePanel>
      );
    }

    return (
      <div
        ref={ref}
        className="group peer text-sidebar-foreground"
        data-state={state}
        data-collapsible={
          state === "collapsed"
            ? collapsedRailWidth === null
              ? "offcanvas"
              : "rail"
            : ""
        }
        data-variant="sidebar"
        data-side="left"
      >
        {}
        <div
          data-sidebar="gap"
          style={widthStyle}
          className={cn(
            "relative hidden h-full w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear md:block",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[collapsible=rail]:w-(--sidebar-rail-width)",
          )}
        />
        <div
          data-sidebar="panel"
          className={cn(
            "fixed inset-y-0 z-10 flex h-(--sandy-shell-height) w-(--sidebar-width) select-none flex-col bg-sidebar text-sidebar-foreground [transition:left_200ms_linear,right_200ms_linear,width_200ms_linear,visibility_0s_linear_0s]",
            "group-data-[collapsible=offcanvas]:invisible group-data-[collapsible=offcanvas]:[transition:left_200ms_linear,right_200ms_linear,width_200ms_linear,visibility_0s_linear_200ms]",
            "left-(--sandy-window-frame-leading-lip) group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]",
            "group-data-[collapsible=rail]:w-(--sidebar-rail-width)",
            "border-border-seam group-data-[side=left]:border-r",
            SIDEBAR_FRAMED_PANEL_CLASS,
            className,
          )}
          style={{ ...widthStyle, ...style }}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar group-data-[framed]/sidebar-wrapper:bg-transparent pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          >
            {children}
          </div>
        </div>
      </div>
    );
  },
);
Sidebar.displayName = "Sidebar";

const SidebarCollapsibleBody = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & { contentInFlow?: boolean }
>(({ className, children, contentInFlow = false, ...props }, ref) => {
  const { open } = useSidebar();
  const width = React.useContext(SidebarWidthContext);
  const collapsedRailWidth = React.useContext(SidebarCollapsedRailWidthContext);
  const isFramed = useIsSidebarFramed();
  return (
    <div
      ref={ref}
      data-sidebar="collapsible-body"
      inert={collapsedRailWidth !== null && !open ? true : undefined}
      className={cn(
        "relative min-w-0 flex-1 [transition:visibility_0s_linear_0s]",
        "group-data-[collapsible=rail]:invisible group-data-[collapsible=rail]:[transition:visibility_0s_linear_200ms]",
        isFramed
          ? [
              "rounded-tl-(--sandy-frame-card-radius) rounded-bl-(--sandy-frame-card-radius) bg-sidebar [clip-path:inset(0_-6px_0_0_round_var(--sandy-frame-card-radius)_0_0_var(--sandy-frame-card-radius))]",
              SIDEBAR_FRAMED_CARD_EDGE_CLASS,
            ]
          : "[clip-path:inset(0_-6px_0_0)]",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex",
          contentInFlow ? "relative h-full" : "absolute inset-y-0 right-0",
        )}
        style={{
          width:
            collapsedRailWidth === null
              ? "100%"
              : `calc(${width} - ${collapsedRailWidth})`,
        }}
      >
        {children}
      </div>
    </div>
  );
});
SidebarCollapsibleBody.displayName = "SidebarCollapsibleBody";

interface SidebarMobilePanelProps extends React.ComponentProps<"div"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  suppressOpenAnimation: boolean;
  backdropStyle?: React.CSSProperties;
}

const SIDEBAR_MOBILE_TAB_STOP_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getSidebarMobileTabStops(panel: HTMLElement): HTMLElement[] {
  const doc = panel.ownerDocument;
  const triggerStops = Array.from(
    doc.querySelectorAll('[data-sidebar="trigger"]'),
  ).filter((element) => !panel.contains(element));
  const panelStops = Array.from(
    panel.querySelectorAll(SIDEBAR_MOBILE_TAB_STOP_SELECTOR),
  );
  return [...triggerStops, ...panelStops].filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      !element.matches(":disabled") &&
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.closest("[inert]") === null,
  );
}

const SidebarMobilePanel = React.forwardRef<
  HTMLDivElement,
  SidebarMobilePanelProps
>(
  (
    {
      open,
      onOpenChange,
      onDismiss,
      suppressOpenAnimation,
      backdropStyle,
      className,
      style,
      children,
      onPointerDown,
      onTouchStart,
      ...props
    },
    ref,
  ) => {
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const backdropRef = React.useRef<HTMLDivElement | null>(null);
    const setPanelRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        panelRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref],
    );

    React.useEffect(() => {
      if (!open) {
        return;
      }

      const previouslyFocused =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const shouldMoveFocus =
        previouslyFocused?.matches('[data-sidebar="trigger"]:focus-visible') ??
        false;
      if (shouldMoveFocus) {
        panelRef.current?.focus({ preventScroll: true });
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented) {
          return;
        }
        if (event.key === "Escape") {
          onDismiss();
          return;
        }
        if (event.key !== "Tab") {
          return;
        }
        const panel = panelRef.current;
        const shell = panel?.parentElement ?? null;
        if (panel === null || shell === null) {
          return;
        }
        const doc = panel.ownerDocument;
        const active = doc.activeElement;
        if (active !== null && active !== doc.body && !shell.contains(active)) {
          return;
        }
        const stops = getSidebarMobileTabStops(panel);
        if (stops.length === 0) {
          return;
        }
        event.preventDefault();
        const direction = event.shiftKey ? -1 : 1;
        const activeIndex =
          active instanceof HTMLElement ? stops.indexOf(active) : -1;
        for (let step = 1; step <= stops.length; step += 1) {
          const nextIndex =
            activeIndex === -1
              ? event.shiftKey
                ? stops.length - step
                : step - 1
              : (((activeIndex + direction * step) % stops.length) +
                  stops.length) %
                stops.length;
          const candidate = stops[nextIndex];
          candidate?.focus({ preventScroll: true });
          if (doc.activeElement === candidate) {
            return;
          }
        }
      };
      window.addEventListener("keydown", handleKeyDown);

      return () => {
        window.removeEventListener("keydown", handleKeyDown);
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          panelRef.current?.contains(active)
        ) {
          active.blur();
          if (shouldMoveFocus) {
            previouslyFocused?.focus({ preventScroll: true });
          }
        }
      };
    }, [open, onDismiss]);

    const { beginPointerDrag, beginTouchDrag } = useHorizontalDismissDrag({
      direction: "left",
      dismissTiming: "settled",
      enabled: open,
      getWidth: getSidebarMobilePanelWidth,
      onClear: clearSidebarMobileDragStyles,
      onDismiss: () => onOpenChange(false),
      onProgress: ({ progress, settling }) => {
        applySidebarMobileDragStyles({ progress, settling });
      },
      resetKey: open ? "open" : "closed",
      shouldBeginDrag: () => true,
      suppressClick: true,
    });

    const beginPanelPointerDrag = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      onPointerDown?.(event);
      beginPointerDrag(event);
    };

    const beginPanelTouchDrag = (event: React.TouchEvent<HTMLDivElement>) => {
      onTouchStart?.(event);
      beginTouchDrag(event);
    };

    const suppressedOpenTransitionStyle =
      open && suppressOpenAnimation
        ? ({ transition: "none" } satisfies React.CSSProperties)
        : undefined;

    return (
      <>
        <div
          ref={backdropRef}
          data-sidebar-mobile-backdrop=""
          data-testid="sidebar-mobile-backdrop"
          data-state={open ? "open" : "closed"}
          className={cn(
            "fixed inset-0 z-40 bg-transparent will-change-[opacity,translate]",
            "data-[state=open]:translate-x-(--sidebar-width-mobile)",
            SIDEBAR_MOBILE_BACKDROP_TRANSITION_CLASS,
            "data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0",
          )}
          style={{ ...suppressedOpenTransitionStyle, ...backdropStyle }}
          onClick={onDismiss}
          onPointerDown={beginPointerDrag}
          onTouchStart={beginTouchDrag}
        />
        <div
          ref={setPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Sidebar"
          tabIndex={-1}
          inert={!open}
          data-sidebar="panel"
          data-sidebar-state={open ? "expanded" : "collapsed"}
          data-state={open ? "open" : "closed"}
          data-collapsible=""
          data-variant="sidebar"
          data-side="left"
          data-vaul-drawer-direction="left"
          className={cn(
            "group fixed inset-y-0 left-0 z-0 flex h-(--sandy-shell-height) w-(--sidebar-width-mobile) touch-pan-y select-none flex-col bg-sidebar text-sidebar-foreground outline-none",
            "border-border-seam data-[side=left]:border-r",
            className,
          )}
          style={
            {
              ...sidebarMobileWidthStyle,
              ...style,
            } as SidebarMobileWidthStyle
          }
          onPointerDown={beginPanelPointerDrag}
          onTouchStart={beginPanelTouchDrag}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          >
            {children}
          </div>
        </div>
      </>
    );
  },
);
SidebarMobilePanel.displayName = "SidebarMobilePanel";

const SidebarTrigger = React.forwardRef<
  React.ComponentRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, "aria-expanded": ariaExpanded, ...props }, ref) => {
  const { isCompactViewport, open, openMobile, toggleSidebar } = useSidebar();

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      variant="ghost"
      size="icon"
      className={cn(
        COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
        "select-none",
        className,
      )}
      aria-expanded={ariaExpanded ?? (isCompactViewport ? openMobile : open)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <Icon name="PanelLeft" />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
});
SidebarTrigger.displayName = "SidebarTrigger";

const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"main">
>(({ className, ...props }, ref) => {
  const { isCompactViewport, open, openMobile, suppressMobileOpenAnimation } =
    useSidebar();
  const isFramed = useIsSidebarFramed();

  const shelfState = isCompactViewport
    ? openMobile
      ? "open"
      : "closed"
    : undefined;
  const panelShelfState = usePanelShelfState({
    isCompactViewport,
    isSidebarDrawerOpen: openMobile,
  });

  return (
    <main
      ref={ref}
      data-sidebar="inset"
      data-sidebar-shelf={shelfState}
      data-panel-shelf={panelShelfState}
      style={
        openMobile && suppressMobileOpenAnimation
          ? { transition: "none" }
          : undefined
      }
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background max-md:z-30",
        SIDEBAR_MOBILE_SHELF_INSET_TRANSITION_CLASS,
        "data-[sidebar-shelf=open]:translate-x-(--sidebar-width-mobile) data-[sidebar-shelf]:will-change-[translate]",
        "data-[panel-shelf=full]:-translate-x-full data-[panel-shelf]:will-change-[translate]",
        isFramed && SIDEBAR_FRAMED_INSET_CLASS,
        isFramed && open && SIDEBAR_FRAMED_EXPANDED_INSET_CLASS,
        isFramed && !open && SIDEBAR_FRAMED_COLLAPSED_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
});
SidebarInset.displayName = "SidebarInset";

const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
});
SidebarFooter.displayName = "SidebarFooter";

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const composedRef = useComposedRefs(ref, contentRef);
  React.useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const publishScrollbarLane = () => {
      element.style.setProperty(
        "--sandy-sidebar-scrollbar-lane",
        `${element.offsetWidth - element.clientWidth}px`,
      );
    };
    publishScrollbarLane();
    const observer = new ResizeObserver(publishScrollbarLane);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={composedRef}
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto bg-sidebar [scrollbar-gutter:stable]",
        className,
      )}
      {...props}
    />
  );
});
SidebarContent.displayName = "SidebarContent";

const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu"
    className={cn("flex w-full min-w-0 flex-col gap-1", className)}
    {...props}
  />
));
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-sidebar="menu-item"
    className={cn("group/menu-item relative", className)}
    {...props}
  />
));
SidebarMenuItem.displayName = "SidebarMenuItem";

const SIDEBAR_MENU_BUTTON_CLASS =
  "flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0";

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean;
    tooltip?: React.ComponentProps<typeof TooltipContent>;
  }
>(({ asChild = false, tooltip, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  const { isCompactViewport, state } = useSidebar();

  const button = (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      className={cn(SIDEBAR_MENU_BUTTON_CLASS, className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isCompactViewport}
        {...tooltip}
      />
    </Tooltip>
  );
});
SidebarMenuButton.displayName = "SidebarMenuButton";

export {
  Sidebar,
  SidebarCollapsibleBody,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useCloseMobileSidebar,
  useIsSidebarFramed,
  useIsSidebarShowing,
  useOptionalIsSidebarShowing,
  useSidebar,
  useSidebarKeepsCollapsedRail,
};
