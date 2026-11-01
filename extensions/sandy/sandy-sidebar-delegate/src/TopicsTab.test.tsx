// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { TopicsTab } from "./TopicsTab";

const save = vi.fn(async () => {});
const accept = vi.fn(async () => {});
const suggest = vi.fn(async () => 1);
const toThread = vi.fn();
let suggestions: Array<{ fromSeq: number; toSeq: number; title: string; tags: string[] }> = [];

vi.mock("@sandy-sdk/plugin-sdk/app", () => ({ useSandyNavigate: () => ({ toThread }) }));
const messages = [
  { seq: 1, role: "user" as const, preview: "Build tagging", lines: 2, words: 10, tokens: 14 },
  { seq: 2, role: "assistant" as const, preview: "Done", lines: 4, words: 20, tokens: 30 },
  { seq: 3, role: "user" as const, preview: "Now the tree", lines: 1, words: 4, tokens: 6 },
];

vi.mock("./useTopics", () => ({
  useTopics: () => ({
    messages,
    segments: [{ id: "s1", threadId: "t", fromSeq: 1, toSeq: 2, title: "Tagging", tags: ["sidebar"] }],
    suggestions,
    suggesting: false,
    threadTags: ["feature"],
    loaded: true,
    error: null,
    save,
    suggest,
    accept,
    discard: vi.fn(),
    discardAll: vi.fn(),
    remove: vi.fn(async () => {}),
    setTags: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

afterEach(() => {
  cleanup();
  suggestions = [];
  vi.clearAllMocks();
});

describe("TopicsTab", () => {
  it("turns a range dragged on the rail into the draft and jumps inside the panel", () => {
    const clear = vi.fn();
    const jumpToSeq = vi.fn();
    render(
      <TopicsTab
        threadId="t"
        railSelection={{ fromSeq: 3, toSeq: 3 }}
        clearRailSelection={clear}
        jumpToSeq={jumpToSeq}
      />,
    );
    expect(clear).toHaveBeenCalled();
    expect((screen.getByDisplayValue("Now the tree") as HTMLInputElement).value).toBe("Now the tree");
    fireEvent.click(screen.getByText("In chat"));
    expect(jumpToSeq).toHaveBeenCalledWith(1);
    expect(toThread).not.toHaveBeenCalled();
  });

  it("shows a topic with its counts and length", () => {
    render(<TopicsTab threadId="t" />);
    expect(screen.getByText("Tagging", { selector: "button" })).toBeTruthy();
    expect(screen.getByText(/1 user · 1 agent · 6 lines · 30 words/)).toBeTruthy();
    expect(screen.getAllByText("sidebar").length).toBeGreaterThan(0);
    expect(screen.getByText("feature")).toBeTruthy();
  });

  it("shows the totals of the session", () => {
    render(<TopicsTab threadId="t" />);
    expect(screen.getByText(/Total: 2 user · 1 agent · 7 lines · 34 words/)).toBeTruthy();
  });

  it("opens the first message of a topic in the chat", () => {
    render(<TopicsTab threadId="t" />);
    fireEvent.click(screen.getByText("In chat"));
    expect(toThread).toHaveBeenCalledWith("t", { experimental_messageSeq: 1 });
  });

  it("saves a range from two keyboard taps on turns under a title", () => {
    render(<TopicsTab threadId="t" />);
    fireEvent.click(screen.getByText("Now the tree"));
    expect(screen.getByText(/Start set/)).toBeTruthy();
    fireEvent.click(screen.getByText("Build tagging"));
    fireEvent.change(screen.getByLabelText("Topic title"), { target: { value: "Alles" } });
    fireEvent.click(screen.getByText("Create topic"));
    expect(save).toHaveBeenCalledWith({ id: undefined, fromSeq: 1, toSeq: 3, title: "Alles" });
  });

  it("picks a range by dragging over the turns and proposes the first prompt as title", () => {
    render(<TopicsTab threadId="t" />);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-turn]"));
    const pick = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>("[data-pick]") as HTMLElement;
    document.elementFromPoint = () => rows[1] ?? null;
    fireEvent.pointerDown(pick(rows[0]), { button: 0, pointerType: "mouse", clientX: 1, clientY: 1 });
    fireEvent.pointerMove(pick(rows[0]), { clientX: 1, clientY: 50 });
    fireEvent.pointerUp(pick(rows[0]), { clientX: 1, clientY: 50 });
    expect((screen.getByLabelText("Topic title") as HTMLInputElement).value).toBe("Build tagging");
    fireEvent.click(screen.getByText("Create topic"));
    expect(save).toHaveBeenCalledWith({ id: undefined, fromSeq: 1, toSeq: 3, title: "Build tagging" });
  });

  it("ignores a touch that does not start on the grip", () => {
    render(<TopicsTab threadId="t" />);
    const row = document.querySelector<HTMLElement>("[data-turn]");
    fireEvent.pointerDown(row?.querySelector("[data-pick]") as HTMLElement, { button: 0, pointerType: "touch" });
    fireEvent.pointerUp(row?.querySelector("[data-pick]") as HTMLElement);
    expect(screen.queryByLabelText("Topic title")).toBeNull();
  });

  it("asks the model for topics on a button press", () => {
    render(<TopicsTab threadId="t" />);
    fireEvent.click(screen.getByText("Suggest topics"));
    expect(suggest).toHaveBeenCalledOnce();
  });

  it("shows suggestions as proposals that are saved only when accepted", () => {
    suggestions = [{ fromSeq: 3, toSeq: 3, title: "Tree-Ansicht", tags: ["tree"] }];
    render(<TopicsTab threadId="t" />);
    expect(screen.getByText("AI suggestion")).toBeTruthy();
    fireEvent.click(screen.getByText("Accept"));
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 3, toSeq: 3, title: "Tree-Ansicht" }));
    expect(save).not.toHaveBeenCalled();
  });
});
