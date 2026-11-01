import { describe, expect, it } from "vitest";
import { threadScope } from "../src/thread-event-scope.js";
import type { ThreadEvent } from "../src/provider-event.js";
import {
  fromProviderExternalThreadName,
  normalizeProviderThreadNameEvent,
  toProviderExternalThreadName,
} from "../src/thread-name-tags.js";

describe("thread name tags", () => {
  it("round-trips user-provided literal sandy-prefixed titles", () => {
    const providerName = toProviderExternalThreadName("[sandy] Literal");

    expect(providerName).toBe("[sandy] [sandy] Literal");
    expect(fromProviderExternalThreadName(providerName)).toBe("[sandy] Literal");
  });

  it("normalizes provider title events by stripping one sandy tag", () => {
    const event = {
      type: "thread/name/updated",
      threadId: "t1",
      providerThreadId: "p1",
      scope: threadScope(),
      threadName: toProviderExternalThreadName("[sandy] Literal"),
    } satisfies ThreadEvent;

    expect(normalizeProviderThreadNameEvent(event)).toEqual({
      ...event,
      threadName: "[sandy] Literal",
    });
  });
});
