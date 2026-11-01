import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@sandy-sdk/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerClaudeAiService } from "./ai-service.js";
import type { ClaudeAiStatus, ClaudeAiTextResult } from "./ai/host-contract.js";

function setup(
  answer: (
    call: ExperimentalFakeHostRpcCall,
  ) => ClaudeAiTextResult | ClaudeAiStatus,
  primaryHostId: string | null = "host-1",
) {
  const { sandy, harness } = createFakePluginHost({
    sdk: { system: { config: async () => ({ primaryHostId }) } },
    experimental_callHostRpc: answer,
  });
  registerClaudeAiService(sandy);
  const [service] = harness.registrations.aiServiceRegistrations;
  if (service?.complete === undefined || service.status === undefined) {
    throw new Error(
      "Claude Code did not register a complete and status service",
    );
  }
  return {
    service,
    complete: service.complete,
    status: service.status,
    calls: harness.inspection.experimental_hostRpcCalls,
  };
}

describe("Claude Code AI service", () => {
  it("asks the primary machine for a cheap-model completion", async () => {
    const claude = setup(() => ({ ok: true, text: "Fix login bug" }));
    const signal = new AbortController().signal;

    await expect(claude.complete("Write a title", { signal })).resolves.toBe(
      "Fix login bug",
    );
    expect(claude.calls.map((call) => call.input)).toEqual([
      { model: "haiku", prompt: "Write a title", timeoutMs: 6_000 },
    ]);
    expect(claude.calls[0]?.signal).toBe(signal);
  });

  it("surfaces a host failure as an error", async () => {
    const claude = setup(() => ({
      ok: false,
      message: "Run claude to sign in",
    }));

    await expect(
      claude.complete("Write a title", {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Run claude to sign in");
  });

  it("fails without a primary machine and makes no host call", async () => {
    const claude = setup(() => ({ ok: true, text: "x" }), null);

    await expect(
      claude.complete("Write a title", {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("No primary machine is connected");
    await expect(claude.status()).resolves.toEqual({
      ready: false,
      message: "No primary machine is connected",
    });
    expect(claude.calls).toEqual([]);
  });

  it("reports the host's status", async () => {
    const claude = setup(() => ({
      ready: false,
      message: "Claude Code is not installed",
    }));

    await expect(claude.status()).resolves.toEqual({
      ready: false,
      message: "Claude Code is not installed",
    });
  });
});
