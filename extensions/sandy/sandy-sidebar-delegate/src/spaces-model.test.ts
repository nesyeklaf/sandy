import { describe, expect, it } from "vitest";
import { buildSpaces, DORMANT_AFTER_MS, type SpaceThread, type SpaceThreadFacts } from "./spaces-model";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface Row extends SpaceThread {
  facts: Partial<SpaceThreadFacts>;
}

function row(id: string, over: Partial<SpaceThread> = {}, facts: Partial<SpaceThreadFacts> = {}): Row {
  return {
    id,
    parentThreadId: null,
    projectId: "p1",
    sectionId: "s1",
    isArchived: false,
    isHidden: false,
    ...over,
    facts,
  };
}

function factsOf(thread: Row): SpaceThreadFacts {
  return {
    lifecycle: "active",
    asks: false,
    failed: false,
    working: false,
    pr: "none",
    orchestrator: false,
    activityAt: NOW,
    ...thread.facts,
  };
}

function build(threads: Row[], sections = [{ id: "s1", name: "One" }], matches?: (thread: Row) => boolean) {
  return buildSpaces({ threads, sections, facts: factsOf, matches, now: NOW, unassignedName: "No Space" });
}

describe("native section identity", () => {
  it("[native-section-identity] groups roots of different projects under the section id and leaves project ids unchanged", () => {
    const [space] = build([row("a", { projectId: "p1" }), row("b", { projectId: "p2" })]);
    expect(space?.id).toBe("s1");
    expect(space?.roots.map((root) => [root.rootId, root.projectId])).toEqual([
      ["a", "p1"],
      ["b", "p2"],
    ]);
    expect(space?.repositories).toBe(2);
  });

  it("keeps empty named sections in order and puts the unassigned bucket last only when it has roots", () => {
    const sections = [
      { id: "s1", name: "One" },
      { id: "s2", name: "Two" },
    ];
    expect(build([], sections).map((space) => [space.id, space.total])).toEqual([
      ["s1", 0],
      ["s2", 0],
    ]);
    const spaces = build([row("a", { sectionId: null }), row("b", { sectionId: "gone" })], sections);
    expect(spaces.map((space) => [space.id, space.total])).toEqual([
      ["s1", 0],
      ["s2", 0],
      [null, 2],
    ]);
  });
});

describe("orphan visibility", () => {
  it("[orphan-visibility] keeps an orphaned visible session reachable once and never makes hidden workers roots", () => {
    const spaces = build([
      row("orphan", { parentThreadId: "missing" }),
      row("worker", { parentThreadId: "missing", isHidden: true }),
    ]);
    expect(spaces[0]?.roots.map((root) => root.rootId)).toEqual(["orphan"]);
  });
});

describe("descendant rollup", () => {
  it("[descendant-rollup] counts a root with two asking hidden descendants once", () => {
    const [space] = build([
      row("root"),
      row("w1", { parentThreadId: "root", isHidden: true }, { asks: true }),
      row("w2", { parentThreadId: "root", isHidden: true }, { asks: true }),
    ]);
    expect(space?.total).toBe(1);
    expect(space?.counts.needs).toBe(1);
    expect(space?.roots[0]?.shelf).toBe("needs");
  });

  it("[safe-rollup] terminates on cycles and ignores archived descendants", () => {
    const [space] = build([
      row("root", { parentThreadId: "w" }),
      row("w", { parentThreadId: "root" }),
      row("solo"),
      row("gone", { parentThreadId: "solo", isArchived: true, isHidden: true }, { asks: true }),
    ]);
    expect(space?.roots.map((root) => root.rootId)).toEqual(["root", "solo"]);
    expect(space?.counts.needs).toBe(0);
  });
});

describe("overlapping counts", () => {
  it("[overlapping-counts] keeps total one for a working root with an open PR and counts both signals", () => {
    const [space] = build([row("a", {}, { working: true, pr: "open" })]);
    expect(space?.total).toBe(1);
    expect(space?.counts).toMatchObject({ working: 1, openPr: 1 });
    expect(space?.roots[0]?.shelf).toBe("working");
  });

  it("[pr-session-count] counts sessions sharing one PR as two sessions", () => {
    const [space] = build([row("a", {}, { pr: "open" }), row("b", {}, { pr: "open" })]);
    expect(space?.counts.openPr).toBe(2);
    expect(space?.total).toBe(2);
  });
});

describe("primary shelf", () => {
  it("[primary-shelf] shows an asking root with an open PR once under needs", () => {
    const [space] = build([row("a", {}, { asks: true, pr: "open" })]);
    expect(space?.roots).toHaveLength(1);
    expect(space?.roots[0]).toMatchObject({ shelf: "needs", signals: { needs: true, openPr: true } });
  });

  it("follows the documented precedence", () => {
    const shelfOf = (facts: Partial<SpaceThreadFacts>) => build([row("a", {}, facts)])[0]?.roots[0]?.shelf;
    expect(shelfOf({ failed: true, working: true })).toBe("failed");
    expect(shelfOf({ working: true, pr: "merged" })).toBe("working");
    expect(shelfOf({ pr: "open", orchestrator: true })).toBe("review");
    expect(shelfOf({ pr: "merged", orchestrator: true })).toBe("merged");
    expect(shelfOf({ orchestrator: true })).toBe("orchestrators");
    expect(shelfOf({})).toBe("idle");
  });
});

describe("lifecycle safety", () => {
  it("[lifecycle-safety] keeps snoozed, parked and settled roots on their lifecycle shelves without signals", () => {
    const [space] = build([
      row("a", {}, { lifecycle: "snoozed", asks: true }),
      row("b", {}, { lifecycle: "parked", pr: "open" }),
      row("c", {}, { lifecycle: "settled", activityAt: 0 }),
      row("d", { isArchived: true }),
    ]);
    expect(space?.roots.map((root) => root.shelf)).toEqual(["snoozed", "snoozed", "archived"]);
    expect(space?.total).toBe(3);
    expect(space?.counts).toEqual({ needs: 0, failed: 0, working: 0, openPr: 0, dormant: 0 });
  });
});

describe("dormancy", () => {
  it("[dormancy-boundary] is dormant exactly at seven complete days", () => {
    const [space] = build([
      row("a", {}, { activityAt: NOW - (DORMANT_AFTER_MS - 1) }),
      row("b", {}, { activityAt: NOW - DORMANT_AFTER_MS }),
    ]);
    expect(space?.roots.map((root) => root.shelf)).toEqual(["idle", "dormant"]);
    expect(space?.counts.dormant).toBe(1);
    expect(space?.idle).toBe(1);
  });

  it("reproduces the approved Sandy fixture counts exactly", () => {
    const [space] = build([
      row("ask1", { projectId: "p1" }, { asks: true }),
      row("parent", { projectId: "p1" }),
      row("child", { projectId: "p1", parentThreadId: "parent", isHidden: true }, { asks: true }),
      row("work", { projectId: "p2" }, { working: true, pr: "open" }),
      row("old", { projectId: "p2" }, { activityAt: NOW - 10 * DAY }),
      row("wait", { projectId: "p2" }),
    ]);
    expect(space).toMatchObject({ total: 5, idle: 1, repositories: 2 });
    expect(space?.counts).toEqual({ needs: 2, failed: 0, working: 1, openPr: 1, dormant: 1 });
  });

  it("[tree-last-activity] uses the latest activity of the eligible tree", () => {
    const [space] = build([
      row("root", {}, { activityAt: NOW - 10 * DAY }),
      row("child", { parentThreadId: "root", isHidden: true }, { activityAt: NOW - DAY }),
    ]);
    expect(space?.roots[0]?.shelf).toBe("idle");
  });
});

describe("unknown PR", () => {
  it("[unknown-pr] is neither an open PR nor dormant", () => {
    const [space] = build([row("a", {}, { pr: "unknown", activityAt: 0 })]);
    expect(space?.counts).toMatchObject({ openPr: 0, dormant: 0 });
    expect(space?.roots[0]?.shelf).toBe("idle");
  });
});

describe("global filter", () => {
  it("counts only matching roots and keeps every named Space", () => {
    const sections = [
      { id: "s1", name: "One" },
      { id: "s2", name: "Two" },
    ];
    const spaces = build(
      [
        row("a", { projectId: "p1", sectionId: "s1" }, { asks: true }),
        row("b", { projectId: "p2", sectionId: "s2" }, { asks: true }),
      ],
      sections,
      (thread) => thread.projectId === "p1",
    );
    expect(spaces.map((space) => [space.id, space.total, space.counts.needs])).toEqual([
      ["s1", 1, 1],
      ["s2", 0, 0],
    ]);
  });
});

describe("archived visibility", () => {
  it("excludes archived roots by default and shows them without signals when included", () => {
    const threads = [row("live", {}, { asks: true }), row("gone", { isArchived: true }, { asks: true })];
    expect(build(threads)[0]?.total).toBe(1);
    const [space] = buildSpaces({
      threads,
      sections: [{ id: "s1", name: "One" }],
      facts: factsOf,
      includeArchived: true,
      now: NOW,
      unassignedName: "No Space",
    });
    expect(space?.roots.map((root) => [root.rootId, root.shelf])).toEqual([
      ["live", "needs"],
      ["gone", "archived"],
    ]);
    expect(space?.counts.needs).toBe(1);
    expect(space?.idle).toBe(0);
  });
});
