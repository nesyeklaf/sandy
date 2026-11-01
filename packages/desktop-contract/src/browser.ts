import { jsonValueSchema } from "@sandy/domain";
import { z } from "zod";
import {
  desktopBrowserImportSelectionSchema,
  type DesktopBrowserImportOutcome,
  type DesktopBrowserImportSource,
} from "@sandy/host-daemon-contract";

export const SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH = 4096;
export const SANDY_DESKTOP_BROWSER_MAX_TITLE_LENGTH = 1024;

export const sandyDesktopBrowserTargetSchema = z
  .object({
    hostId: z.string().min(1),
    instanceId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();
export type SandyDesktopBrowserTarget = z.infer<
  typeof sandyDesktopBrowserTargetSchema
>;

export const sandyDesktopBrowserControlSchema = z
  .object({
    leaseId: z.string().min(1),
    controllerLabel: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type SandyDesktopBrowserControl = z.infer<
  typeof sandyDesktopBrowserControlSchema
>;
export const sandyDesktopBrowserControlStateSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    control: sandyDesktopBrowserControlSchema.nullable(),
  })
  .strict();
export type SandyDesktopBrowserControlState = z.infer<
  typeof sandyDesktopBrowserControlStateSchema
>;
export const sandyDesktopBrowserRevealRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    desktopTarget: sandyDesktopBrowserTargetSchema,
  })
  .strict();
export type SandyDesktopBrowserRevealRequest = z.infer<
  typeof sandyDesktopBrowserRevealRequestSchema
>;

const sandyDesktopBrowserViewBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict();
export type SandyDesktopBrowserViewBounds = z.infer<
  typeof sandyDesktopBrowserViewBoundsSchema
>;

export interface SandyDesktopBrowserViewportBounds {
  width: number;
  height: number;
}

interface ClampIntegerToRangeArgs {
  max: number;
  min: number;
  value: number;
}

interface ClampSandyDesktopBrowserViewBoundsArgs {
  bounds: SandyDesktopBrowserViewBounds;
  viewport: SandyDesktopBrowserViewportBounds;
}

function clampIntegerToRange(args: ClampIntegerToRangeArgs): number {
  return Math.min(Math.max(args.value, args.min), args.max);
}

export function clampSandyDesktopBrowserViewBounds(
  args: ClampSandyDesktopBrowserViewBoundsArgs,
): SandyDesktopBrowserViewBounds {
  const viewportRight = Math.max(0, Math.round(args.viewport.width));
  const viewportBottom = Math.max(0, Math.round(args.viewport.height));
  const x = clampIntegerToRange({
    value: args.bounds.x,
    min: 0,
    max: viewportRight,
  });
  const y = clampIntegerToRange({
    value: args.bounds.y,
    min: 0,
    max: viewportBottom,
  });
  const right = clampIntegerToRange({
    value: args.bounds.x + args.bounds.width,
    min: x,
    max: viewportRight,
  });
  const bottom = clampIntegerToRange({
    value: args.bounds.y + args.bounds.height,
    min: y,
    max: viewportBottom,
  });

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export const sandyDesktopBrowserAttachRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    url: z.string().max(SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH),
    existingOnly: z.literal(true).optional(),
    bounds: sandyDesktopBrowserViewBoundsSchema,
    visible: z.boolean(),
  })
  .strict();
export type SandyDesktopBrowserAttachRequest = z.infer<
  typeof sandyDesktopBrowserAttachRequestSchema
>;

export const sandyDesktopBrowserNavigateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type SandyDesktopBrowserNavigateRequest = z.infer<
  typeof sandyDesktopBrowserNavigateRequestSchema
>;

export const sandyDesktopBrowserSetBoundsRequestSchema = z
  .object({
    tabId: z.string().min(1),
    bounds: sandyDesktopBrowserViewBoundsSchema,
  })
  .strict();
export type SandyDesktopBrowserSetBoundsRequest = z.infer<
  typeof sandyDesktopBrowserSetBoundsRequestSchema
>;

export const sandyDesktopBrowserSetVisibleRequestSchema = z
  .object({
    tabId: z.string().min(1),
    visible: z.boolean(),
  })
  .strict();
export type SandyDesktopBrowserSetVisibleRequest = z.infer<
  typeof sandyDesktopBrowserSetVisibleRequestSchema
>;

export const sandyDesktopBrowserTabRefSchema = z
  .object({
    tabId: z.string().min(1),
  })
  .strict();
export type SandyDesktopBrowserTabRef = z.infer<
  typeof sandyDesktopBrowserTabRefSchema
>;

export const sandyDesktopBrowserSetThreadDiscardedRequestSchema = z
  .object({
    threadId: z.string().min(1),
    discarded: z.boolean(),
  })
  .strict();
export type SandyDesktopBrowserSetThreadDiscardedRequest = z.infer<
  typeof sandyDesktopBrowserSetThreadDiscardedRequestSchema
>;

export const sandyDesktopBrowserStateSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().max(SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH),
    title: z.string().max(SANDY_DESKTOP_BROWSER_MAX_TITLE_LENGTH).nullable(),
    faviconUrl: z
      .string()
      .max(SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH)
      .nullable()
      .optional(),
    faviconUrls: z
      .array(z.string().max(SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH))
      .max(8)
      .optional(),
    isLoading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    errorText: z.string().max(SANDY_DESKTOP_BROWSER_MAX_TITLE_LENGTH).nullable(),
  })
  .strict();
export type SandyDesktopBrowserState = z.infer<typeof sandyDesktopBrowserStateSchema>;

export const sandyDesktopBrowserOpenTabRequestSchema = z
  .object({
    url: z.string().min(1).max(SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type SandyDesktopBrowserOpenTabRequest = z.infer<
  typeof sandyDesktopBrowserOpenTabRequestSchema
>;

export const sandyDesktopBrowserScopedOpenTabRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(SANDY_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type SandyDesktopBrowserScopedOpenTabRequest = z.infer<
  typeof sandyDesktopBrowserScopedOpenTabRequestSchema
>;

const SANDY_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH = 8_388_608;

export const sandyDesktopBrowserSnapshotSchema = z
  .object({
    tabId: z.string().min(1),
    dataUrl: z
      .string()
      .max(SANDY_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH)
      .nullable(),
  })
  .strict();
export type SandyDesktopBrowserSnapshot = z.infer<
  typeof sandyDesktopBrowserSnapshotSchema
>;

export const SANDY_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH = 1024;

export const sandyDesktopBrowserFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    text: z.string().min(1).max(SANDY_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH),
    forward: z.boolean(),
    newSession: z.boolean(),
  })
  .strict();
export type SandyDesktopBrowserFindInPageRequest = z.infer<
  typeof sandyDesktopBrowserFindInPageRequestSchema
>;

export const sandyDesktopBrowserStopFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    action: z.enum(["clearSelection", "keepSelection", "activateSelection"]),
  })
  .strict();
export type SandyDesktopBrowserStopFindInPageRequest = z.infer<
  typeof sandyDesktopBrowserStopFindInPageRequestSchema
>;

export const sandyDesktopBrowserFindResultSchema = z
  .object({
    tabId: z.string().min(1),
    requestId: z.number().int(),
    activeMatchOrdinal: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    finalUpdate: z.boolean(),
  })
  .strict();
export type SandyDesktopBrowserFindResult = z.infer<
  typeof sandyDesktopBrowserFindResultSchema
>;

export const SANDY_DESKTOP_BROWSER_MAX_PAGE_EXPRESSION_LENGTH = 4_000_000;
export const SANDY_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH = 256;

export const sandyDesktopBrowserPageWorldSchema = z.enum(["main", "isolated"]);

export const sandyDesktopBrowserEvaluateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    expression: z
      .string()
      .min(1)
      .max(SANDY_DESKTOP_BROWSER_MAX_PAGE_EXPRESSION_LENGTH),
    world: sandyDesktopBrowserPageWorldSchema,
    channel: z.string().min(1).max(SANDY_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH),
  })
  .strict();
export type SandyDesktopBrowserEvaluateRequest = z.infer<
  typeof sandyDesktopBrowserEvaluateRequestSchema
>;

export const sandyDesktopBrowserEvaluateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: jsonValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type SandyDesktopBrowserEvaluateResult = z.infer<
  typeof sandyDesktopBrowserEvaluateResultSchema
>;

export const sandyDesktopBrowserPageMessageSchema = z
  .object({
    tabId: z.string().min(1),
    channel: z.string().min(1).max(SANDY_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH),
    data: jsonValueSchema,
  })
  .strict();
export type SandyDesktopBrowserPageMessage = z.infer<
  typeof sandyDesktopBrowserPageMessageSchema
>;
export type SandyDesktopBrowserPageMessageHandler = (
  message: SandyDesktopBrowserPageMessage,
) => void;

export type SandyDesktopBrowserStateHandler = (
  state: SandyDesktopBrowserState,
) => void;
export type SandyDesktopBrowserOpenTabHandler = (
  request: SandyDesktopBrowserOpenTabRequest,
) => void;
export type SandyDesktopBrowserScopedOpenTabHandler = (
  request: SandyDesktopBrowserScopedOpenTabRequest,
) => void;
export type SandyDesktopBrowserSnapshotHandler = (
  snapshot: SandyDesktopBrowserSnapshot,
) => void;
export type SandyDesktopBrowserFocusHandler = (tabId: string) => void;
export type SandyDesktopBrowserFindResultHandler = (
  result: SandyDesktopBrowserFindResult,
) => void;
export type SandyDesktopBrowserUnsubscribe = () => void;

export const sandyDesktopBrowserImportCookiesRequestSchema =
  desktopBrowserImportSelectionSchema;
export type SandyDesktopBrowserImportCookiesRequest = z.infer<
  typeof sandyDesktopBrowserImportCookiesRequestSchema
>;
export type SandyDesktopBrowserImportSourcesResult = {
  sources: DesktopBrowserImportSource[];
};
export type SandyDesktopBrowserImportCookiesResult = DesktopBrowserImportOutcome;

export interface SandyDesktopBrowserApi {
  listImportSources?(): Promise<SandyDesktopBrowserImportSourcesResult>;
  importCookies?(
    request: SandyDesktopBrowserImportCookiesRequest,
  ): Promise<SandyDesktopBrowserImportCookiesResult>;
  openFullDiskAccessSettings?(): void;
  getTarget?(): Promise<SandyDesktopBrowserTarget | null>;
  getControl?(tabId: string): Promise<SandyDesktopBrowserControlState | null>;
  releaseControl?(tabId: string): void;
  onControl?(
    listener: (state: SandyDesktopBrowserControlState) => void,
  ): SandyDesktopBrowserUnsubscribe;
  onReveal?(
    listener: (request: SandyDesktopBrowserRevealRequest) => void,
  ): SandyDesktopBrowserUnsubscribe;
  attach(request: SandyDesktopBrowserAttachRequest): void;
  detach(tabId: string): void;
  setThreadDiscarded?(request: SandyDesktopBrowserSetThreadDiscardedRequest): void;
  listThreadIdsWithTabs?(): Promise<string[]>;
  navigate(request: SandyDesktopBrowserNavigateRequest): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): void;
  stop(tabId: string): void;
  focus?(tabId: string): void;
  setBounds(request: SandyDesktopBrowserSetBoundsRequest): void;
  setVisible(request: SandyDesktopBrowserSetVisibleRequest): void;
  setVisibleWithoutFocus?(request: SandyDesktopBrowserSetVisibleRequest): void;
  onState(listener: SandyDesktopBrowserStateHandler): SandyDesktopBrowserUnsubscribe;
  onOpenTab(
    listener: SandyDesktopBrowserOpenTabHandler,
  ): SandyDesktopBrowserUnsubscribe;
  onScopedOpenTab?(
    listener: SandyDesktopBrowserScopedOpenTabHandler,
  ): SandyDesktopBrowserUnsubscribe;
  onFocus?(listener: SandyDesktopBrowserFocusHandler): SandyDesktopBrowserUnsubscribe;
  onSnapshot?(
    listener: SandyDesktopBrowserSnapshotHandler,
  ): SandyDesktopBrowserUnsubscribe;
  findInPage?(request: SandyDesktopBrowserFindInPageRequest): void;
  stopFindInPage?(request: SandyDesktopBrowserStopFindInPageRequest): void;
  onFindResult?(
    listener: SandyDesktopBrowserFindResultHandler,
  ): SandyDesktopBrowserUnsubscribe;
  evaluate?(
    request: SandyDesktopBrowserEvaluateRequest,
  ): Promise<SandyDesktopBrowserEvaluateResult>;
  onPageMessage?(
    listener: SandyDesktopBrowserPageMessageHandler,
  ): SandyDesktopBrowserUnsubscribe;
}
