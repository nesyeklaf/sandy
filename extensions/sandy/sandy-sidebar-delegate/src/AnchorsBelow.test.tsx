// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAnchorActions } from "./anchor-actions";
import { closeAnchorDraft } from "./anchor-draft";
import { AnchorsBelow } from "./AnchorsBelow";
import type { Anchor } from "./anchors-contract";
import { setAnchors } from "./anchor-store";

let stored: Anchor[] = [];
const call = vi.fn(async (method: string, _input?: unknown) => (method === "listAnchors" ? { anchors: stored } : {}));
const rpc = { call };
vi.mock("@sandy-sdk/plugin-sdk/app", () => ({ useRpc: () => rpc, useRealtime: () => {} }));

const anchor = (patch: Partial<Anchor>): Anchor => ({
  id: "a1",
  threadId: "t",
  kind: "note",
  messageId: "m1",
  seq: 4,
  quote: "",
  offset: null,
  body: "",
  tags: [],
  targetId: null,
  author: "user",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

type Action = { id: string; surfaces: string[]; run: (context: unknown) => void };

function pill() {
  const actions: Action[] = [];
  registerAnchorActions({ messageAction: (action: Action) => actions.push(action) });
  return actions;
}

function select(kind: string, selectedText = "the quoted words") {
  const action = pill().find((entry) => entry.id === "anchor-" + kind);
  act(() => action?.run({ threadId: "t", message: { id: "m1", experimental_messageSeq: 4 }, selectedText }));
}

afterEach(() => {
  stored = [];
  act(() => setAnchors("t", []));
  act(() => closeAnchorDraft());
  cleanup();
  vi.clearAllMocks();
});

describe("selection pill", () => {
  it("offers explain and the five marks on selection only", () => {
    expect(pill().map((action) => [action.id, action.surfaces])).toEqual(
      ["explain", "note", "comment", "tag", "link", "bookmark"].map((kind) => ["anchor-" + kind, ["selection"]]),
    );
  });

  it("shows nothing under a message without a draft", () => {
    const { container } = render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    expect(container.textContent).toBe("");
  });

  it("opens a note editor under the selected message only and saves it with the quote", async () => {
    render(
      <>
        <AnchorsBelow message={{ id: "m1", threadId: "t" }} />
        <AnchorsBelow message={{ id: "m2", threadId: "t" }} />
      </>,
    );
    select("note");
    expect(screen.getAllByText("Note for you")).toHaveLength(1);
    expect(screen.getByText("the quoted words")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("What do you want to remember?"), { target: { value: "check this" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAnchor", {
        threadId: "t",
        kind: "note",
        messageId: "m1",
        seq: 4,
        quote: "the quoted words",
        body: "check this",
        tags: [],
      }),
    );
    await waitFor(() => expect(screen.queryByText("Note for you")).toBeNull());
  });

  it("splits tags on commas", async () => {
    render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    select("tag");
    fireEvent.change(screen.getByPlaceholderText("Tags, separated by commas"), { target: { value: "ui, bug ," } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAnchor", expect.objectContaining({ kind: "tag", tags: ["ui", "bug"] })),
    );
  });

  it("saves a bookmark at once without an editor", async () => {
    render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    select("bookmark");
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAnchor", expect.objectContaining({ kind: "bookmark", body: "" })),
    );
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("cancels a draft", () => {
    render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    select("comment");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Comment for agents")).toBeNull();
    expect(call).not.toHaveBeenCalledWith("saveAnchor", expect.anything());
  });

  it("shows saved marks under their own message, agent comments marked", async () => {
    stored = [
      anchor({ id: "a1", body: "remember this", quote: "some words" }),
      anchor({ id: "a2", kind: "comment", author: "agent", body: "see file X" }),
      anchor({ id: "a3", kind: "tag", tags: ["ui"] }),
      anchor({ id: "a4", messageId: "m2", body: "elsewhere" }),
    ];
    render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    await screen.findByText("remember this");
    expect(screen.getByText("Agent comment")).toBeTruthy();
    expect(screen.getByText("#ui")).toBeTruthy();
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  it("edits a note in place and deletes a mark", async () => {
    stored = [anchor({ body: "old text" })];
    render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    await screen.findByText("old text");
    fireEvent.click(screen.getByLabelText("Edit"));
    fireEvent.change(screen.getByDisplayValue("old text"), { target: { value: "new text" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAnchor", expect.objectContaining({ id: "a1", body: "new text" })),
    );
    fireEvent.click(screen.getByLabelText("Delete"));
    await waitFor(() => expect(call).toHaveBeenCalledWith("deleteAnchor", { id: "a1" }));
  });
});

describe("explain", () => {
  it("shows the explanation under the message and saves it as a note with the quote", async () => {
    call.mockImplementation(async (method: string) => {
      if (method === "explainSelection") return { text: "It retries safely." };
      return method === "listAnchors" ? { anchors: stored } : {};
    });
    render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    select("explain", "idempotent retry");
    expect(screen.getByText("Explaining…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("It retries safely.")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("explainSelection", { threadId: "t", quote: "idempotent retry" });
    expect(call).not.toHaveBeenCalledWith("saveAnchor", expect.anything());
    fireEvent.click(screen.getByText("Save as note"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "saveAnchor",
        expect.objectContaining({ kind: "note", body: "It retries safely.", quote: "idempotent retry" }),
      ),
    );
  });

  it("shows the failure instead of hanging", async () => {
    call.mockImplementation(async (method: string) => {
      if (method === "explainSelection") throw new Error("no helper");
      return {};
    });
    render(<AnchorsBelow message={{ id: "m1", threadId: "t" }} />);
    select("explain");
    await waitFor(() => expect(screen.getByText("no helper")).toBeTruthy());
    expect(screen.queryByText("Save as note")).toBeNull();
  });
});
