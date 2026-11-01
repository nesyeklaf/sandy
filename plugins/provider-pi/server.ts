import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default function plugin(sandy: SandyPluginApi): void {
  const registered = sandy.providers.register(piProviderDeclaration());
  sandy.onDispose(() => {
    registered.dispose();
  });
}
