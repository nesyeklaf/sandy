// Tool policy of a delegated child and the gate decision over it. Pure: no I/O, no clock.
//
// A Policy says which tools one delegation may call:
// - delegationId: the ledger row the policy was resolved from (never a thread title).
// - snapshotHash: hash of the agent snapshot the allowlist comes from (prompt audit).
// - allowTools: exact tool names the child may call, directly or nested through a transport.
// - transportTools: tools that only carry other calls (today only "codemode"). A transport is
//   allowed as a direct call only when listed here; the calls it makes are checked one by one
//   against allowTools, and a transport is never allowed nested.
import { createHash } from "node:crypto";

export type Policy = {
  delegationId: string;
  snapshotHash: string;
  allowTools: string[];
  transportTools: string[];
};

// The gate's state: null = this pi session is not a delegate (the gate is a no-op),
// "pending" = a delegate whose policy is not applied yet (deny all), else the applied policy.
export type GateState = Policy | "pending" | null;

export type ToolCall = { toolName: string; parentToolCallId?: string };

export type Decision = { allow: true } | { allow: false; reason: string };

export const TRANSPORT_TOOLS: readonly string[] = ["codemode"];


export function decide(state: GateState, call: ToolCall): Decision {
  if (state === null) return { allow: true };
  if (state === "pending") {
    return { allow: false, reason: `sandy-delegate: tool "${call.toolName}" blocked, the delegation policy is not applied yet` };
  }
  // Exact names only: pi reports canonical names to tool_call (P3), and folding "mcp__<server>__<name>"
  // to "<name>" would let any MCP tool called e.g. "read" pass wherever read is allowed.
  const name = call.toolName;
  const nested = call.parentToolCallId !== undefined;
  if (TRANSPORT_TOOLS.includes(name)) {
    if (!nested && state.transportTools.includes(name)) return { allow: true };
    return { allow: false, reason: `sandy-delegate: transport tool "${name}" is not allowed ${nested ? "nested" : "for this delegate"}` };
  }
  if (state.allowTools.includes(name)) return { allow: true };
  return { allow: false, reason: `sandy-delegate: tool "${name}" is not in this delegate's allowlist` };
}

const sortedUnique = (names: string[]): string[] => [...new Set(names)].sort();

// sha256 over the canonical JSON {delegationId, snapshotHash, allowTools, transportTools} with both
// lists sorted and deduplicated, so the hash does not depend on list order.
export function policyHash(policy: Policy): string {
  const canonical = JSON.stringify({
    delegationId: policy.delegationId,
    snapshotHash: policy.snapshotHash,
    allowTools: sortedUnique(policy.allowTools),
    transportTools: sortedUnique(policy.transportTools),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Validates an untrusted value (the policy file of tests, or the answer of `sandy work delegate policy`) into a Policy; throws on
// anything else. transportTools may only name known transport tools, so a policy cannot let a
// normal tool skip the allowlist by listing it as a transport.
export function parsePolicy(value: unknown): Policy {
  if (typeof value !== "object" || value === null) throw new Error("policy must be an object");
  const { delegationId, snapshotHash, allowTools, transportTools } = value as Record<string, unknown>;
  if (typeof delegationId !== "string" || delegationId === "") throw new Error("policy.delegationId must be a non-empty string");
  if (typeof snapshotHash !== "string" || snapshotHash === "") throw new Error("policy.snapshotHash must be a non-empty string");
  const names = (field: string, list: unknown): string[] => {
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item !== "")) {
      throw new Error(`policy.${field} must be an array of tool names`);
    }
    return list as string[];
  };
  const transports = names("transportTools", transportTools);
  const unknown = transports.filter((name) => !TRANSPORT_TOOLS.includes(name));
  if (unknown.length > 0) throw new Error(`policy.transportTools names non-transport tools: ${unknown.join(", ")}`);
  return { delegationId, snapshotHash, allowTools: names("allowTools", allowTools), transportTools: transports };
}
