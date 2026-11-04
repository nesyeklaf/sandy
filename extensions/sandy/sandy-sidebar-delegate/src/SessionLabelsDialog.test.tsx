// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { createFakePluginHost } from "./test-server";
import plugin from "./server";
import { SessionLabelsDialog } from "./SessionLabelsDialog";
import { TOPICS_CHANNEL } from "./realtime-channels";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function mountDialog(readFails: (call: number) => boolean) {
  const { sandy, harness } = createFakePluginHost({ pluginId: "sandy-sidebar" });
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("setTopicTags", { kind: "thread", ownerId: "t", tags: ["existing"] });
  await harness.behavior.callRpc("setThreadTopics", { threadId: "t", topics: ["Existing Topic"] });
  let reads = 0;
  const writes = vi.fn((input: unknown) => harness.behavior.callRpc("setTopicTags", input as never));
  const listTopics = vi.fn(async () => {
    reads += 1;
    if (readFails(reads)) throw new Error("temporary network error");
    return harness.behavior.callRpc("listTopics", { threadId: "t" });
  });
  const rendered = renderSlot(
    { component: SessionLabelsDialog },
    { threadId: "t", title: "Thread", open: true, onOpenChange: () => undefined },
    { rpc: { listTopics, setTopicTags: writes } },
  );
  const storedTags = () =>
    (sandy.storage.database().prepare("SELECT tag FROM topic_tags WHERE owner_id = 't' ORDER BY tag").all() as Array<{ tag: string }>).map(
      (row) => row.tag,
    );
  return { rendered, listTopics, writes, storedTags };
}

describe("SessionLabelsDialog", () => {
  it("offers no editors after a failed read and cannot overwrite the stored tags", async () => {
    const { writes, storedTags } = await mountDialog(() => true);
    expect(await screen.findByRole("button", { name: "Erneut versuchen" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Tags dieser Session" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Themen dieser Session" })).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(storedTags()).toEqual(["existing"]);
  });

  it("loads the stored labels after Retry and keeps them when the next add is saved", async () => {
    const { listTopics, storedTags } = await mountDialog((call) => call === 1);
    fireEvent.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    const input = await screen.findByRole("textbox", { name: "Tags dieser Session" });
    expect(screen.getByText("existing")).toBeTruthy();
    expect(listTopics).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(storedTags()).toEqual(["existing", "new"]));
  });

  it("keeps the loaded labels editable when a later refresh fails", async () => {
    const { rendered, listTopics, storedTags } = await mountDialog((call) => call > 1);
    const input = await screen.findByRole("textbox", { name: "Tags dieser Session" });
    expect(screen.getByText("existing")).toBeTruthy();
    await rendered.emitRealtime(TOPICS_CHANNEL, {});
    await waitFor(() => expect(listTopics.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).toBeNull();
    expect(screen.getByText("existing")).toBeTruthy();
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(storedTags()).toEqual(["existing", "new"]));
  });
});
