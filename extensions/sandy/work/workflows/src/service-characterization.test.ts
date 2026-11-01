import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getCall, getRunRequired } from "./data.js";
import { KEEP_WARM_FILE, KEEP_WARM_WAIT_MS } from "./keep-warm.js";
import { createWorkerTestHost, eventually, workflowSource } from "./worker-test-host.js";

/**
 * Characterization of the workflow service as it behaves today (slice 15 of the SANDY delegate plan). These tests pin
 * behavior, they do not specify it: the rebase onto upstream (slice 16) and the worker admission change (slice 18)
 * must either keep them green or change them visibly.
 */

const keepWarmSignal = (threadId: string) => `worker-host:/storage/${threadId}/${KEEP_WARM_FILE}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("workflow service characterization", () => {
  const hosts: Array<ReturnType<typeof createWorkerTestHost>> = [];
  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    hosts.length = 0;
  });
  function setup(options?: Parameters<typeof createWorkerTestHost>[0]) {
    const host = createWorkerTestHost(options);
    hosts.push(host);
    return host;
  }
  const succeeded = (test: ReturnType<typeof setup>, runId: string) =>
    eventually(() => expect(getRunRequired(test.db, runId).status).toBe("succeeded"));
  const resultOf = (test: ReturnType<typeof setup>, runId: string) =>
    JSON.parse(getRunRequired(test.db, runId).resultJson!) as unknown;

  describe("worker spawn and environment choice", () => {
    // Changed on purpose in slice 18: until then every worker reused the origin's environment whatever the call
    // asked for. Now a call without `writes: true` (a reader, the default) still reuses it, as this test pins; a
    // writer gets its own managed worktree on the origin's branch (worker-admission.test.ts).
    it("spawns every reader worker (no writes option) into the origin's environment as a reuse", async () => {
      const test = setup({ originEnvironmentId: "env-origin-7", extraModels: ["model-b"] });
      const run = await test.start(
        workflowSource(`
          return await Promise.all([
            agent("plain"),
            agent("kept", { keep: true, title: "Kept one" }),
            agent("pinned", { provider: "pi", model: "model-b", reasoningLevel: "medium", raw: true }),
          ]);`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(3));
      const byPrompt = (text: string) => test.spawned.find((entry) => entry.prompt.includes(text))!;
      for (const entry of test.spawned) {
        expect(entry.input.environment).toEqual({ type: "reuse", environmentId: "env-origin-7" });
        expect(entry.input).toMatchObject({
          lifecycleOwnerThreadId: "origin",
          projectId: "project-test",
          visibility: "hidden",
          providerId: "pi",
          permissionMode: "auto",
          reasoningLevel: "medium",
        });
        expect(entry.input).not.toHaveProperty("parentThreadId");
        expect(entry.input).not.toHaveProperty("workspace");
      }
      expect(byPrompt("plain").input.model).toBe("model-a");
      expect(byPrompt("pinned").input.model).toBe("model-b");
      expect(byPrompt("kept").input.title).toBe("Kept one");
      expect(byPrompt("plain").input.title).toBe("characterization · 1");
      expect(getRunRequired(test.db, run.id).environmentId).toBe("env-origin-7");
      for (const entry of test.spawned) test.finish(entry.id, "ok");
      await succeeded(test, run.id);
    });

    it("tags each worker with its run, call and origin so configure can recognise it", async () => {
      const test = setup();
      const run = await test.start(workflowSource(`return await agent("tagged");`));
      await eventually(() => expect(test.spawned).toHaveLength(1));
      const call = getCall(test.db, run.id, 0)!;
      expect(test.spawned[0]!.input.pluginMetadata).toEqual({
        workflowWorker: 1,
        runId: run.id,
        callId: call.id,
        originThreadId: "origin",
      });
      test.finish("child-1", "ok");
      await succeeded(test, run.id);
    });

    it("wraps a normal prompt in the workflow header and sends a raw prompt verbatim, also with a schema", async () => {
      const test = setup();
      const run = await test.start(
        workflowSource(`
          const plain = await agent("do it");
          const raw = await agent("/flow x", { raw: true, schema: { type: "object", properties: { a: { type: "number" } } } });
          return [plain, raw];`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      expect(test.spawned[0]!.prompt).toBe(
        `[SANDY workflow characterization · run ${run.id}]\n\ndo it\n\nYour final text IS the return value (not a human-facing message), so return raw data.`,
      );
      test.finish("child-1", "first");
      await eventually(() => expect(test.spawned).toHaveLength(2));
      expect(test.spawned[1]!.prompt).toBe("/flow x");
      expect(test.service.submitWorkerResult("child-2", { a: 1 })).toEqual({ ok: true });
      test.finish("child-2", "");
      await succeeded(test, run.id);
      expect(resultOf(test, run.id)).toEqual(["first", { a: 1 }]);
    });
  });

  describe("keep and session", () => {
    it("sends a continuation to the kept thread with the workflow header, or verbatim when raw, without spawning", async () => {
      const test = setup();
      const run = await test.start(
        workflowSource(`
          const first = await agent("write", { keep: true });
          const second = await agent("revise", { session: first.session });
          return await agent("/flow again", { session: first.session, raw: true });`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "r1");
      await eventually(() => expect(test.sent).toHaveLength(1));
      expect(test.sent[0]!.text).toBe(
        `[SANDY workflow characterization · run ${run.id}]\n\nrevise\n\nYour final text IS the return value (not a human-facing message), so return raw data.`,
      );
      expect(test.sent[0]!.input).toMatchObject({ threadId: "child-1", mode: "auto" });
      expect(test.sent[0]!.input).not.toHaveProperty("environment");
      test.finish("child-1", "r2");
      await eventually(() => expect(test.sent).toHaveLength(2));
      expect(test.sent[1]!.text).toBe("/flow again");
      test.finish("child-1", "r3");
      await succeeded(test, run.id);
      expect(resultOf(test, run.id)).toEqual({ value: "r3", session: "child-1" });
      expect(test.spawned).toHaveLength(1);
    });

    it("waits for a busy kept thread to go idle before it sends the continuation", async () => {
      const test = setup();
      const run = await test.start(
        workflowSource(`
          const first = await agent("write", { keep: true });
          return await agent("again", { session: first.session });`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "r1");
      // The thread is busy again before the script reaches its second call.
      test.status.set("child-1", "active");
      await pause(300);
      expect(test.sent).toEqual([]);
      test.status.set("child-1", "idle");
      await eventually(() => expect(test.sent).toHaveLength(1), 3_000);
      test.finish("child-1", "r2");
      await succeeded(test, run.id);
    });

    it("fails a continuation whose kept thread ended in error", async () => {
      const test = setup();
      const run = await test.start(
        workflowSource(`
          const first = await agent("write", { keep: true });
          return await agent("again", { session: first.session });`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "r1");
      test.status.set("child-1", "error");
      await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("failed"));
      expect(getRunRequired(test.db, run.id).error).toContain("Session child-1 failed");
      expect(test.sent.filter((message) => message.threadId === "child-1")).toEqual([]);
    });

    it("keeps a kept worker until its run ends, then archives it and clears its keep-warm signal", async () => {
      const test = setup();
      const run = await test.start(
        workflowSource(`
          const first = await agent("write", { keep: true });
          const other = await agent("review");
          return [first, other];`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "r1");
      await eventually(() => expect(test.spawned).toHaveLength(2));
      expect(test.files.has(keepWarmSignal("child-1"))).toBe(true);
      expect(test.archived).not.toContain("child-1");
      test.finish("child-2", "verdict");
      await succeeded(test, run.id);
      await eventually(() => expect(test.archived).toEqual(expect.arrayContaining(["child-1", "child-2"])));
      expect(test.files.has(keepWarmSignal("child-1"))).toBe(false);
    });

    it("never replays a kept or continued call, nor anything after it, when a run is resumed", async () => {
      const test = setup();
      const body = `
        const a = await agent("one");
        const b = await agent("two", { keep: true });
        const c = await agent("three");
        return [a, b.value, c];`;
      const first = await test.start(workflowSource(body));
      for (const id of ["child-1", "child-2", "child-3"]) {
        await eventually(() => expect(test.spawned.map((entry) => entry.id)).toContain(id));
        test.finish(id, id);
      }
      await succeeded(test, first.id);
      const resumed = await test.start(workflowSource(body), first.id);
      await eventually(() => expect(test.spawned).toHaveLength(4));
      expect(getCall(test.db, resumed.id, 0)).toMatchObject({ status: "succeeded", resultJson: '"child-1"' });
      expect(getCall(test.db, resumed.id, 0)!.replaySource).not.toBeNull();
      expect(getCall(test.db, resumed.id, 1)!.replaySource).toBeNull();
      test.finish("child-4", "again");
      await eventually(() => expect(test.spawned).toHaveLength(5));
      expect(getCall(test.db, resumed.id, 2)!.replaySource).toBeNull();
      test.finish("child-5", "last");
      await succeeded(test, resumed.id);
    });
  });

  describe("report", () => {
    it("ends a raw call at the worker's first idle with its last text when report is not set", async () => {
      const test = setup();
      const run = await test.start(workflowSource(`return await agent("/flow steer", { raw: true });`));
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "after the first turn");
      await succeeded(test, run.id);
      expect(resultOf(test, run.id)).toBe("after the first turn");
    });

    it("ends a report call at the first idle when the value was already reported", async () => {
      const test = setup();
      const run = await test.start(workflowSource(`return await agent("/flow steer", { raw: true, report: true });`));
      await eventually(() => expect(test.spawned).toHaveLength(1));
      expect(test.service.submitWorkerResult("child-1", { done: 1 })).toEqual({ ok: true });
      test.finish("child-1", "ignored text");
      await succeeded(test, run.id);
      expect(resultOf(test, run.id)).toEqual({ done: 1 });
    });

    it("stays open through any number of idles until the value is reported", async () => {
      const test = setup();
      const run = await test.start(workflowSource(`return await agent("/flow steer", { raw: true, report: true });`));
      await eventually(() => expect(test.spawned).toHaveLength(1));
      for (const text of ["one", "two", "three"]) {
        test.finish("child-1", text);
        await pause(30);
        expect(getRunRequired(test.db, run.id).status).toBe("running");
        expect(getCall(test.db, run.id, 0)!.status).toBe("running");
      }
      test.service.submitWorkerResult("child-1", { ok: true });
      test.finish("child-1", "four");
      await succeeded(test, run.id);
    });

    it("still fails the call when the worker thread fails before it reports", async () => {
      const test = setup();
      const run = await test.start(workflowSource(`return await agent("/flow steer", { raw: true, report: true });`));
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "one");
      test.service.onThreadFailed("child-1", "provider exploded");
      await eventually(() => expect(getRunRequired(test.db, run.id).status).toBe("failed"));
      expect(getRunRequired(test.db, run.id).error).toContain("provider exploded");
    });

    it("applies to a continued session as well and sends the continuation verbatim", async () => {
      const test = setup();
      const run = await test.start(
        workflowSource(`
          const a = await agent("/flow --report one", { raw: true, report: true, keep: true });
          return await agent("/flow --report two", { session: a.session, raw: true, report: true });`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "t1");
      await pause(50);
      expect(test.sent).toEqual([]);
      test.service.submitWorkerResult("child-1", { step: 1 });
      test.finish("child-1", "t1b");
      await eventually(() => expect(test.sent).toHaveLength(1));
      expect(test.sent[0]!.text).toBe("/flow --report two");
      test.finish("child-1", "t2");
      await pause(50);
      expect(getRunRequired(test.db, run.id).status).toBe("running");
      test.service.submitWorkerResult("child-1", { step: 2 });
      test.finish("child-1", "t2b");
      await succeeded(test, run.id);
      expect(resultOf(test, run.id)).toEqual({ value: { step: 2 }, session: "child-1" });
    });

    it("is stored with the call's options and must be a boolean", async () => {
      const test = setup();
      const run = await test.start(workflowSource(`return await agent("/flow x", { raw: true, report: true, keep: true });`));
      await eventually(() => expect(test.spawned).toHaveLength(1));
      expect(JSON.parse(getCall(test.db, run.id, 0)!.optionsJson)).toMatchObject({ raw: true, report: true, keep: true });
      test.service.submitWorkerResult("child-1", 1);
      test.finish("child-1", "");
      await succeeded(test, run.id);

      const invalid = await test.start(workflowSource(`return await agent("x", { report: "yes" });`));
      await eventually(() => expect(getRunRequired(test.db, invalid.id).status).toBe("failed"));
      expect(getRunRequired(test.db, invalid.id).error).toContain("agent options.report must be a boolean");
    });
  });

  describe("ship flow (examples/ship.js)", () => {
    const shipSource = readFileSync(fileURLToPath(new URL("../examples/ship.js", import.meta.url)), "utf8");
    const shipModel = "openai-codex/gpt-6-astra";

    async function runShip(args: unknown, review: unknown, release: unknown) {
      const test = setup({ extraModels: [shipModel] });
      const run = await test.start(shipSource, null, args);
      await eventually(() => expect(test.spawned).toHaveLength(2));
      const reviewer = test.spawned.find((entry) => entry.prompt.startsWith("/autopilot --report ship review"))!;
      const releaser = test.spawned.find((entry) => entry.prompt.startsWith("/autopilot --report ship release"))!;
      // Each stage is an autopilot: it idles after its own turns and only the reported value ends the call.
      test.finish(reviewer.id, "step output");
      test.finish(releaser.id, "step output");
      await pause(50);
      expect(getRunRequired(test.db, run.id).status).toBe("running");
      expect(test.service.submitWorkerResult(reviewer.id, review as never)).toEqual({ ok: true });
      expect(test.service.submitWorkerResult(releaser.id, release as never)).toEqual({ ok: true });
      test.finish(reviewer.id, "done");
      test.finish(releaser.id, "done");
      await succeeded(test, run.id);
      return { test, run, reviewer, releaser };
    }

    it("runs review and release as two parallel raw report workers with the args as refs", async () => {
      const { test, run, reviewer, releaser } = await runShip(
        { base: "origin/main", from: "v1.2" },
        { findings: [{ severity: "high", file: "a.ts" }, { severity: "low", file: "b.ts" }], dropped: ["x"] },
        { notes: "n" },
      );
      expect(reviewer.prompt).toBe("/autopilot --report ship review origin/main");
      expect(releaser.prompt).toBe("/autopilot --report ship release v1.2");
      for (const entry of [reviewer, releaser]) {
        expect(entry.input).toMatchObject({ providerId: "pi", model: shipModel, reasoningLevel: "medium" });
      }
      expect(reviewer.input.title).toBe("ship review");
      expect(releaser.input.title).toBe("ship release");
      for (const index of [0, 1]) {
        expect(JSON.parse(getCall(test.db, run.id, index)!.optionsJson)).toMatchObject({ raw: true, report: true });
      }
      expect(resultOf(test, run.id)).toEqual({
        ready: false,
        review: { findings: [{ severity: "high", file: "a.ts" }, { severity: "low", file: "b.ts" }], dropped: ["x"] },
        release: { notes: "n" },
      });
    });

    it("sends no ref without args and is ready when no finding is high and neither stage errored", async () => {
      const { reviewer, releaser, test, run } = await runShip(
        null,
        { findings: [{ severity: "low" }], dropped: [] },
        { notes: "n" },
      );
      expect(reviewer.prompt).toBe("/autopilot --report ship review");
      expect(releaser.prompt).toBe("/autopilot --report ship release");
      expect((resultOf(test, run.id) as { ready: boolean }).ready).toBe(true);
    });

    it("is not ready when a stage reports an error", async () => {
      const { test, run } = await runShip(null, { findings: [], dropped: [] }, { error: "no tags" });
      expect((resultOf(test, run.id) as { ready: boolean }).ready).toBe(false);
    });
  });

  describe("prompt cache and keep-warm", () => {
    it("re-announces the wait after every continuation and never for a worker that is not kept", async () => {
      const test = setup();
      const run = await test.start(
        workflowSource(`
          const first = await agent("write", { keep: true });
          const plain = await agent("review");
          const again = await agent("again", { session: first.session });
          return [first, plain, again];`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "r1");
      await eventually(() => expect(test.spawned).toHaveLength(2));
      test.finish("child-2", "verdict");
      await eventually(() => expect(test.sent).toHaveLength(1));
      expect(test.files.has(keepWarmSignal("child-1"))).toBe(false);
      expect(test.files.has(keepWarmSignal("child-2"))).toBe(false);
      const finished = Date.now();
      test.finish("child-1", "r2");
      await succeeded(test, run.id);
      const { until } = JSON.parse(test.files.get(keepWarmSignal("child-1"))!) as { until: number };
      expect(until).toBeGreaterThanOrEqual(finished + KEEP_WARM_WAIT_MS);
      expect(until).toBeLessThan(finished + KEEP_WARM_WAIT_MS + 5_000);
      expect(test.files.has(keepWarmSignal("child-2"))).toBe(false);
    });

    it("leaves the cache identity of a call independent of keep, raw and report", async () => {
      const test = setup();
      const plain = await test.start(workflowSource(`return await agent("same prompt");`));
      await eventually(() => expect(test.spawned).toHaveLength(1));
      test.finish("child-1", "x");
      await succeeded(test, plain.id);
      const flagged = await test.start(
        workflowSource(`return await agent("same prompt", { raw: true, keep: true, report: true });`),
      );
      await eventually(() => expect(test.spawned).toHaveLength(2));
      test.service.submitWorkerResult("child-2", "y");
      test.finish("child-2", "y");
      await succeeded(test, flagged.id);
      expect(getCall(test.db, flagged.id, 0)!.cacheKey).toBe(getCall(test.db, plain.id, 0)!.cacheKey);
    });
  });
});
