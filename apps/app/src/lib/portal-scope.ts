import { useContext } from "react";
import { PluginContext } from "@/components/plugin/plugin-context";

export function usePortalScopeProps(): {
  "data-sandy-portaled-overlay": "";
  "data-sandy-plugin-root"?: "";
  "data-sandy-plugin"?: string;
} {
  const pluginId = useContext(PluginContext);
  return pluginId === null
    ? { "data-sandy-portaled-overlay": "" }
    : {
        "data-sandy-portaled-overlay": "",
        "data-sandy-plugin-root": "",
        "data-sandy-plugin": pluginId,
      };
}
