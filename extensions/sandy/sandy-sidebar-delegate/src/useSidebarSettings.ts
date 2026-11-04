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
  return useSidebarSettingsState().settings;
}

export type UpdateSidebarSettings = (patch: Partial<SidebarSettingsValues>) => Promise<void>;

export function useSidebarSettingsState(): {
  settings: SidebarSettingsValues | null;
  update: UpdateSidebarSettings;
} {
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
  const update = useCallback<UpdateSidebarSettings>(
    async (patch) => {
      const seq = ++loadRequestSeq.current;
      setSettings((current) => (current ? { ...current, ...patch } : current));
      try {
        const result = await rpc.call("updateSidebarSettings", patch);
        if (seq === loadRequestSeq.current) setSettings(cacheSidebarSettings(rpc, result));
      } catch {
        void load();
      }
    },
    [load, rpc],
  );
  return { settings, update };
}
