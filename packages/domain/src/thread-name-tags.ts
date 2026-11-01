import type { ThreadEvent } from "./provider-event.js";

const SANDY_THREAD_NAME_PREFIX = "[sandy] ";

export function toProviderExternalThreadName(title: string): string {
  return `${SANDY_THREAD_NAME_PREFIX}${title}`;
}

export function fromProviderExternalThreadName(name: string): string {
  if (!name.startsWith(SANDY_THREAD_NAME_PREFIX)) {
    return name;
  }
  return name.slice(SANDY_THREAD_NAME_PREFIX.length);
}

export function normalizeProviderThreadNameEvent(
  event: ThreadEvent,
): ThreadEvent {
  if (event.type !== "thread/name/updated") {
    return event;
  }
  return {
    ...event,
    threadName: fromProviderExternalThreadName(event.threadName),
  };
}
