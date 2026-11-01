import {
  clientNotificationSchema,
  type ClientNotification,
} from "./contract.js";

export type ClientChannel = "web" | "desktop";

export function clientChannel(): ClientChannel | null {
  if ("sandyDesktop" in window) return "desktop";
  if (
    "sandy" in window &&
    typeof window.sandy === "object" &&
    window.sandy !== null &&
    "native" in window.sandy
  )
    return null;
  return "web";
}

export function notificationPermission():
  | NotificationPermission
  | "unsupported" {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

const SEEN_LOCK_MS = 60_000;

function focusLockName(threadId: string): string {
  return `sandy-notifications-focus-${threadId}`;
}

function seenLockName(id: string): string {
  return `sandy-notifications-seen-${id}`;
}

export function createClientDelivery(
  navigate: (threadId: string) => void,
  currentThreadId: () => string | null = () => null,
) {
  const active = new Set<Notification>();
  let disposed = false;
  let focusLock: { threadId: string; release: () => void } | null = null;

  function focusedThreadHere(): string | null {
    const threadId = currentThreadId();
    return threadId !== null &&
      document.visibilityState === "visible" &&
      document.hasFocus()
      ? threadId
      : null;
  }

  function syncFocus(): void {
    const threadId = disposed ? null : focusedThreadHere();
    if (focusLock?.threadId === threadId) return;
    focusLock?.release();
    focusLock = null;
    if (threadId === null || !navigator.locks) return;
    let release = (): void => undefined;
    const held = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    focusLock = { threadId, release };
    void navigator.locks
      .request(focusLockName(threadId), { mode: "shared" }, () => held)
      .catch(() => undefined);
  }

  async function heldLockNames(): Promise<Set<string | undefined>> {
    if (!navigator.locks) return new Set();
    const { held = [] } = await navigator.locks.query();
    return new Set(held.map((lock) => lock.name));
  }

  window.addEventListener("focus", syncFocus);
  window.addEventListener("blur", syncFocus);
  document.addEventListener("visibilitychange", syncFocus);
  syncFocus();

  function display(message: ClientNotification): void {
    if (disposed || notificationPermission() !== "granted") return;
    const isMacDesktop =
      "sandyDesktop" in window &&
      typeof window.sandyDesktop === "object" &&
      window.sandyDesktop !== null &&
      "platform" in window.sandyDesktop &&
      window.sandyDesktop.platform === "macos";
    const notification = new Notification(message.title, {
      body: message.body,
      ...(isMacDesktop
        ? {}
        : { icon: new URL("/icon-192.png", window.location.origin).href }),
      tag: `sandy-${message.threadId ?? message.id}`,
    });
    active.add(notification);
    notification.onclose = () => active.delete(notification);
    notification.onclick = () => {
      if (disposed) return;
      window.focus();
      if (
        "sandyDesktop" in window &&
        typeof window.sandyDesktop === "object" &&
        window.sandyDesktop !== null &&
        "focusWindow" in window.sandyDesktop &&
        typeof window.sandyDesktop.focusWindow === "function"
      ) {
        window.sandyDesktop.focusWindow();
      }
      if (message.threadId !== null) navigate(message.threadId);
      notification.close();
      active.delete(notification);
    };
  }

  async function deliver(payload: unknown, enabled: boolean): Promise<void> {
    const parsed = clientNotificationSchema.safeParse(payload);
    const channel = clientChannel();
    if (
      !enabled ||
      disposed ||
      channel === null ||
      !parsed.success ||
      !parsed.data.channels.includes(channel) ||
      notificationPermission() !== "granted"
    )
      return;
    const message = parsed.data;
    const claim = async () => {
      if (disposed) return;
      const key = `sandy.push-notifications.seen.${channel}`;
      let ids: string[] = [];
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
        ids = Array.isArray(stored)
          ? stored.filter((id): id is string => typeof id === "string")
          : [];
        if (ids.includes(message.id)) return;
      } catch {
        ids = [];
      }
      syncFocus();
      const held = await heldLockNames();
      if (disposed || held.has(seenLockName(message.id))) return;
      void navigator.locks
        ?.request(
          seenLockName(message.id),
          () => new Promise((resolve) => setTimeout(resolve, SEEN_LOCK_MS)),
        )
        .catch(() => undefined);
      const focused =
        message.threadId !== null &&
        (message.threadId === focusedThreadHere() ||
          held.has(focusLockName(message.threadId)));
      if (!focused) display(message);
      try {
        localStorage.setItem(
          key,
          JSON.stringify([...ids.slice(-99), message.id]),
        );
      } catch {
        return;
      }
    };
    if (navigator.locks)
      await navigator.locks.request(`sandy-notifications-${channel}`, claim);
    else await claim();
  }

  return {
    deliver,
    syncFocus,
    dispose() {
      disposed = true;
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
      document.removeEventListener("visibilitychange", syncFocus);
      syncFocus();
      for (const notification of active) notification.close();
      active.clear();
    },
  };
}
