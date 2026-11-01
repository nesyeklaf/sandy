import {
  derivePluginId,
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_VERSION,
} from "@sandy/domain";

export function createPluginArtifactMeta(args: {
  packageName: string;
  pluginVersion: string;
  sandyVersion: string;
}) {
  return {
    sdkMajor: PLUGIN_SDK_MAJOR,
    sdkVersion: PLUGIN_SDK_VERSION,
    artifactFormatVersion: 1,
    pluginId: derivePluginId(args.packageName),
    pluginVersion: args.pluginVersion,
    builtWith: {
      sandyVersion: args.sandyVersion,
      pluginSdkVersion: PLUGIN_SDK_VERSION,
    },
  } as const;
}
