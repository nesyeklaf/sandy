import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionRosters, extensionToolRosterGuidance } from "../src/core/system-guidance.js";

const entry = (name: string, sourceInfo?: { source?: string; path?: string }) => ({
  name,
  ...(sourceInfo === undefined ? {} : { sourceInfo }),
});

describe("extensionToolRosterGuidance", () => {
  it("lists tool names grouped by source namespace without descriptions", () => {
    const roster = extensionToolRosterGuidance(
      [
        entry("fovea_focus", { source: "pi-fovea" }),
        entry("fovea_dwell", { source: "pi-fovea" }),
        entry("openai_image", { source: "pi-better-openai" }),
      ],
      new Set(["read", "bash"]),
    );
    expect(roster).toContain("- pi-better-openai: openai_image");
    expect(roster).toContain("- pi-fovea: fovea_dwell, fovea_focus");
    expect(roster).toContain("tools.list");
  });

  it("falls back to path basenames, then a generic label", () => {
    const roster = extensionToolRosterGuidance(
      [
        entry("from_entry", { path: "/ext/pi-somewhere/index.js" }),
        entry("from_file", { path: "/ext/pi-other/cool.js" }),
        entry("bare"),
      ],
      new Set(),
    );
    expect(roster).toContain("- pi-somewhere: from_entry");
    expect(roster).toContain("- cool.js: from_file");
    expect(roster).toContain("- extensions: bare");
  });

  it("names local package tools by the nearest package.json manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-roster-"));
    try {
      const pkgDir = path.join(root, "pi-manifest-ext");
      mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "pi-manifest-ext" }));
      const roster = extensionToolRosterGuidance(
        [
          entry("tool_one", {
            source: "../../somewhere/relative/pi-manifest-ext",
            path: path.join(pkgDir, "dist", "index.js"),
          }),
        ],
        new Set(),
      );
      expect(roster).toContain("- pi-manifest-ext: tool_one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips npm: prefixes without touching the filesystem", () => {
    const roster = extensionToolRosterGuidance(
      [entry("tool_two", { source: "npm:@scope/pi-npm-ext", path: "/nonexistent/nowhere/index.js" })],
      new Set(),
    );
    expect(roster).toContain("- @scope/pi-npm-ext: tool_two");
  });

  it("keeps one roster per session although tools register after the first turn", () => {
    const rosters = createSessionRosters();
    const catalog = [entry("early_tool", { source: "npm:pi-early" })];
    const roster = () => extensionToolRosterGuidance(catalog, new Set());
    const first = rosters.get("session-1", "full", roster);
    catalog.push(entry("late_tool", { source: "npm:pi-late" }));
    expect(rosters.get("session-1", "full", roster)).toBe(first);
    expect(rosters.get("session-2", "full", roster)).toContain("- pi-late: late_tool");
    expect(rosters.get("session-1", "native", roster)).toContain("- pi-late: late_tool");
    rosters.forget("session-2");
    catalog.push(entry("later_tool", { source: "npm:pi-later" }));
    expect(rosters.get("session-2", "full", roster)).toContain("- pi-later: later_tool");
  });

  it("excludes captured core overrides and empty catalogs", () => {
    expect(extensionToolRosterGuidance([entry("read")], new Set(["read"]))).toBeUndefined();
    expect(extensionToolRosterGuidance([], new Set())).toBeUndefined();
  });
});
