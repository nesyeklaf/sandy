import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagFilterBar } from "./TagFilterBar";
import { labelKey, NO_FILTER } from "./tag-filter";
import { setTagFilter, useTagFilter } from "./useTagFilter";

vi.mock("./useTagIndex", () => ({
  useTagIndex: () => ({
    threadTags: { a: ["alpha", "beta", "gamma"], b: ["beta", "gamma"], c: ["gamma"] },
    threadTopics: { c: ["Bug hunt"] },
    segments: [
      { id: "s1", threadId: "a", fromSeq: 1, toSeq: 2, title: "Design talk", tags: ["gamma"] },
      { id: "s2", threadId: "b", fromSeq: 1, toSeq: 2, title: "Bug hunt", tags: [] },
    ],
  }),
}));

function Probe() {
  const filter = useTagFilter();
  return <output data-testid="filter">{JSON.stringify(filter)}</output>;
}

const filterNow = () => JSON.parse(screen.getByTestId("filter").textContent ?? "{}");

function renderBar() {
  render(
    <>
      <TagFilterBar />
      <Probe />
    </>,
  );
}

afterEach(() => {
  cleanup();
  setTagFilter(NO_FILTER);
});

describe("session filter bar", () => {
  it("has a search field and one button each for search scope, topics and tags, but no tag chips", () => {
    renderBar();
    expect(screen.getByRole("textbox", { name: "Search sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search in: Names and content" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter by topics" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter by tags" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("types the search text into the filter", () => {
    renderBar();
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "login" } });
    expect(filterNow().query).toBe("login");
  });

  it("chooses where to search", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /Search in/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Session content" }));
    expect(filterNow().scope).toBe("content");
    expect(screen.getByRole("button", { name: "Search in: Session content" })).toBeTruthy();
  });

  it("includes several tags, then excludes one, and shows the counts", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Filter by tags" }));
    fireEvent.click(screen.getByRole("button", { name: "alpha, not selected" }));
    fireEvent.click(screen.getByRole("button", { name: "beta, not selected" }));
    const [alpha, beta] = [labelKey("session", "alpha"), labelKey("session", "beta")];
    expect(filterNow().tags).toMatchObject({ include: [alpha, beta], exclude: [], match: "any" });
    fireEvent.click(screen.getByRole("button", { name: "beta, included" }));
    expect(filterNow().tags).toMatchObject({ include: [alpha], exclude: [beta] });
    expect(screen.getByRole("button", { name: "Filter by tags: 1 included, 1 excluded" }).textContent).toBe("1 ✓1 ✕");
    fireEvent.click(screen.getByRole("button", { name: "beta, excluded" }));
    expect(filterNow().tags).toMatchObject({ include: [alpha], exclude: [] });
  });

  it("shows a value carried on both levels once per section, each with its own count, and picks one level", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Filter by tags" }));
    const sessionSection = screen.getByRole("group", { name: "Session" });
    const areaSection = screen.getByRole("group", { name: "In Bereichen" });
    expect(within(sessionSection).getByRole("button", { name: "gamma, not selected" }).textContent).toBe("gamma3");
    expect(within(areaSection).getByRole("button", { name: "gamma, not selected" }).textContent).toBe("gamma1");
    fireEvent.click(within(areaSection).getByRole("button", { name: "gamma, not selected" }));
    expect(filterNow().tags.include).toEqual([labelKey("segment", "gamma")]);
    expect(within(sessionSection).getByRole("button", { name: "gamma, not selected" })).toBeTruthy();
    fireEvent.click(within(areaSection).getByRole("button", { name: "gamma, included" }));
    expect(filterNow().tags).toMatchObject({ include: [], exclude: [labelKey("segment", "gamma")] });
  });

  it("switches between any and all and keeps the mode when clearing", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Filter by tags" }));
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(filterNow().tags.match).toBe("all");
    fireEvent.click(screen.getByRole("button", { name: "alpha, not selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear tags" }));
    expect(filterNow().tags).toEqual({ include: [], exclude: [], match: "all" });
  });

  it("searches inside the tag list", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Filter by tags" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tags" }), { target: { value: "ALP" } });
    expect(screen.getByRole("group", { name: "Session" }).textContent).toBe("Sessionalpha1");
    expect(screen.queryByRole("group", { name: "In Bereichen" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tags" }), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing found")).toBeTruthy();
  });

  it("picks topics, searches them and clears them", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Filter by topics" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search topics" }), { target: { value: "bug" } });
    const areaSection = screen.getByRole("group", { name: "In Bereichen" });
    fireEvent.click(within(areaSection).getByRole("button", { name: "Bug hunt, not selected" }));
    expect(filterNow().topics.include).toEqual([labelKey("segment", "Bug hunt")]);
    fireEvent.click(within(screen.getByRole("group", { name: "Session" })).getByRole("button", { name: /Bug hunt/ }));
    expect(filterNow().topics.include).toEqual([labelKey("segment", "Bug hunt"), labelKey("session", "Bug hunt")]);
    fireEvent.click(screen.getByRole("button", { name: "Clear topics" }));
    expect(filterNow().topics.include).toEqual([]);
  });

  it("lists a picked tag that no session carries so it can be unpicked", () => {
    setTagFilter({ tags: { include: [labelKey("session", "gone")], exclude: [], match: "any" } });
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /Filter by tags/ }));
    expect(screen.getByRole("button", { name: "gone, included" })).toBeTruthy();
  });
});
