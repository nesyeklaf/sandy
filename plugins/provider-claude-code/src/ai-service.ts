import type { SandyPluginApi, PluginAiServiceStatus } from "@sandy-sdk/plugin-sdk";
import {
  claudeAiHostContract,
  type ClaudeAiTextResult,
} from "./ai/host-contract.js";

const CLAUDE_TEXT_MODEL = "haiku";
const COMPLETE_TIMEOUT_MS = 6_000;
const HOST_CALL_GRACE_MS = 1_000;

export function registerClaudeAiService(sandy: SandyPluginApi): void {
  const host = sandy.hosts.experimental_client({ contract: claudeAiHostContract });

  async function primaryHostId(): Promise<string | null> {
    return (await sandy.sdk.system.config()).primaryHostId;
  }

  function textOrThrow(result: ClaudeAiTextResult): string {
    if (result.ok) return result.text;
    throw new Error(result.message);
  }

  sandy.experimental_aiServices.register({
    id: "claude-code",
    displayName: "Claude Code",
    async complete(prompt, { signal }) {
      const hostId = await primaryHostId();
      if (hostId === null) {
        throw new Error("No primary machine is connected");
      }
      return textOrThrow(
        await host.call(
          "claude.ai.complete",
          { model: CLAUDE_TEXT_MODEL, prompt, timeoutMs: COMPLETE_TIMEOUT_MS },
          {
            hostId,
            signal,
            timeoutMs: COMPLETE_TIMEOUT_MS + HOST_CALL_GRACE_MS,
          },
        ),
      );
    },
    async status(): Promise<PluginAiServiceStatus> {
      const hostId = await primaryHostId();
      if (hostId === null) {
        return { ready: false, message: "No primary machine is connected" };
      }
      return host.call("claude.ai.status", {}, { hostId, timeoutMs: 5_000 });
    },
  });
}
