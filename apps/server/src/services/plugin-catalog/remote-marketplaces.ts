import {
  deletePluginMarketplace,
  getInstalledPlugin,
  listInstalledPluginsFromMarketplace,
  listPluginMarketplaces,
  setInstalledPluginDirectProvenance,
  type DbConnection,
} from "@sandy/db";

export const LEGACY_COMMUNITY_MARKETPLACE_NAME = "sandy-community";

export function removeRemoteMarketplaces(db: DbConnection): string[] {
  const removed: string[] = [];
  db.transaction((tx) => {
    for (const marketplace of listPluginMarketplaces(tx)) {
      if (marketplace.sourceKind !== "https") continue;
      for (const plugin of listInstalledPluginsFromMarketplace(
        tx,
        marketplace.name,
      )) {
        if (
          marketplace.name === LEGACY_COMMUNITY_MARKETPLACE_NAME &&
          getInstalledPlugin(db, plugin.id)?.sourceKind === "builtin"
        ) {
          continue;
        }
        setInstalledPluginDirectProvenance(tx, plugin.id);
      }
      deletePluginMarketplace(tx, marketplace.name);
      removed.push(marketplace.name);
    }
  });
  return removed;
}
