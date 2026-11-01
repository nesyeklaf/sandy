import { describe, expect, it } from "vitest";
import { buildExplainPrompt, cleanExplanation } from "./explain-prompt";

describe("explain prompt", () => {
  it("carries the passage and the session title and clips a long passage", () => {
    const prompt = buildExplainPrompt("x".repeat(5000), "Fix login");
    expect(prompt).toContain("Session: Fix login");
    expect(prompt.length).toBeLessThan(2600);
  });

  it("rejects an empty answer and trims the rest", () => {
    expect(() => cleanExplanation("  ")).toThrow("no explanation");
    expect(cleanExplanation("  hi \n")).toBe("hi");
  });
});
