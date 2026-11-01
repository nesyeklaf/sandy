import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@sandy-sdk/plugin-sdk/host";
import { resolvePiNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

export default experimental_defineHostEntry({
  contract: experimental_nativeRootsHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolvePiNativeRoots({
        homeDir: homedir(),
        env: process.env,
        cwd: input.cwd,
      }),
  },
});
