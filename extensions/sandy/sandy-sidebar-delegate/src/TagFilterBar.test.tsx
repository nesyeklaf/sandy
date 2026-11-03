import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagFilterBar } from "./TagFilterBar";
import { NO_FILTER } from "./tag-filter";
import { setTagFilter, useTagFilter } from "./useTagFilter";

vi.mock("./useTagIndex", () => ({
  useTagIndex: () => ({
    threadTags: { a: ["alpha", "beta", "gamma"], b: ["beta", "gamma"], c: ["gamma"] },
    segments: [],
  }),
}));

function Probe() {
  return <output data-testid="tags">{useTagFilter().tags.join(",")}</output>;
}

afterEach(() => {
  cleanup();
  setTagFilter(NO_FILTER);
});

function openPicker() {
  render(
    <>
      <TagFilterBar />
      <Probe />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Filter by tags" }));
}

describe("tag filter bar", () => {
  it("shows no tag chips, only a button that opens the list", () => {
    render(<TagFilterBar />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("picks several tags and shows how many are picked", () => {
    openPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /gamma/ }));
    expect(screen.getByTestId("tags").textContent).toBe("alpha,gamma");
    expect(screen.getByRole("button", { name: "Filter by tags: alpha, gamma" }).textContent).toBe("2");
  });

  it("unpicks one tag and clears all", () => {
    setTagFilter({ tags: ["alpha", "beta"] });
    render(
      <>
        <TagFilterBar />
        <Probe />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Filter by tags/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /alpha/ }));
    expect(screen.getByTestId("tags").textContent).toBe("beta");
    fireEvent.click(screen.getByRole("button", { name: "Clear tags" }));
    expect(screen.getByTestId("tags").textContent).toBe("");
  });

  it("lists a picked tag that no session carries so it can be unpicked", () => {
    setTagFilter({ tags: ["gone"] });
    render(<TagFilterBar />);
    fireEvent.click(screen.getByRole("button", { name: /Filter by tags/ }));
    expect((screen.getByRole("checkbox", { name: /gone/ }) as HTMLInputElement).checked).toBe(true);
  });
});
