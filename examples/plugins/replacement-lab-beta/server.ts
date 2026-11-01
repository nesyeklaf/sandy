import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

export default function replacementLabBeta(sandy: SandyPluginApi) {
  sandy.log.info("Replacement Lab Beta loaded");
}
