// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { createFakePluginHost } from "./test-server";
import plugin from "./server";
import { SessionLabelsDialog } from "./SessionLabelsDialog";
import { TOPICS_CHANNEL } from "./realtime-channels";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function mountDialog(readFails: (call: number) => boolean, onOpenChange: (open: boolean) => void = () => undefined) {
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
    { threadId: "t", title: "Thread", open: true, onOpenChange },
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

  it("leaves the app root outside the dialog accessible", async () => {
    const appRoot = document.createElement("main");
    appRoot.textContent = "Main application";
    document.body.append(appRoot);
    await mountDialog(() => false);
    await screen.findByRole("textbox", { name: "Tags dieser Session" });
    expect(appRoot.getAttribute("aria-hidden")).toBeNull();
    expect(appRoot.hasAttribute("inert")).toBe(false);
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
    appRoot.remove();
  });

  it("closes on Escape", async () => {
    const onOpenChange = vi.fn();
    await mountDialog(() => false, onOpenChange);
    await screen.findByRole("textbox", { name: "Tags dieser Session" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on a press outside the dialog", async () => {
    const onOpenChange = vi.fn();
    await mountDialog(() => false, onOpenChange);
    await screen.findByRole("textbox", { name: "Tags dieser Session" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outside = document.createElement("button");
    document.body.append(outside);
    fireEvent.pointerDown(outside, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(outside, { pointerType: "mouse", button: 0 });
    fireEvent.click(outside);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("realizes the editors two animation frames after opening", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const { listTopics } = await mountDialog(() => false);
    await waitFor(() => expect(listTopics).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("textbox", { name: "Tags dieser Session" })).toBeNull();
    act(() => frames.splice(0).forEach((callback) => callback(0)));
    expect(screen.queryByRole("textbox", { name: "Tags dieser Session" })).toBeNull();
    act(() => frames.splice(0).forEach((callback) => callback(16)));
    expect(await screen.findByRole("textbox", { name: "Tags dieser Session" })).toBeTruthy();
  });

  it("realizes the editors after a timeout when no animation frame arrives", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    await mountDialog(() => false);
    expect(await screen.findByRole("textbox", { name: "Tags dieser Session" })).toBeTruthy();
  });
});
