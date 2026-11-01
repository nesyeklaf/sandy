import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

export default function plugin(sandy: SandyPluginApi) {
  sandy.log.info("0.4.8 scaffold upgrade fixture loaded");
}
