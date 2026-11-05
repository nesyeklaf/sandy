import { useEffect } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { SkillOverview, rpcContract } from "./contract";
import { flowMenuItems } from "./flow-menu";
import { readStoredProject } from "./shared";

let overview: SkillOverview | null = null;

export const FLOW_MENU = {
  id: "flows",
  trigger: "!" as const,
  label: "Flows",
  items: (query: string) => flowMenuItems(overview, query),
};

export const FLOW_SLASH_MENU = {
  ...FLOW_MENU,
  id: "flows-slash",
  trigger: "/" as const,
};

export function FlowMenuLoader() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    const load = () => {
      rpc.call("overview", { projectId: readStoredProject() }).then(
        (next) => {
          overview = next;
        },
        () => {},
      );
    };
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [rpc]);
  return null;
}
