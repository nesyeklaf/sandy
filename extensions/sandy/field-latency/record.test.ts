import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { clientSchema, isUnknownKeyRejection, rpcContract, sampleSchema, type Client, type RecordInput } from "./contract.ts";
import { createRecordSender } from "./record.ts";
import { sample } from "./fixtures.ts";

const NEW_CLIENT_FIELDS = { deviceId: true, platform: true, screen: true, refreshMs: true, gpu: true } as const;

const legacyInput = z
  .object({
    client: clientSchema.omit(NEW_CLIENT_FIELDS).strict(),
    samples: z.array(sampleSchema.omit({ load: true }).strict()).min(1).max(200),
  })
  .strict();

class FakeRpcError extends Error {
  readonly code = "invalid_input";
  readonly issues: { message: string; path?: (string | number)[] }[];
  constructor(issues: { message: string; path?: (string | number)[] }[]) {
    super("rpc input validation failed");
    this.issues = issues;
  }
}

function server(schema: z.ZodType) {
  const stored: unknown[] = [];
  const calls: unknown[] = [];
  return {
    stored,
    calls,
    call: async (input: RecordInput) => {
      calls.push(input);
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        throw new FakeRpcError(parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path.filter((part): part is string | number => typeof part !== "symbol") })));
      }
      stored.push(parsed.data);
      return { stored: 1 };
    },
  };
}

const client: Client = clientSchema.parse({
  userAgent: "Firefox/153.0",
  cores: 12,
  devicePixelRatio: 1,
  viewport: "2560x1440",
  deviceId: "0123456789abcdef",
  platform: "Linux",
  screen: "2560x1440",
  refreshMs: 6.9,
  gpu: "Radeon",
});

const loaded = sample({ load: { windowMs: 5000, busyPct: 12, maxLagMs: 80, pressure: null, charging: null, batteryPct: null } });

test("a server of the current version gets the full shape", async () => {
  const current = server(rpcContract.record.input);
  const sender = createRecordSender();
  assert.equal(await sender.send(current.call, client, [loaded]), "sent");
  assert.equal(current.calls.length, 1);
  assert.equal(sender.legacy, false);
  const first = current.stored[0] as RecordInput;
  assert.equal(first.client.deviceId, "0123456789abcdef");
  assert.equal(first.samples[0]?.load?.busyPct, 12);
});

test("the previous server rejects the new keys, then the batch arrives without them and the sender stays on the legacy shape", async () => {
  const previous = server(legacyInput);
  const sender = createRecordSender();
  assert.equal(await sender.send(previous.call, client, [loaded]), "sent");
  assert.equal(previous.calls.length, 2);
  assert.equal(previous.stored.length, 1);
  assert.equal(sender.legacy, true);
  const stored = previous.stored[0] as RecordInput;
  assert.equal(stored.client.userAgent, "Firefox/153.0");
  assert.equal("deviceId" in stored.client, false);
  assert.equal("load" in (stored.samples[0] ?? {}), false);
  assert.equal(await sender.send(previous.call, client, [loaded]), "sent");
  assert.equal(previous.calls.length, 3);
  assert.equal(previous.stored.length, 2);
});

test("a legacy batch the previous server still rejects is dropped instead of retried", async () => {
  const previous = server(legacyInput);
  const sender = createRecordSender();
  const broken = sample({ frameMs: -1 });
  assert.equal(await sender.send(previous.call, client, [broken]), "dropped");
  assert.equal(previous.stored.length, 0);
  const calls = previous.calls.length;
  assert.equal(await sender.send(previous.call, client, [broken]), "dropped");
  assert.equal(previous.calls.length, calls + 1);
});

test("a rejection that is not about unknown keys, and transport errors, are rethrown for a retry without changing shape", async () => {
  const sender = createRecordSender();
  const badValue = async () => {
    throw new FakeRpcError([{ message: "Too big: expected number to be <=600000", path: ["samples", 0, "frameMs"] }]);
  };
  await assert.rejects(sender.send(badValue, client, [loaded]));
  const offline = async () => {
    throw Object.assign(new Error("offline"), { code: "transport_error" });
  };
  await assert.rejects(sender.send(offline, client, [loaded]));
  assert.equal(sender.legacy, false);
});

test("unknown-key detection needs an unrecognized-key issue", () => {
  const unknownKeys = new FakeRpcError([{ message: 'Unrecognized key: "deviceId"', path: ["client"] }]);
  const mixed = new FakeRpcError([{ message: 'Unrecognized key: "deviceId"' }, { message: "Too small" }]);
  assert.equal(isUnknownKeyRejection(unknownKeys), true);
  assert.equal(isUnknownKeyRejection(mixed), true);
  assert.equal(isUnknownKeyRejection(new FakeRpcError([{ message: "Too small" }])), false);
  assert.equal(isUnknownKeyRejection(new FakeRpcError([])), false);
  assert.equal(isUnknownKeyRejection(new Error("x")), false);
  assert.equal(isUnknownKeyRejection(null), false);
});
