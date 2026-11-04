import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { IDEAS_CHANNEL } from "./realtime-channels";
import { loadPlugin } from "./test-server";

type Harness = Awaited<ReturnType<typeof loadPlugin>>;

const ideas = async (harness: Harness) =>
  ((await harness.behavior.callRpc("listIdeas", {})) as { threadIds: string[] }).threadIds;

const mark = async (harness: Harness, threadIds: string[], idea: boolean) =>
  (await harness.behavior.callRpc("setIdea", { threadIds, idea })) as { changed: string[] };

describe("idea marks", () => {
  it("marks sessions as ideas and lists them in one read", async () => {
    const harness = await loadPlugin();
    expect(await mark(harness, ["thr_1", "thr_2", "thr_2"], true)).toEqual({ changed: ["thr_1", "thr_2"] });
    expect((await ideas(harness)).sort()).toEqual(["thr_1", "thr_2"]);
  });

  it("reports only the sessions it changed, so Undo restores exactly those", async () => {
    const harness = await loadPlugin();
    await mark(harness, ["thr_1"], true);
    expect(await mark(harness, ["thr_1", "thr_2"], true)).toEqual({ changed: ["thr_2"] });
    expect(await mark(harness, ["thr_1", "thr_3"], false)).toEqual({ changed: ["thr_1"] });
    expect(await ideas(harness)).toEqual(["thr_2"]);
  });

  it("tells the app when a mark changed, and only then", async () => {
    const harness = await loadPlugin();
    const signals = () =>
      harness.inspection.realtimeSignals.filter((signal) => signal.channel === IDEAS_CHANNEL).length;
    await mark(harness, ["thr_1"], true);
    expect(signals()).toBe(1);
    await mark(harness, ["thr_1"], true);
    expect(signals()).toBe(1);
    await mark(harness, ["thr_1"], false);
    expect(signals()).toBe(2);
  });

  it("drops the mark of a deleted session", async () => {
    const harness = await loadPlugin();
    await mark(harness, ["thr_1", "thr_2"], true);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_1" }) });
    expect(await ideas(harness)).toEqual(["thr_2"]);
  });

  it("rejects an empty selection", async () => {
    const harness = await loadPlugin();
    await expect(mark(harness, [], true)).rejects.toThrow();
  });
});
