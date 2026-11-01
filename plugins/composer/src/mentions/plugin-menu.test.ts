import { describe, expect, it, vi } from "vitest";
import type {
  ExperimentalComposerMenuContribution,
  ExperimentalComposerMenuItem,
} from "@sandy-sdk/plugin-sdk/app";
import {
  childPath,
  parentPath,
  pluginMenuMentionTriggers,
  pluginMenuView,
} from "./plugin-menu";

const tree: ExperimentalComposerMenuItem[] = [
  {
    id: "build",
    label: "Build",
    items: [
      { id: "quick", label: "Quick feature", run: vi.fn() },
      {
        id: "deep",
        label: "Deep dives",
        items: [{ id: "audit", label: "Audit", run: vi.fn() }],
      },
    ],
  },
  { id: "plan", label: "Plan", run: vi.fn() },
];

function contribution(
  trigger: "/" | "!",
  items: (query: string) => readonly ExperimentalComposerMenuItem[],
): ExperimentalComposerMenuContribution {
  return {
    key: `p/${trigger}`,
    pluginId: "p",
    customizationId: "c",
    menu: { id: "m", trigger, label: "Flows", items },
  } as unknown as ExperimentalComposerMenuContribution;
}

describe("pluginMenuView", () => {
  it("lists top-level rows of the menus for the trigger only", () => {
    const bang = contribution("!", () => tree);
    const slash = contribution("/", () => tree);
    const view = pluginMenuView([bang, slash], "!", "", null);
    expect(view.breadcrumb).toEqual([]);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.label).toBe("Flows");
    expect(view.groups[0]?.suggestions.map((row) => row.item.id)).toEqual([
      "build",
      "plan",
    ]);
  });

  it("passes the query to the plugin at the top level", () => {
    const items = vi.fn(() => tree);
    pluginMenuView([contribution("!", items)], "!", "pl", null);
    expect(items).toHaveBeenCalledWith("pl");
  });

  it("walks into a submenu, filters its rows by label and tracks the breadcrumb", () => {
    const bang = contribution("!", () => tree);
    const first = pluginMenuView([bang], "!", "", null).groups[0]!
      .suggestions[0]!;
    const path = childPath(first);
    const open = pluginMenuView([bang], "!", "", path);
    expect(open.breadcrumb).toEqual(["Flows", "Build"]);
    expect(open.groups[0]?.suggestions.map((row) => row.item.id)).toEqual([
      "quick",
      "deep",
    ]);
    const filtered = pluginMenuView([bang], "!", "audi", {
      ...path,
      ids: ["build", "deep"],
    });
    expect(filtered.breadcrumb).toEqual(["Flows", "Build", "Deep dives"]);
    expect(filtered.groups[0]?.suggestions.map((row) => row.item.id)).toEqual([
      "audit",
    ]);
    expect(parentPath({ ...path, ids: ["build", "deep"] })).toEqual(path);
    expect(parentPath(path)).toBeNull();
  });

  it("falls back to the top level when the path no longer exists", () => {
    const bang = contribution("!", () => tree);
    const view = pluginMenuView([bang], "!", "", {
      contributionKey: bang.key,
      ids: ["gone"],
    });
    expect(view.breadcrumb).toEqual([]);
    expect(view.groups[0]?.suggestions).toHaveLength(2);
  });

  it("contains a throwing menu instead of breaking the composer", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = contribution("!", () => {
      throw new Error("boom");
    });
    expect(pluginMenuView([broken], "!", "", null).groups).toEqual([]);
    error.mockRestore();
  });
});

describe("pluginMenuMentionTriggers", () => {
  it("returns each non-slash trigger once", () => {
    expect(
      pluginMenuMentionTriggers([
        contribution("!", () => []),
        contribution("!", () => []),
        contribution("/", () => []),
      ]),
    ).toEqual(["!"]);
  });
});
