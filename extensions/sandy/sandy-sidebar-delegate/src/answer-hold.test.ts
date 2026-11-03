import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_HOLD_MS, createAnswerHold } from "./answer-hold";

describe("answer hold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the answer only once the hold has run out", () => {
    const hold = createAnswerHold();
    const send = vi.fn(async () => {});
    hold.hold("int_1", { label: "Yes" }, send);
    expect(hold.get("int_1")).toEqual({ label: "Yes", sending: false });
    vi.advanceTimersByTime(ANSWER_HOLD_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it("never sends an answer that was undone", () => {
    const hold = createAnswerHold();
    const send = vi.fn(async () => {});
    hold.hold("int_1", { label: "Yes" }, send);
    vi.advanceTimersByTime(ANSWER_HOLD_MS - 1);
    expect(hold.cancel("int_1")).toBe(true);
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    expect(send).not.toHaveBeenCalled();
    expect(hold.cancel("int_1")).toBe(false);
  });

  it("restarts the hold with the latest choice when the user answers again", () => {
    const hold = createAnswerHold();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    hold.hold("int_1", { label: "Yes" }, first);
    vi.advanceTimersByTime(ANSWER_HOLD_MS - 1000);
    hold.hold("int_1", { label: "No" }, second);
    vi.advanceTimersByTime(ANSWER_HOLD_MS - 1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("discards every held answer when the sidebar goes away", () => {
    const hold = createAnswerHold();
    const a = vi.fn(async () => {});
    const discarded = vi.fn();
    hold.hold("int_a", { label: "Yes" }, a, discarded);
    hold.hold("int_b", { label: "No" }, a, discarded);
    hold.discardAll();
    vi.advanceTimersByTime(ANSWER_HOLD_MS * 2);
    expect(a).not.toHaveBeenCalled();
    expect(discarded).toHaveBeenCalledTimes(2);
    expect(hold.get("int_a")).toBeNull();
  });

  it("keeps an answer that is being sent so it cannot be sent or undone again", async () => {
    const hold = createAnswerHold();
    let fail: (error: Error) => void = () => {};
    const send = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const again = vi.fn(async () => {});
    hold.hold("int_1", { label: "Yes" }, send);
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    expect(hold.get("int_1")).toEqual({ label: "Yes", sending: true });
    hold.hold("int_1", { label: "No" }, again);
    expect(hold.cancel("int_1")).toBe(false);
    hold.discardAll();
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    expect(again).not.toHaveBeenCalled();
    expect(hold.get("int_1")).toEqual({ label: "Yes", sending: true });
    fail(new Error("offline"));
    await vi.waitFor(() => expect(hold.get("int_1")).toBeNull());
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps a sent answer so the stale options never come back", async () => {
    const hold = createAnswerHold();
    hold.hold("int_1", { label: "Yes" }, async () => {});
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(hold.get("int_1")).toEqual({ label: "Yes", sending: true });
  });

  it("tells subscribers when a hold starts and ends", () => {
    const hold = createAnswerHold();
    const listener = vi.fn();
    const unsubscribe = hold.subscribe(listener);
    hold.hold("int_1", { label: "Yes" }, async () => {});
    hold.cancel("int_1");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    hold.hold("int_1", { label: "Yes" }, async () => {});
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
