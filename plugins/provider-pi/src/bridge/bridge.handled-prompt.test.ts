import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

const THREAD_ID = "thread";
const HANDLED_TEST_TIMEOUT_MS = 30_000;

let harness: FakePiBridgeHarness;
let providerThreadId: string;
let turnCount = 0;
let nextId = 3000;

beforeEach(async () => {
  turnCount = 0;
  harness = await startFakePiBridge({
    prefix: "sandy-pi-handled-",
    initialize: true,
  });
  vi.stubEnv("FAKE_PI_DISPOSITIONS", "1");
  vi.stubEnv("FAKE_PI_EVENT_LOG", join(harness.workspaceDir, "events.jsonl"));
  const response = await harness.startThread(THREAD_ID);
  const result = response.result;
  if (
    !result ||
    typeof result !== "object" ||
    !("providerThreadId" in result) ||
    typeof result.providerThreadId !== "string"
  ) {
    throw new Error("missing provider identity");
  }
  providerThreadId = result.providerThreadId;
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

async function runTurn(text: string, since: number): Promise<number> {
  turnCount += 1;
  const response = await harness.request(++nextId, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: `creq_abcdefghi${"23456789"[turnCount % 8] ?? "2"}`,
    input: [{ type: "text", text, mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(response.error).toBeUndefined();
  return harness.waitForTurnBoundary(THREAD_ID, since);
}

function boundaries() {
  return harness
    .deltasOf(THREAD_ID)
    .filter((delta) => delta.kind === "turn.boundary");
}

function wireEventTypes(): string[] {
  const path = join(harness.workspaceDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => String(JSON.parse(line).type));
}

it(
  "completes a turn that an extension command handled without starting a run",
  async () => {
    const seen = await runTurn("/handled-status", 0);

    expect(boundaries()).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(wireEventTypes()).not.toContain("agent_start");

    await runTurn("hello", seen);

    expect(boundaries()).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(wireEventTypes()).toContain("agent_start");
  },
  HANDLED_TEST_TIMEOUT_MS,
);

it(
  "keeps a started prompt waiting for its run",
  async () => {
    await runTurn("hello", 0);

    expect(boundaries()).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(wireEventTypes()).toContain("agent_start");
    expect(wireEventTypes()).toContain("agent_end");
  },
  HANDLED_TEST_TIMEOUT_MS,
);
