import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { spaceChannel } from "./realtime-channels";
import type { SpaceCoordination } from "./space-coordination-contract";
import { toast } from "./lib/toast";

export type SidebarRpc = ReturnType<typeof useRpc<typeof sandySidebarRpcContract>>;

export interface SpaceCoordinationState {
  space: SpaceCoordination | null;
  error: string | null;
  rpc: SidebarRpc;
  act: (failure: string, run: () => Promise<unknown>) => Promise<boolean>;
}

export function useSpaceCoordination(spaceId: string | null): SpaceCoordinationState {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [space, setSpace] = useState<SpaceCoordination | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    if (spaceId === null) return;
    const ticket = ++latest.current;
    try {
      const next = await rpc.call("getSpaceCoordination", { spaceId });
      if (ticket !== latest.current) return;
      setSpace(next);
      setError(null);
    } catch (failure) {
      if (ticket === latest.current) setError(failure instanceof Error ? failure.message : "Request failed");
    }
  }, [rpc, spaceId]);
  useEffect(() => {
    setSpace(null);
    void refresh();
  }, [refresh]);
  useRealtime(spaceChannel(spaceId ?? ""), () => void refresh());
  const act = useCallback(
    async (failure: string, run: () => Promise<unknown>) => {
      try {
        await run();
        await refresh();
        return true;
      } catch (cause) {
        toast.error(failure, { description: cause instanceof Error ? cause.message : undefined });
        return false;
      }
    },
    [refresh],
  );
  return { space, error, rpc, act };
}
