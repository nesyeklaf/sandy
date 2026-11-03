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
    const send = vi.fn();
    hold.hold("int_1", { label: "Yes" }, send);
    expect(hold.get("int_1")).toEqual({ label: "Yes" });
    vi.advanceTimersByTime(ANSWER_HOLD_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledOnce();
    expect(hold.get("int_1")).toBeNull();
  });

  it("never sends an answer that was undone", () => {
    const hold = createAnswerHold();
    const send = vi.fn();
    hold.hold("int_1", { label: "Yes" }, send);
    vi.advanceTimersByTime(ANSWER_HOLD_MS - 1);
    expect(hold.cancel("int_1")).toBe(true);
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    expect(send).not.toHaveBeenCalled();
    expect(hold.cancel("int_1")).toBe(false);
  });

  it("restarts the hold with the latest choice when the user answers again", () => {
    const hold = createAnswerHold();
    const first = vi.fn();
    const second = vi.fn();
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

  it("sends every held answer at once when the sidebar goes away", () => {
    const hold = createAnswerHold();
    const a = vi.fn();
    const b = vi.fn();
    hold.hold("int_a", { label: "Yes" }, a);
    hold.hold("int_b", { label: "No" }, b);
    hold.flushAll();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(ANSWER_HOLD_MS);
    expect(a).toHaveBeenCalledOnce();
  });

  it("tells subscribers when a hold starts and ends", () => {
    const hold = createAnswerHold();
    const listener = vi.fn();
    const unsubscribe = hold.subscribe(listener);
    hold.hold("int_1", { label: "Yes" }, () => {});
    hold.cancel("int_1");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    hold.hold("int_1", { label: "Yes" }, () => {});
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
