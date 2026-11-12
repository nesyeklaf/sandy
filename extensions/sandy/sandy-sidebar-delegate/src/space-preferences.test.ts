import { beforeEach, describe, expect, it } from "vitest";
import { decodeSettingsCache } from "./lib/settings-cache-codec";
import { listViewCodec } from "./lib/inbox-preference-codecs";
import { expandedFromTreeCollapse, spaceExpansionCodec, treeMigratingExpansionCodec } from "./lib/space-preferences";
import { DEFAULT_SIDEBAR_SETTINGS, spaceHeaderDensityOf } from "./sidebar-settings-values";

beforeEach(() => localStorage.clear());

describe("tree migration", () => {
  it("[tree-migration] reads a saved Tree layout as Spaces and keeps Flow", () => {
    expect(listViewCodec.decode("tree")).toBe("spaces");
    expect(listViewCodec.decode("flow")).toBe("flow");
    expect(listViewCodec.decode("spaces")).toBe("spaces");
  });

  it("carries known section collapse choices into Space expansion", () => {
    const expanded = expandedFromTreeCollapse(["a", "b", "c"], new Set(["b", "stale"]));
    expect([...expanded]).toEqual(["a", "c"]);
  });

  it("migrates saved Tree collapse when no Space expansion is stored and starts collapsed otherwise", () => {
    expect(treeMigratingExpansionCodec(["a", "b"]).fallback().size).toBe(0);
    localStorage.setItem("sandy-sidebar:tree-collapse:v1", JSON.stringify(["b"]));
    expect([...treeMigratingExpansionCodec(["a", "b"]).fallback()]).toEqual(["a"]);
    localStorage.setItem("sandy-sidebar:tree-collapse:v1", "{");
    expect(treeMigratingExpansionCodec(["a", "b"]).fallback().size).toBe(0);
  });
});

describe("safe defaults", () => {
  it("[safe-defaults] defaults to Spaces, collapsed Spaces and Compact headers, and recovers from invalid values", () => {
    expect(listViewCodec.decode(null)).toBeNull();
    expect(listViewCodec.fallback()).toBe("spaces");
    expect(listViewCodec.decode("nonsense")).toBeNull();
    expect(spaceExpansionCodec.fallback().size).toBe(0);
    expect(spaceExpansionCodec.decode("{}")).toBeNull();
    expect([...(spaceExpansionCodec.decode('["a",1,"b"]') ?? [])]).toEqual(["a", "b"]);
    expect(spaceHeaderDensityOf("wide")).toBe("compact");
    expect(spaceHeaderDensityOf("detailed")).toBe("detailed");
  });
});

describe("independent settings", () => {
  it("[independent-settings] keeps session density and shelf overrides when the header density is invalid or changes", () => {
    const saved = {
      ...DEFAULT_SIDEBAR_SETTINGS,
      threadDensity: "auto" as const,
      shelfDensities: { ...DEFAULT_SIDEBAR_SETTINGS.shelfDensities, working: "dense" as const },
      spaceHeaderDensity: "wide",
    };
    const decoded = decodeSettingsCache(saved);
    expect(decoded?.spaceHeaderDensity).toBe("compact");
    expect(decoded?.threadDensity).toBe("auto");
    expect(decoded?.shelfDensities.working).toBe("dense");
    const switched = decodeSettingsCache({ ...saved, spaceHeaderDensity: "minimal" });
    expect(switched).toMatchObject({ spaceHeaderDensity: "minimal", threadDensity: "auto" });
    expect(switched?.shelfDensities.working).toBe("dense");
  });
});

describe("flow preserved", () => {
  it("[flow-preserved] leaves an explicit Flow choice as the initial view", () => {
    localStorage.setItem("sandy-sidebar:list-view:v1", "flow");
    expect(listViewCodec.decode(localStorage.getItem("sandy-sidebar:list-view:v1"))).toBe("flow");
  });
});
