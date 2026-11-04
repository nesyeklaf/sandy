import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import { LAST_MESSAGE_CHANNEL } from "./realtime-channels";
import { loadPlugin } from "./test-server";

type Harness = Awaited<ReturnType<typeof loadPlugin>>;

const idle = (harness: Harness, threadId: string, lastAssistantText: string | null) =>
  harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText });

interface StoredMessage {
  threadId: string;
  text: string;
}

const messages = async (harness: Harness) =>
  ((await harness.behavior.callRpc("listLastMessages", {})) as { messages: StoredMessage[] }).messages;

describe("last message storage", () => {
  it("stores the assistant text of a thread that went idle", async () => {
    const harness = await loadPlugin();
    await idle(harness, "thr_1", "All checks pass.");
    expect(await messages(harness)).toEqual([{ threadId: "thr_1", text: "All checks pass." }]);
  });

  it("answers every stored thread in one read", async () => {
    const harness = await loadPlugin();
    await idle(harness, "thr_1", "First");
    await idle(harness, "thr_2", "Second");
    await idle(harness, "thr_3", "Third");
    const calls = harness.inspection.sdk.callsTo("threads.get").length;
    expect(await messages(harness)).toEqual(
      expect.arrayContaining([
        { threadId: "thr_1", text: "First" },
        { threadId: "thr_2", text: "Second" },
        { threadId: "thr_3", text: "Third" },
      ]),
    );
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(calls);
  });

  it("replaces the text when the thread goes idle again", async () => {
    const harness = await loadPlugin();
    await idle(harness, "thr_1", "Old answer");
    await idle(harness, "thr_1", "New answer");
    expect(await messages(harness)).toEqual([{ threadId: "thr_1", text: "New answer" }]);
  });

  it("collapses whitespace and cuts long text to one short line", async () => {
    const harness = await loadPlugin();
    await idle(harness, "thr_1", "  Done.\n\n  Tests   pass.\t ");
    await idle(harness, "thr_2", "x".repeat(1000));
    const stored = new Map((await messages(harness)).map((row) => [row.threadId, row.text]));
    expect(stored.get("thr_1")).toBe("Done. Tests pass.");
    expect(stored.get("thr_2")).toHaveLength(300);
    expect(stored.get("thr_2")?.endsWith("…")).toBe(true);
  });

  it.each([null, "", "  \n "])("leaves nothing for a thread whose assistant text is %j", async (text) => {
    const harness = await loadPlugin();
    await idle(harness, "thr_1", "Earlier answer");
    await idle(harness, "thr_1", text);
    expect(await messages(harness)).toEqual([]);
  });

  it("drops the text of a deleted thread", async () => {
    const harness = await loadPlugin();
    await idle(harness, "thr_1", "Gone soon");
    await idle(harness, "thr_2", "Stays");
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_1" }) });
    expect(await messages(harness)).toEqual([{ threadId: "thr_2", text: "Stays" }]);
  });

  it("tells the app when the stored text changed, and only then", async () => {
    const harness = await loadPlugin();
    const signals = () =>
      harness.inspection.realtimeSignals.filter((signal) => signal.channel === LAST_MESSAGE_CHANNEL).length;
    await idle(harness, "thr_1", "Same");
    expect(signals()).toBe(1);
    await idle(harness, "thr_1", "Same");
    expect(signals()).toBe(1);
    await idle(harness, "thr_1", "Different");
    expect(signals()).toBe(2);
    await idle(harness, "thr_unknown", null);
    expect(signals()).toBe(2);
  });
});
