import { randomUUID } from "node:crypto";
import type {
  SandyPluginApi,
  ExperimentalPluginRpcCaller,
  PluginThreadEventPayloads,
} from "@sandy-sdk/plugin-sdk";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
  type ClientNotification,
  type DeliveryChannel,
  type SendNotificationInput,
} from "./contract.js";
import { notificationPreviewText, truncate } from "./notification-text.js";
import {
  NOTIFICATION_KINDS_BY_LEVEL,
  type NotificationLevel,
  type PushNotificationKind,
} from "./preferences.js";

type ThreadResponse = PluginThreadEventPayloads["thread.idle"]["thread"];
type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

const DEFAULT_COALESCE_MS = 2_000;
const FALLBACK_BODIES: Record<PushNotificationKind, string> = {
  "pending-interaction": "Waiting for your input",
  "thread-error": "The thread hit an error",
  "turn-finished": "Finished and waiting for you",
};
const PUSH_KIND_PRIORITY: readonly PushNotificationKind[] = [
  "pending-interaction",
  "thread-error",
  "turn-finished",
];

export class SendNotificationError extends Error {
  readonly code: "thread_not_found" | "sender_stopped";

  constructor(code: SendNotificationError["code"], message: string) {
    super(message);
    this.name = "SendNotificationError";
    this.code = code;
  }
}

interface OutgoingNotification {
  title: string;
  body: string;
  thread: { id: string } | null;
}

interface PendingThreadPush {
  bodies: Map<PushNotificationKind, string>;
  eventAt: number;
  kinds: Set<PushNotificationKind>;
  timer: ReturnType<typeof setTimeout>;
}

export interface PushSender {
  onInteractionPending(
    payload: PluginThreadEventPayloads["interaction.pending"],
  ): void;
  onThreadFailed(payload: PluginThreadEventPayloads["thread.failed"]): void;
  onThreadIdle(payload: PluginThreadEventPayloads["thread.idle"]): void;
  send(
    input: SendNotificationInput,
    caller: ExperimentalPluginRpcCaller,
  ): Promise<DeliveryChannel[]>;
  settle(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface CreatePushSenderArgs {
  sandy: SandyPluginApi;
  getNotificationLevel(thread: {
    id: string;
    parentThreadId: string | null;
  }): Promise<NotificationLevel>;
  getDeliverySettings(): Promise<{
    webEnabled: boolean;
    desktopEnabled: boolean;
  }>;
  coalesceMs?: number;
  now?: () => number;
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function threadDisplayTitle(thread: ThreadResponse): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  if (fallback) return fallback;
  return `Thread ${thread.id.slice(0, 8)}`;
}

function describePendingInteraction(interaction: PendingInteraction): string {
  const payload = interaction.payload;
  if (payload.kind === "user_question") {
    const prompt = firstLine(payload.questions[0]?.prompt ?? "");
    return prompt || "The agent has a question for you";
  }
  if (payload.kind === "approval") {
    const subject = payload.subject;
    if (subject.kind === "command") {
      return `Approve command: ${firstLine(subject.command)}`;
    }
    if (subject.kind === "file_change") return "Approve file changes";
    if (subject.kind === "permission_grant") {
      return subject.toolName
        ? `Grant permissions to ${subject.toolName}`
        : "Grant additional permissions";
    }
    return "Review the plan before the agent continues";
  }
  if ("title" in payload) return payload.title;
  return "Waiting for your input";
}

function pickKind(
  kinds: ReadonlySet<PushNotificationKind>,
): PushNotificationKind | null {
  for (const kind of PUSH_KIND_PRIORITY) {
    if (kinds.has(kind)) return kind;
  }
  return null;
}

function describeCaller(caller: ExperimentalPluginRpcCaller): string {
  return caller.kind === "plugin" ? `plugin ${caller.pluginId}` : "a client";
}

export function createPushSender(args: CreatePushSenderArgs): PushSender {
  const {
    sandy,
    coalesceMs = DEFAULT_COALESCE_MS,
    now = Date.now,
  } = args;
  const pending = new Map<string, PendingThreadPush>();
  const inFlight = new Set<Promise<void>>();
  let running = false;

  function cancel(threadId: string): void {
    const entry = pending.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(threadId);
  }

  function schedule(
    threadId: string,
    kind: PushNotificationKind,
    body: string,
  ): void {
    if (!running) return;
    const eventAt = now();
    const existing = pending.get(threadId);
    if (existing) {
      existing.kinds.add(kind);
      existing.bodies.set(kind, body);
      existing.eventAt = Math.max(existing.eventAt, eventAt);
      return;
    }
    const timer = setTimeout(() => {
      const entry = pending.get(threadId);
      pending.delete(threadId);
      if (!entry || !running) return;
      const flush = flushThread(threadId, entry).catch((error: unknown) => {
        sandy.log.error(
          `Push notification flush failed for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      inFlight.add(flush);
      void flush.finally(() => inFlight.delete(flush));
    }, coalesceMs);
    timer.unref?.();
    pending.set(threadId, {
      bodies: new Map([[kind, body]]),
      eventAt,
      kinds: new Set([kind]),
      timer,
    });
  }

  async function resolvePush(
    thread: ThreadResponse,
    entry: PendingThreadPush,
    allowedKinds: ReadonlySet<PushNotificationKind>,
  ): Promise<{ kind: PushNotificationKind; body: string } | null> {
    const kinds = new Set(
      [...entry.kinds].filter((kind) => allowedKinds.has(kind)),
    );
    if (kinds.size === 0) return null;
    let interaction: PendingInteraction | null = null;
    if (kinds.has("pending-interaction")) {
      const interactions = await sandy.sdk.threads.interactions.list({
        threadId: thread.id,
      });
      interaction =
        interactions.find((candidate) => candidate.status === "pending") ??
        null;
      if (!interaction) kinds.delete("pending-interaction");
    }
    if (kinds.has("turn-finished") && thread.status !== "idle") {
      kinds.delete("turn-finished");
    }
    if (kinds.has("thread-error") && thread.status !== "error") {
      kinds.delete("thread-error");
    }
    const kind = pickKind(kinds);
    if (kind === null) return null;
    if (kind === "pending-interaction") {
      return {
        kind,
        body: interaction ? describePendingInteraction(interaction) : "",
      };
    }
    return { kind, body: entry.bodies.get(kind) ?? "" };
  }

  async function referencedThreadTitle(
    threadId: string,
  ): Promise<string | null> {
    try {
      return threadDisplayTitle(await sandy.sdk.threads.get({ threadId }));
    } catch {
      return null;
    }
  }

  async function flushThread(
    threadId: string,
    entry: PendingThreadPush,
  ): Promise<void> {
    let thread: ThreadResponse;
    try {
      thread = await sandy.sdk.threads.get({ threadId });
    } catch {
      return;
    }
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.visibility !== "visible"
    ) {
      return;
    }
    const lastReadAt = thread.lastReadAt ?? 0;
    if (lastReadAt >= thread.latestAttentionAt && lastReadAt >= entry.eventAt) {
      return;
    }
    const level = await args.getNotificationLevel(thread);
    const resolved = await resolvePush(
      thread,
      entry,
      NOTIFICATION_KINDS_BY_LEVEL[level],
    );
    if (resolved === null) return;
    const preview = await notificationPreviewText(
      resolved.body,
      referencedThreadTitle,
    );
    await deliver({
      title: threadDisplayTitle(thread),
      body: preview || FALLBACK_BODIES[resolved.kind],
      thread,
    });
  }

  async function deliver(
    notification: OutgoingNotification,
  ): Promise<DeliveryChannel[]> {
    const title = truncate(notification.title, NOTIFICATION_TITLE_MAX_LENGTH);
    const body = truncate(notification.body, NOTIFICATION_BODY_MAX_LENGTH);
    const config = await args.getDeliverySettings();
    const channels: DeliveryChannel[] = [];
    if (config.webEnabled) channels.push("web");
    if (config.desktopEnabled) channels.push("desktop");
    if (channels.length > 0) {
      sandy.realtime.publish(CLIENT_NOTIFICATION_CHANNEL, {
        id: randomUUID(),
        title,
        body,
        threadId: notification.thread?.id ?? null,
        channels,
      } satisfies ClientNotification);
    }
    return channels;
  }

  async function send(
    input: SendNotificationInput,
    caller: ExperimentalPluginRpcCaller,
  ): Promise<DeliveryChannel[]> {
    if (!running) {
      throw new SendNotificationError(
        "sender_stopped",
        "Push notifications are not running",
      );
    }
    let thread: OutgoingNotification["thread"] = null;
    if (input.threadId !== undefined) {
      const threadId = input.threadId;
      const found = await sandy.sdk.threads.get({ threadId }).catch(() => null);
      if (found === null || found.deletedAt !== null) {
        throw new SendNotificationError(
          "thread_not_found",
          `Thread not found: ${threadId}`,
        );
      }
      thread = { id: found.id };
    }
    const delivery = deliver({
      title: input.title,
      body: input.body,
      thread,
    });
    const tracked = delivery.then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
    const channels = await delivery;
    sandy.log.info(
      `Sent a notification from ${describeCaller(caller)} to ${channels.length === 0 ? "no channel" : channels.join(", ")}`,
    );
    return channels;
  }

  async function settle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  return {
    onInteractionPending(payload) {
      schedule(
        payload.thread.id,
        "pending-interaction",
        describePendingInteraction(payload.interaction),
      );
    },
    onThreadFailed({ thread, error }) {
      schedule(thread.id, "thread-error", firstLine(error ?? ""));
    },
    onThreadIdle({ thread, lastAssistantText }) {
      if (thread.visibility !== "visible") return;
      schedule(thread.id, "turn-finished", lastAssistantText ?? "");
    },
    send,
    settle,
    start() {
      running = true;
    },
    async stop() {
      if (!running) return;
      running = false;
      for (const threadId of [...pending.keys()]) cancel(threadId);
      await settle();
    },
  };
}
