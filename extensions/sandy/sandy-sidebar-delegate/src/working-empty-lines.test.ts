import { describe, expect, it } from "vitest";
import { WORKING_EMPTY_LINES, pickWorkingEmptyLine } from "./working-empty-lines";

describe("pickWorkingEmptyLine", () => {
  it("never shows the same line twice in a row", () => {
    // A random source pinned to one value would repeat a naive pick forever.
    const stuck = () => 0;
    let previous = pickWorkingEmptyLine(stuck);
    for (let i = 0; i < 20; i += 1) {
      const next = pickWorkingEmptyLine(stuck);
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("can reach every line", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(pickWorkingEmptyLine());
    expect(seen.size).toBe(WORKING_EMPTY_LINES.length);
  });
});
