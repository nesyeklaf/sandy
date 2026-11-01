import test from "node:test";
import assert from "node:assert/strict";
import { decide, parsePolicy, policyHash, type Policy } from "../shared/policy.ts";

const policy: Policy = { delegationId: "dlg_1", snapshotHash: "snap_1", allowTools: ["read", "grep"], transportTools: ["codemode"] };

test("decide: null (not a delegate) allows everything", () => {
  for (const toolName of ["edit", "bash", "codemode", "mcp__x__write"]) {
    assert.deepEqual(decide(null, { toolName }), { allow: true });
    assert.deepEqual(decide(null, { toolName, parentToolCallId: "c1" }), { allow: true });
  }
});

test("decide: pending denies everything, also allowlisted names and transports", () => {
  for (const toolName of ["read", "codemode", "sandy_delegate_brief"]) {
    const decision = decide("pending", { toolName });
    assert.equal(decision.allow, false);
    assert.match((decision as { reason: string }).reason, /not applied yet/);
  }
  assert.equal(decide("pending", { toolName: "read", parentToolCallId: "c1" }).allow, false);
});

test("decide: allowlisted tool allowed, other tool denied", () => {
  assert.deepEqual(decide(policy, { toolName: "read" }), { allow: true });
  const denied = decide(policy, { toolName: "edit" });
  assert.equal(denied.allow, false);
  assert.match((denied as { reason: string }).reason, /"edit" is not in this delegate's allowlist/);
});

test("decide: names match exactly, an mcp__<server>__<name> alias is not folded onto an allowed name", () => {
  assert.equal(decide(policy, { toolName: "mcp__sandy_pi_extension__read" }).allow, false);
  assert.equal(decide(policy, { toolName: "mcp__evil__read", parentToolCallId: "c1/1" }).allow, false);
  assert.equal(decide(policy, { toolName: "mcp__x__codemode" }).allow, false, "alias of a listed transport");
  assert.deepEqual(decide(policy, { toolName: "read" }), { allow: true });
});

test("decide: nested calls are checked against allowTools", () => {
  assert.deepEqual(decide(policy, { toolName: "read", parentToolCallId: "c1" }), { allow: true });
  assert.equal(decide(policy, { toolName: "write", parentToolCallId: "c1" }).allow, false);
  assert.deepEqual(decide(policy, { toolName: "grep", parentToolCallId: "c1/2" }), { allow: true });
});

test("decide: codemode is allowed only as a direct call listed in transportTools", () => {
  assert.deepEqual(decide(policy, { toolName: "codemode" }), { allow: true });
  assert.equal(decide(policy, { toolName: "codemode", parentToolCallId: "c1" }).allow, false, "never nested");
  const noTransport: Policy = { ...policy, transportTools: [] };
  assert.equal(decide(noTransport, { toolName: "codemode" }).allow, false);
  const inAllowOnly: Policy = { ...policy, allowTools: ["read", "codemode"], transportTools: [] };
  const decision = decide(inAllowOnly, { toolName: "codemode" });
  assert.equal(decision.allow, false, "allowTools does not grant a transport");
  assert.match((decision as { reason: string }).reason, /transport tool "codemode"/);
});

test("policyHash: stable under list reordering and duplicates, sensitive to content", () => {
  const hash = policyHash(policy);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(policyHash({ ...policy, allowTools: ["grep", "read"] }), hash);
  assert.equal(policyHash({ ...policy, allowTools: ["grep", "read", "grep"] }), hash);
  assert.notEqual(policyHash({ ...policy, allowTools: ["read"] }), hash);
  assert.notEqual(policyHash({ ...policy, transportTools: [] }), hash);
  assert.notEqual(policyHash({ ...policy, delegationId: "dlg_2" }), hash);
  assert.notEqual(policyHash({ ...policy, snapshotHash: "snap_2" }), hash);
});

test("parsePolicy: accepts a policy, rejects malformed ones and non-transport transportTools", () => {
  assert.deepEqual(parsePolicy(JSON.parse(JSON.stringify(policy))), policy);
  for (const bad of [null, "x", {}, { ...policy, delegationId: "" }, { ...policy, snapshotHash: 1 }, { ...policy, allowTools: "read" }, { ...policy, allowTools: [""] }, { ...policy, transportTools: undefined }]) {
    assert.throws(() => parsePolicy(bad));
  }
  assert.throws(() => parsePolicy({ ...policy, transportTools: ["codemode", "edit"] }), /non-transport tools: edit/);
});
