import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { SIDEBAR_SETTINGS_CHANNEL } from "./realtime-channels";
import { cachedSidebarSettings, cacheSidebarSettings, type SidebarSettingsValues } from "./sidebar-settings";

/**
 * The saved sidebar settings, read-only, kept current by the realtime channel.
 *
 * A mount and a realtime signal can start overlapping loads. Only the newest
 * one may land: an older answer arriving last would roll the view back to the
 * previous settings and write them over the shared cache.
 *
 * Null until the first load when nothing is cached yet.
 */
export function useSidebarSettings(): SidebarSettingsValues | null {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const loadRequestSeq = useRef(0);
  const [settings, setSettings] = useState<SidebarSettingsValues | null>(() => cachedSidebarSettings(rpc));
  const load = useCallback(async () => {
    const seq = ++loadRequestSeq.current;
    try {
      const result = await rpc.call("getSidebarSettings", {});
      if (seq !== loadRequestSeq.current) return;
      setSettings(cacheSidebarSettings(rpc, result));
    } catch {
      void 0; // Older test harnesses and a backend still reloading have no method yet.
    }
  }, [rpc]);
  useEffect(() => {
    void load();
    return () => {
      // An unmounted view drops whatever is still in flight.
      loadRequestSeq.current += 1;
    };
  }, [load]);
  useRealtime(SIDEBAR_SETTINGS_CHANNEL, () => {
    void load();
  });
  return settings;
}
