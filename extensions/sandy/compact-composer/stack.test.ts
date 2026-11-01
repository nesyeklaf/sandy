// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { countFoldable, findStack, isPinned, stackItems } from "./stack";

// The composer as sandy 0.46.1 renders it: shell > stack grid, plugin banners in
// display: contents roots (sandy-recap adds a second contents wrapper inside its
// root), native cards and pending interactions as plain children.
function composer() {
  document.body.innerHTML = `
    <div data-promptbox-shell>
      <div class="grid" id="stack">
        <div data-sandy-plugin-root style="display: contents" data-sandy-plugin="compact-composer" id="own">
          <div class="cc-bar" id="bar"><button>Hide</button></div>
        </div>
        <div data-sandy-plugin-root style="display: contents" data-sandy-plugin="sandy-recap">
          <div style="display: contents"><div id="recap">Recap</div></div>
        </div>
        <div data-sandy-plugin-root style="display: contents" data-sandy-plugin="followups"><div id="followups-empty"></div></div>
        <div id="native">Committed</div>
        <div id="question"><div data-testid="user-question-banner">Which one?</div></div>
      </div>
      <div data-promptbox-editor-scroll></div>
    </div>`;
  const get = (id: string) => document.getElementById(id) as HTMLElement;
  return { stack: get("stack"), own: get("own"), bar: get("bar"), get };
}

describe("findStack", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the shell child that holds the bar, whatever its classes", () => {
    const { stack, bar } = composer();
    stack.className = "something-else";
    expect(findStack(bar)).toBe(stack);
  });

  it("returns null outside a composer shell", () => {
    document.body.innerHTML = `<div class="grid"><div id="bar"></div></div>`;
    expect(findStack(document.getElementById("bar")!)).toBeNull();
  });
});

describe("stackItems", () => {
  it("looks through every display: contents wrapper and skips the bar's root", () => {
    const { stack, own } = composer();
    expect(stackItems(stack, own).map((item) => item.id)).toEqual([
      "recap",
      "followups-empty",
      "native",
      "question",
    ]);
  });
});

describe("countFoldable", () => {
  it("counts only cards that show something", () => {
    const { stack, own } = composer();
    const shown = (item: HTMLElement) => item.id !== "followups-empty";
    expect(countFoldable(stack, own, shown)).toBe(2);
  });

  it("never counts a pending question, approval or plan review", () => {
    const { stack, own, get } = composer();
    expect(isPinned(get("question"))).toBe(true);
    expect(countFoldable(stack, own, () => true)).toBe(3);
  });

  it("is zero when nothing but a pending question is shown", () => {
    const { stack, own } = composer();
    const shown = (item: HTMLElement) => item.id === "question";
    expect(countFoldable(stack, own, shown)).toBe(0);
  });
});
