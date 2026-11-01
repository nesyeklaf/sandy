import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk";
import { buildTree, NO_SECTION_KEY, worstIndicator } from "./tree-layout";

function thread(id: string, extra: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    projectId: "p1",
    sectionId: null,
    parentThreadId: null,
    indicator: "none",
    ...extra,
  } as PluginSidebarThread;
}

const projects = [
  { id: "p1", name: "alpha", isPersonal: false },
  { id: "p2", name: "beta", isPersonal: false },
  { id: "me", name: "Personal", isPersonal: true },
];
const sections = [
  { id: "s1", name: "Launch" },
  { id: "s2", name: "Empty" },
  { id: "s3", name: "Later" },
];

describe("buildTree", () => {
  it("groups sessions by section, then repo, in section order", () => {
    const tree = buildTree({
      sections,
      projects,
      threads: [
        thread("a", { sectionId: "s3" }),
        thread("b", { sectionId: "s1", projectId: "p2" }),
        thread("c", { sectionId: "s1", projectId: "p1" }),
        thread("d", { sectionId: "s1", projectId: "p2" }),
      ],
    });
    expect(tree.map((section) => section.name)).toEqual(["Launch", "Later"]);
    expect(tree[0].repos.map((repo) => [repo.name, repo.threads.map((t) => t.id)])).toEqual([
      ["beta", ["b", "d"]],
      ["alpha", ["c"]],
    ]);
    expect(tree[0].count).toBe(3);
  });

  it("puts one repo into several sections independently", () => {
    const tree = buildTree({
      sections,
      projects,
      threads: [thread("a", { sectionId: "s1" }), thread("b", { sectionId: "s3" })],
    });
    expect(tree.map((section) => section.repos[0].projectId)).toEqual(["p1", "p1"]);
  });

  it("hangs sessions without a repo directly under the section", () => {
    const tree = buildTree({
      sections,
      projects,
      threads: [thread("a", { sectionId: "s1", projectId: "me" }), thread("b", { sectionId: "s1", projectId: "gone" })],
    });
    expect(tree[0].loose.map((t) => t.id)).toEqual(["a", "b"]);
    expect(tree[0].repos).toEqual([]);
  });

  it("collects unassigned and unknown-section sessions last under the catch-all", () => {
    const tree = buildTree({
      sections,
      projects,
      noSectionName: "No project",
      threads: [thread("a"), thread("b", { sectionId: "deleted" }), thread("c", { sectionId: "s1" })],
    });
    expect(tree.map((section) => section.key)).toEqual(["s1", NO_SECTION_KEY]);
    expect(tree[1]).toMatchObject({ sectionId: null, name: "No project", count: 2 });
  });

  it("leaves out children whose parent is listed, and keeps orphans", () => {
    const tree = buildTree({
      sections,
      projects,
      threads: [thread("a"), thread("kid", { parentThreadId: "a" }), thread("orphan", { parentThreadId: "missing" })],
    });
    expect(tree[0].repos[0].threads.map((t) => t.id)).toEqual(["a", "orphan"]);
  });

  it("returns nothing for no threads", () => {
    expect(buildTree({ sections, projects, threads: [] })).toEqual([]);
  });
});

describe("worstIndicator", () => {
  it("ranks failures above questions above live work above unread", () => {
    const of = (...indicators: PluginSidebarThread["indicator"][]) =>
      worstIndicator(indicators.map((indicator, i) => thread(String(i), { indicator })));
    expect(of("none", "unread-success", "runtime")).toBe("runtime");
    expect(of("runtime", "waiting-for-input")).toBe("waiting-for-input");
    expect(of("waiting-for-input", "unread-error")).toBe("unread-error");
    expect(of()).toBe("none");
  });
});
