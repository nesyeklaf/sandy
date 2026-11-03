import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagFilterBar } from "./TagFilterBar";
import { setTagFilter } from "./useTagFilter";

vi.mock("./useTagIndex", () => ({
  useTagIndex: () => ({
    threadTags: { a: ["alpha", "beta", "gamma"], b: ["beta", "gamma"], c: ["gamma"] },
    segments: [],
  }),
}));

afterEach(() => {
  cleanup();
  setTagFilter({ tag: null, query: "" });
});

describe("tag filter bar", () => {
  it("shows the picked tag first and scrolls the row back to the start", () => {
    render(<TagFilterBar />);
    const row = screen.getByRole("button", { name: /gamma/ }).parentElement as HTMLElement;
    row.scrollLeft = 600;
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    expect(row.scrollLeft).toBe(0);
    expect(screen.getAllByRole("button")[0]?.textContent).toBe("alpha 1");
  });

  it("puts a released tag back in count order", () => {
    render(<TagFilterBar />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["gamma 3", "beta 2", "alpha 1"]);
  });
});
