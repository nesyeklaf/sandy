import type { DensityShelf, RowDensity, SidebarSettingsValues, ThreadDensity } from "./sidebar-settings-values";

export function shelfDensity(
  settings: Pick<SidebarSettingsValues, "threadDensity" | "shelfDensities">,
  shelf: DensityShelf,
): ThreadDensity {
  const override = settings.shelfDensities[shelf];
  if (override !== "default") return override;
  return settings.threadDensity;
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
  const resolved = density !== "auto" ? density : needsAttention || working ? "comfortable" : "compact";
  return keepFull ? "comfortable" : resolved;
}
