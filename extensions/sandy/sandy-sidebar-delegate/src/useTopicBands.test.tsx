// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { registerTocExtension, type TocBand } from "./toc-extension";
import { setSuggestions } from "./useSuggestions";
import { useTopicBands } from "./useTopicBands";

const call = vi.fn(async () => ({
  segments: [{ id: "s1", threadId: "t", fromSeq: 1, toSeq: 4, title: "Tagging", tags: [] }],
  threadTags: [],
}));
const rpc = { call };
vi.mock("@sandy-sdk/plugin-sdk/app", () => ({ useRpc: () => rpc, useRealtime: () => {} }));

let latest: readonly TocBand[] = [];
function Probe() {
  latest = useTopicBands("t");
  return null;
}

afterEach(() => {
  cleanup();
  setSuggestions("t", []);
});

describe("useTopicBands", () => {
  it("draws saved topics solid and AI suggestions dashed", async () => {
    render(<Probe />);
    await waitFor(() => expect(latest).toHaveLength(1));
    expect(latest[0]).toMatchObject({ fromSeq: 1, toSeq: 4, label: "Tagging", dashed: false });

    setSuggestions("t", [{ fromSeq: 5, toSeq: 9, title: "Tree view", tags: [] }]);
    await waitFor(() => expect(latest).toHaveLength(2));
    expect(latest[1]).toMatchObject({ fromSeq: 5, toSeq: 9, label: "Suggested: Tree view", dashed: true });
  });
});

describe("registerTocExtension", () => {
  it("registers when the host has the slot and reports false when it does not", () => {
    const slot = vi.fn();
    const extension = { id: "topics", title: "Topics", useBands: () => [] };
    expect(registerTocExtension({ experimental_threadTocExtension: slot }, extension)).toBe(true);
    expect(slot).toHaveBeenCalledWith(extension);
    expect(registerTocExtension({}, extension)).toBe(false);
  });
});
