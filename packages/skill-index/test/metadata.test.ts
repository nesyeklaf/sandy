import { describe, expect, it } from "vitest";
import { parseSkillMetadata } from "../src/metadata.js";

describe("parseSkillMetadata", () => {
  it("returns the frontmatter metadata map with its raw string values", () => {
    const parsed = parseSkillMetadata(
      [
        "---",
        "name: ux-journeys",
        "description: Design journeys",
        "metadata:",
        '  inputs: "Feature: text; Mode?: choice(new, rework)"',
        '  outputs: "Journeys: file(journeys.md)"',
        "---",
        "Body",
      ].join("\n"),
    );

    expect(parsed.error).toBeNull();
    expect(parsed.metadata).toEqual({
      inputs: "Feature: text; Mode?: choice(new, rework)",
      outputs: "Journeys: file(journeys.md)",
    });
  });

  it("keeps only string values of the metadata map", () => {
    const parsed = parseSkillMetadata(
      [
        "---",
        "name: mixed",
        "description: Mixed values",
        "metadata:",
        "  version: 2",
        "  enabled: true",
        "  tags: [a, b]",
        "  nested:",
        "    key: value",
        '  author: "someone"',
        "---",
      ].join("\n"),
    );

    expect(parsed.metadata).toEqual({ author: "someone" });
  });

  it.each([
    ["absent", ["---", "name: plain", "description: Plain", "---"]],
    [
      "a list",
      ["---", "name: listed", "description: Listed", "metadata: [a, b]", "---"],
    ],
    [
      "a scalar",
      ["---", "name: scalar", "description: Scalar", "metadata: text", "---"],
    ],
    ["malformed frontmatter", ["---", "name: [unclosed", "---"]],
    ["missing frontmatter", ["# No frontmatter"]],
  ])("returns an empty map when metadata is %s", (_label, lines) => {
    expect(parseSkillMetadata(lines.join("\n")).metadata).toEqual({});
  });
});
