import { createCachedRpcState } from "./lib/cached-rpc-state";
import { currentSettingsOnly, settingsCacheCodec } from "./lib/settings-cache-codec";
import { STORAGE_KEYS } from "./lib/storage-keys";
import type { SidebarSettingsValues } from "./sidebar-settings-values";
export * from "./sidebar-settings-values";

const settingsCache = createCachedRpcState(STORAGE_KEYS.settings.key, settingsCacheCodec, {
  rememberStoredReads: true,
});

export function cachedSidebarSettings(rpcClient: object): SidebarSettingsValues | null {
  return settingsCache.read(rpcClient);
}

export function cacheSidebarSettings(rpcClient: object, values: SidebarSettingsValues): SidebarSettingsValues {
  return settingsCache.write(rpcClient, currentSettingsOnly(values));
}
