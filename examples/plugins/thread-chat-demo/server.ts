import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

export default function plugin(sandy: SandyPluginApi) {
  sandy.log.info("thread-chat-demo loaded (frontend-only demo)");
}
