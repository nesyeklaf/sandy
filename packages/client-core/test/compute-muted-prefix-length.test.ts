import { describe, expect, it } from "vitest";
import { computeMutedPrefixLength } from "../src/timeline/compute-muted-prefix-length.js";

describe("computeMutedPrefixLength", () => {
  it("returns 0 for user-initiated text", () => {
    expect(computeMutedPrefixLength("user", "[sandy system]\n\nhello")).toBe(0);
  });

  it("returns 0 when text does not start with [sandy", () => {
    expect(computeMutedPrefixLength("system", "hello world")).toBe(0);
    expect(computeMutedPrefixLength("agent", "[other] body")).toBe(0);
  });

  it("returns 0 when there is no closing ]", () => {
    expect(computeMutedPrefixLength("system", "[sandy system unclosed")).toBe(0);
  });

  it("eats \\n\\n after ] for block-form messages", () => {
    const text = "[sandy system]\n\nWelcome!";
    expect(computeMutedPrefixLength("system", text)).toBe(16);
    expect(text.slice(16)).toBe("Welcome!");
  });

  it("eats a single space after ] for inline-form messages", () => {
    const text = "[sandy system] Thread completed.";
    expect(computeMutedPrefixLength("system", text)).toBe(15);
    expect(text.slice(15)).toBe("Thread completed.");
  });

  it("returns text.length when the entire text is the prefix", () => {
    const text = "[sandy system]";
    expect(computeMutedPrefixLength("system", text)).toBe(text.length);
  });

  it("handles the agent prefix shape", () => {
    const prefix = "[sandy message from thread:thr_sender]";
    const text = `${prefix}\n\nHi`;
    expect(computeMutedPrefixLength("agent", text)).toBe(prefix.length + 2);
    expect(text.slice(prefix.length + 2)).toBe("Hi");
  });
});
