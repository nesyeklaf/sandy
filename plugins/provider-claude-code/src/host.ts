import os from "node:os";
import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@sandy-sdk/plugin-sdk/host";
import {
  completeWithClaudeResult,
  readClaudeAiStatus,
} from "./ai/claude-completion.js";
import { claudeAiHostContract } from "./ai/host-contract.js";
import { resolveClaudeNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const claudeHostContract = defineRpcContract({
  ...claudeAiHostContract,
  ...experimental_nativeRootsHostContract,
});

export default experimental_defineHostEntry({
  contract: claudeHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolveClaudeNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
    "claude.ai.complete": (input, context) =>
      completeWithClaudeResult(input, context.signal),
    "claude.ai.status": readClaudeAiStatus,
  },
});
