declare const __SANDY_PLUGIN_ID__: string | undefined;

export function usePortalScopeProps(): {
  "data-sandy-portaled-overlay": "";
  "data-sandy-plugin-root"?: "";
  "data-sandy-plugin"?: string;
} {
  const pluginId =
    typeof __SANDY_PLUGIN_ID__ === "string" ? __SANDY_PLUGIN_ID__ : undefined;
  return {
    "data-sandy-portaled-overlay": "",
    "data-sandy-plugin-root": "",
    ...(pluginId !== undefined ? { "data-sandy-plugin": pluginId } : {}),
  };
}
