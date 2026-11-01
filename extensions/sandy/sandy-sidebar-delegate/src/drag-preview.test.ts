// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createDragPreview } from "./drag-preview";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function fixture(reduced = false) {
  document.body.innerHTML = "<ul><li><div data-drag-visual></div></li></ul>";
  const list = document.querySelector("ul")!;
  const visual = list.querySelector<HTMLElement>("[data-drag-visual]")!;
  const media = new EventTarget();
  Object.assign(media, { matches: reduced });
  vi.stubGlobal("matchMedia", () => media);
  let listTop = 100,
    visualTop = 120;
  vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({ top: listTop }) as DOMRect);
  vi.spyOn(visual, "getBoundingClientRect").mockImplementation(() => ({ top: visualTop }) as DOMRect);
  const effects: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    const effect = { cancel: vi.fn(), onfinish: null };
    effects.push(effect);
    return effect as unknown as Animation;
  });
  visual.animate = animate;
  return {
    list,
    media,
    animate,
    effects,
    move: (row: number, scroll = 100) => {
      visualTop = row;
      listTop = scroll;
    },
  };
}

it("retargets from the visible position, coalesces captures and removes effects on cleanup", () => {
  const f = fixture();
  const preview = createDragPreview(f.list);
  preview.capture();
  f.move(170);
  preview.capture(); // Before the same React commit: keep the original snapshot.
  preview.play();
  expect(f.animate.mock.calls[0]).toEqual([
    [{ transform: "translateY(-50px)" }, { transform: "translateY(0)" }],
    { duration: 150, easing: "ease-out" },
  ]);
  f.move(140); // Intermediate visible position of the running animation.
  preview.capture();
  f.move(110, 80); // New layout plus 20px of scrolling.
  preview.play();
  expect(f.effects[0]!.cancel).toHaveBeenCalledOnce();
  expect(f.animate.mock.calls[1]![0][0]).toEqual({ transform: "translateY(10px)" });
  preview.destroy();
  expect(f.effects[1]!.cancel).toHaveBeenCalledOnce();
  expect(f.list.hasAttribute("data-drag-preview")).toBe(false);
  preview.play();
  expect(f.animate).toHaveBeenCalledTimes(2);
});

it("skips motion and cancels a running effect when reduced motion changes", () => {
  const f = fixture(true);
  const preview = createDragPreview(f.list);
  preview.capture();
  f.move(170);
  preview.play();
  expect(f.animate).not.toHaveBeenCalled();
  Object.assign(f.media, { matches: false });
  preview.capture();
  f.move(120);
  preview.play();
  expect(f.animate).toHaveBeenCalledOnce();
  Object.assign(f.media, { matches: true });
  f.media.dispatchEvent(new Event("change"));
  expect(f.effects[0]!.cancel).toHaveBeenCalledOnce();
  preview.destroy();
});

it("releases finished effects instead of retaining or cancelling them later", () => {
  const f = fixture();
  const preview = createDragPreview(f.list);
  preview.capture();
  f.move(170);
  preview.play();
  f.effects[0]!.onfinish!();
  preview.destroy();
  expect(f.effects[0]!.cancel).not.toHaveBeenCalled();
});
