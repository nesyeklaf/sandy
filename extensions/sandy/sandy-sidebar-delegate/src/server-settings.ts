import { z } from "zod";
import type { ServerContext } from "./server-context";
import { sidebarSettingsSchema } from "./contract";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  shelfDensitiesOf,
  threadDensityOf,
  type SidebarSettingsValues,
} from "./sidebar-settings-values";

// Derive each field's fallback from the shared defaults. Adding a setting
// needs no repository change, and one invalid field cannot discard others.
const storedSettingsSchema = z.object(
  Object.fromEntries(
    Object.entries(sidebarSettingsSchema.shape).map(([key, schema]) => [
      key,
      (schema as z.ZodType).catch(DEFAULT_SIDEBAR_SETTINGS[key as keyof SidebarSettingsValues]),
    ]),
  ),
);

export async function createServerSettings(ctx: ServerContext) {
  const readSidebarSettings = (): SidebarSettingsValues => {
    const row = ctx.db.prepare("SELECT settings_json FROM sidebar_settings WHERE id = 1").get() as
      | { settings_json: string | null }
      | undefined;
    if (row?.settings_json == null) return { ...DEFAULT_SIDEBAR_SETTINGS };
    try {
      const stored: unknown = JSON.parse(row.settings_json);
      if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
        throw new Error("Expected a JSON object");
      }
      const threadDensity = threadDensityOf(stored);
      return sidebarSettingsSchema.parse(
        storedSettingsSchema.parse({
          ...DEFAULT_SIDEBAR_SETTINGS,
          ...stored,
          threadDensity,
          shelfDensities: shelfDensitiesOf((stored as { shelfDensities?: unknown }).shelfDensities),
          compactWorkingThreads: threadDensity !== "comfortable",
        }),
      );
    } catch (error) {
      ctx.sandy.log.warn(
        `Could not parse sidebar_settings.settings_json; using defaults: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ...DEFAULT_SIDEBAR_SETTINGS };
    }
  };

  const writeSidebarSettings = (values: SidebarSettingsValues): void => {
    ctx.db.prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1").run(JSON.stringify(values));
  };

  const hasStoredSidebarSettings =
    ctx.db.prepare(`SELECT 1 FROM sidebar_settings WHERE id = 1 AND settings_json IS NOT NULL`).get() !== undefined;
  if (!hasStoredSidebarSettings) {
    try {
      const legacy = await ctx.sandy.sdk.plugins.getSettings({
        pluginId: ctx.sandy.pluginId,
      });
      const values = legacy.values;
      const hasLegacyValues = [
        "snoozePresets",
        "showRunningChildrenWhenCollapsed",
        "autoSettleInactive",
        "autoSettleAfterDays",
        "autoSettleOnMerge",
      ].some((key) => key in values);
      const migrated = sidebarSettingsSchema.safeParse({
        ...DEFAULT_SIDEBAR_SETTINGS,
        snoozePresets:
          typeof values.snoozePresets === "string" ? values.snoozePresets : DEFAULT_SIDEBAR_SETTINGS.snoozePresets,
        showRunningChildrenWhenCollapsed:
          typeof values.showRunningChildrenWhenCollapsed === "boolean"
            ? values.showRunningChildrenWhenCollapsed
            : DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed,
        autoSettleInactive:
          typeof values.autoSettleInactive === "boolean"
            ? values.autoSettleInactive
            : DEFAULT_SIDEBAR_SETTINGS.autoSettleInactive,
        autoSettleAfterDays:
          typeof values.autoSettleAfterDays === "string"
            ? Number(values.autoSettleAfterDays)
            : DEFAULT_SIDEBAR_SETTINGS.autoSettleAfterDays,
        autoSettleOnMerge:
          typeof values.autoSettleOnMerge === "boolean"
            ? values.autoSettleOnMerge
            : DEFAULT_SIDEBAR_SETTINGS.autoSettleOnMerge,
      });
      if (hasLegacyValues && migrated.success) {
        writeSidebarSettings(migrated.data);
      }
    } catch {
      // A new install has no previous settings generation to migrate.
    }
  }

  return { readSidebarSettings, writeSidebarSettings };
}
