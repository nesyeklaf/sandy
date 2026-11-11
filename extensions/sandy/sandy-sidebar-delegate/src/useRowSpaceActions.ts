import { useCallback } from "react";
import { useRpc, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { toast } from "./lib/toast";
import { useSpaceCoordination } from "./useSpaceCoordination";

interface RowSpaceActions {
  orchestrator: boolean;
  managed: boolean;
  toggleOrchestrator: () => void;
  toggleManaged: () => void;
}

export function useRowSpaceActions(thread: PluginSidebarThread): RowSpaceActions | null {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const { space } = useSpaceCoordination(thread.sectionId);
  const member = space?.members.find((entry) => entry.threadId === thread.id);
  const orchestrator = space?.orchestratorThreadIds.includes(thread.id) ?? false;
  const managed = member?.mode === "managed";
  const fail = (title: string) => (error: unknown) =>
    toast.error(title, { description: error instanceof Error ? error.message : undefined });
  const toggleOrchestrator = useCallback(() => {
    rpc
      .call("setOrchestrator", { threadId: thread.id, orchestrator: !orchestrator })
      .catch(fail("Could not change the orchestrator"));
  }, [rpc, thread.id, orchestrator]);
  const toggleManaged = useCallback(() => {
    rpc
      .call("setMemberMode", { threadId: thread.id, mode: managed ? "independent" : "managed" })
      .catch(fail("Could not change the mode"));
  }, [rpc, thread.id, managed]);
  if (thread.sectionId === null) return null;
  return { orchestrator, managed, toggleOrchestrator, toggleManaged };
}
