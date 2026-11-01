import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

export default function contentScriptExample(sandy: SandyPluginApi) {
  sandy.log.info("Content script example loaded");
}
