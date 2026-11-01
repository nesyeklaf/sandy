// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopicsPopover } from "./TopicsPopover";

const suggest = vi.fn(async () => 1);
const messages = [
  { seq: 1, role: "user" as const, preview: "a", lines: 1, words: 1, tokens: 10 },
  { seq: 2, role: "assistant" as const, preview: "b", lines: 1, words: 1, tokens: 10 },
  { seq: 5, role: "user" as const, preview: "c", lines: 1, words: 1, tokens: 10 },
];

vi.mock("./useTopics", () => ({
  useTopics: () => ({
    messages,
    segments: [
      { id: "s1", threadId: "t", fromSeq: 1, toSeq: 2, title: "Alpha", tags: [] },
      { id: "s2", threadId: "t", fromSeq: 5, toSeq: 6, title: "Beta", tags: [] },
    ],
    suggestions: [],
    suggesting: false,
    threadTags: [],
    loaded: true,
    error: null,
    suggest,
    accept: vi.fn(async () => {}),
    discard: vi.fn(),
    discardAll: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TopicsPopover", () => {
  it("jumps to the start of a topic on click", () => {
    const jumpToSeq = vi.fn();
    render(<TopicsPopover threadId="t" jumpToSeq={jumpToSeq} />);
    fireEvent.click(screen.getByText("Beta"));
    expect(jumpToSeq).toHaveBeenCalledWith(5);
  });

  it("marks the topic holding the current position and steps to the next one", () => {
    const jumpToSeq = vi.fn();
    render(<TopicsPopover threadId="t" jumpToSeq={jumpToSeq} activeSeq={1} />);
    expect(screen.getByText("here")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next topic"));
    expect(jumpToSeq).toHaveBeenCalledWith(5);
  });

  it("lights the bracket of a hovered row and clears it on leave", () => {
    const setHoveredRange = vi.fn();
    render(<TopicsPopover threadId="t" jumpToSeq={vi.fn()} setHoveredRange={setHoveredRange} />);
    const row = screen.getByText("Alpha").closest("li") as HTMLElement;
    fireEvent.mouseEnter(row);
    expect(setHoveredRange).toHaveBeenLastCalledWith({ fromSeq: 1, toSeq: 2 });
    fireEvent.mouseLeave(row);
    expect(setHoveredRange).toHaveBeenLastCalledWith(null);
  });

  it("opens the manage tab and asks the AI for topics", () => {
    const openTab = vi.fn();
    render(<TopicsPopover threadId="t" jumpToSeq={vi.fn()} openTab={openTab} />);
    fireEvent.click(screen.getByText(/Manage/));
    expect(openTab).toHaveBeenCalledWith("topics-manage");
    fireEvent.click(screen.getByText("Suggest topics"));
    expect(suggest).toHaveBeenCalled();
  });
});
