import type { DensityShelf, RowDensity, SidebarSettingsValues, ThreadDensity } from "./sidebar-settings-values";

const AUTO_SHELF_DENSITY: Record<DensityShelf, ThreadDensity> = {
  pinned: "auto",
  needs: "comfortable",
  failed: "comfortable",
  working: "compact",
  review: "dense",
  waiting: "dense",
  orchestrators: "comfortable",
  merged: "dense",
};

export function shelfDensity(
  settings: Pick<SidebarSettingsValues, "threadDensity" | "shelfDensities">,
  shelf: DensityShelf,
): ThreadDensity {
  const override = settings.shelfDensities[shelf];
  if (override !== "default") return override;
  return settings.threadDensity === "auto" ? AUTO_SHELF_DENSITY[shelf] : settings.threadDensity;
}

export function rowDensity({
  density,
  needsAttention,
  working,
  keepFull,
}: {
  density: ThreadDensity;
  needsAttention: boolean;
  working: boolean;
  keepFull: boolean;
}): RowDensity {
  if (keepFull) return "comfortable";
  if (density !== "auto") return density;
  if (needsAttention) return "comfortable";
  return working ? "compact" : "dense";
}
