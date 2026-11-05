// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import type { ComposerMention } from "@sandy-sdk/plugin-sdk/app";
import {
  arePromptEditorValuesEqual,
  focusEditorAtEnd,
  runAfterNextPaint,
  suppressPromptEditorAnchorActivation,
} from "./PromptBoxInternal";
import { promptEditorExtensions } from "./editor/prompt-editor-extensions";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const promptSchema = getSchema(
  promptEditorExtensions({ getPlaceholder: () => "" }),
);

function fakeEditorWithText(text: string) {
  const doc = Node.fromJSON(promptSchema, {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text === "" ? [] : [{ type: "text", text }],
      },
    ],
  });
  const state = EditorState.create({ schema: promptSchema, doc });
  const dispatch = vi.fn();
  const focus = vi.fn();
  const editor = { state, view: { dispatch, focus } } as unknown as Editor;
  return { dispatch, editor, focus };
}

function dispatchThroughEditorTarget({
  eventName,
  target,
}: {
  eventName: "auxclick" | "click";
  target: HTMLElement;
}) {
  const editorRoot = document.createElement("div");
  editorRoot.append(target);
  document.body.append(editorRoot);

  let suppressed = false;
  editorRoot.addEventListener(eventName, (event) => {
    suppressed = suppressPromptEditorAnchorActivation(event);
  });

  const event = new MouseEvent(eventName, {
    bubbles: true,
    cancelable: true,
  });
  const defaultAllowed = target.dispatchEvent(event);

  editorRoot.remove();
  return { defaultAllowed, event, suppressed };
}

describe("suppressPromptEditorAnchorActivation", () => {
  it("cancels anchor clicks inside the prompt editor", () => {
    const anchor = document.createElement("a");
    anchor.href = "https://example.com";
    anchor.textContent = "https://example.com";

    const result = dispatchThroughEditorTarget({
      eventName: "click",
      target: anchor,
    });

    expect(result.suppressed).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.defaultAllowed).toBe(false);
  });

  it("cancels auxiliary anchor clicks inside the prompt editor", () => {
    const anchor = document.createElement("a");
    anchor.href = "https://example.com";
    anchor.textContent = "https://example.com";

    const result = dispatchThroughEditorTarget({
      eventName: "auxclick",
      target: anchor,
    });

    expect(result.suppressed).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.defaultAllowed).toBe(false);
  });

  it("does not cancel ordinary prompt editor clicks", () => {
    const span = document.createElement("span");
    span.textContent = "plain prompt text";

    const result = dispatchThroughEditorTarget({
      eventName: "click",
      target: span,
    });

    expect(result.suppressed).toBe(false);
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.defaultAllowed).toBe(true);
  });
});

describe("arePromptEditorValuesEqual", () => {
  it("compares cloned mention values without serializing the prompt text", () => {
    const mention: ComposerMention = {
      from: 4,
      to: 10,
      kind: "path",
      source: "workspace",
      entryKind: "file",
      path: "src/a.ts",
      label: "a.ts",
    };
    const left = { text: "see @a.ts", mentions: [mention] };

    expect(
      arePromptEditorValuesEqual(left, {
        text: left.text,
        mentions: [{ ...mention }],
      }),
    ).toBe(true);
    expect(
      arePromptEditorValuesEqual(left, {
        text: left.text,
        mentions: [{ ...mention, path: "src/b.ts" }],
      }),
    ).toBe(false);
  });

  it("treats a mention with reordered keys as the same mention", () => {
    const mention: ComposerMention = {
      from: 0,
      to: 5,
      kind: "plugin",
      pluginId: "sample",
      icon: null,
      provider: "people",
      id: "alice",
      label: "Alice",
    };
    const reordered: ComposerMention = {
      label: "Alice",
      id: "alice",
      provider: "people",
      icon: null,
      pluginId: "sample",
      kind: "plugin",
      to: 5,
      from: 0,
    };

    expect(
      arePromptEditorValuesEqual(
        { text: "Alice", mentions: [mention] },
        { text: "Alice", mentions: [reordered] },
      ),
    ).toBe(true);
  });
});

describe("focusEditorAtEnd", () => {
  it("moves the caret to the end of a draft and scrolls it into view", () => {
    const { dispatch, editor, focus } = fakeEditorWithText("draft text");

    focusEditorAtEnd(editor);

    const transaction = dispatch.mock.calls[0]?.[0];
    expect(transaction.scrolledIntoView).toBe(true);
    expect(transaction.selection.from).toBe(11);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("focuses an empty draft without a scroll-into-view layout read", () => {
    const { dispatch, editor, focus } = fakeEditorWithText("");

    focusEditorAtEnd(editor);

    const transaction = dispatch.mock.calls[0]?.[0];
    expect(transaction.scrolledIntoView).toBe(false);
    expect(transaction.selection.from).toBe(1);
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("runAfterNextPaint", () => {
  function stubAnimationFrames() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId;
      nextId += 1;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const runFrame = () => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    };
    return { runFrame };
  }

  it("runs the callback only after the frame that follows the request has painted", () => {
    const { runFrame } = stubAnimationFrames();
    const callback = vi.fn();

    runAfterNextPaint(callback);
    runFrame();
    expect(callback).not.toHaveBeenCalled();
    runFrame();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("cancels the callback from either frame", () => {
    const { runFrame } = stubAnimationFrames();
    const callback = vi.fn();

    const cancelBeforePaint = runAfterNextPaint(callback);
    cancelBeforePaint();
    runFrame();
    runFrame();

    const cancelAfterPaint = runAfterNextPaint(callback);
    runFrame();
    cancelAfterPaint();
    runFrame();
    expect(callback).not.toHaveBeenCalled();
  });
});
