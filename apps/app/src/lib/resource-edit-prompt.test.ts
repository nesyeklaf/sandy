import { describe, expect, it } from "vitest";
import {
  buildPluginEditThreadPrompt,
  buildSkillEditThreadPrompt,
} from "@sandy/shared-ui/resource-edit-prompt";

describe("resource edit thread prompts", () => {
  it("gives the thread an unambiguous writable resource locator", () => {
    expect(
      buildPluginEditThreadPrompt({
        name: "Pattern Atlas",
        path: "/Users/me/plugins/pattern-atlas",
      }),
    ).toBe(
      'Edit the sandy plugin "Pattern Atlas" at /Users/me/plugins/pattern-atlas. I want to ',
    );
    expect(
      buildSkillEditThreadPrompt({
        id: "skill_abc123",
        name: "Review PR",
        path: "/Users/me/.sandy/skills/review-pr/SKILL.md",
      }),
    ).toBe(
      'Edit the sandy skill "Review PR" (ID skill_abc123) at /Users/me/.sandy/skills/review-pr/SKILL.md. Inspect it with sandy skill show skill_abc123 --json and pass that revision to sandy skill update when saving. I want to ',
    );
  });
});
