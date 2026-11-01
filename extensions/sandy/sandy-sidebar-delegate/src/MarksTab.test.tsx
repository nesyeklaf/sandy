// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Anchor } from "./anchors-contract";
import { MarksTab } from "./MarksTab";

const found: Anchor[] = [
  {
    id: "a1",
    threadId: "t1",
    kind: "note",
    messageId: "m1",
    seq: 7,
    quote: "idempotent retry",
    offset: null,
    body: "ask about backoff",
    tags: ["infra"],
    targetId: null,
    author: "user",
    createdAt: 1,
    updatedAt: 1,
  },
];
const call = vi.fn(async (_method: string, _input?: unknown) => ({ anchors: found }));
const rpc = { call };
const toThread = vi.fn();
vi.mock("@sandy-sdk/plugin-sdk/app", () => ({
  useRpc: () => rpc,
  useRealtime: () => {},
  useSandyNavigate: () => ({ toThread }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("marks tab", () => {
  it("lists this session's marks and jumps to the marked message", async () => {
    render(<MarksTab threadId="t1" />);
    await waitFor(() => expect(screen.getByText("ask about backoff")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("searchAnchors", { query: undefined, kind: undefined, threadId: "t1" });
    fireEvent.click(screen.getByText("ask about backoff"));
    expect(toThread).toHaveBeenCalledWith("t1", { experimental_messageSeq: 7 });
  });

  it("searches by text, filters by kind and can widen to all sessions", async () => {
    render(<MarksTab threadId="t1" />);
    await waitFor(() => expect(call).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Search your marks"), { target: { value: "backoff" } });
    fireEvent.click(screen.getByText("comment"));
    fireEvent.click(screen.getByText("All sessions"));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("searchAnchors", {
        query: "backoff",
        kind: "comment",
        threadId: undefined,
      }),
    );
  });

  it("explains an empty session", async () => {
    call.mockResolvedValueOnce({ anchors: [] });
    render(<MarksTab threadId="t1" />);
    await waitFor(() => expect(screen.getByText(/Select text in the chat/)).toBeTruthy());
  });
});
