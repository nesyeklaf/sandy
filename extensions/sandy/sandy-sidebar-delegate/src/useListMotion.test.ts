// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { createListAnimationController, useListMotion } from "./useListMotion";

const frames = new Map<number, FrameRequestCallback>();
const effects: Array<{
  node: HTMLElement;
  top: number;
  left: number;
  active: boolean;
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
}> = [];
const animate = vi.fn(function (this: HTMLElement, keyframes: Keyframe[]) {
  const [left, top] = String(keyframes[0]?.transform)
    .match(/-?[\d.]+/g)!
    .map(Number);
  const effect = { node: this, top: top! / 2, left: left! / 2, active: true, cancel: vi.fn(), finish: () => {} };
  effect.cancel.mockImplementation(() => {
    effect.active = false;
  });
  effects.push(effect);
  return {
    cancel: effect.cancel,
    effect: { getComputedTiming: () => ({ progress: 0.5 }) },
    addEventListener: (_name: string, callback: () => void) => {
      effect.finish = () => {
        effect.active = false;
        callback();
      };
    },
  };
});
let sequence = 0;

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  frames.clear();
  effects.length = 0;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  await Promise.resolve();
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

function list(count = 0) {
  const parent = document.createElement("ul");
  parent.append(...Array.from({ length: count }, row));
  document.body.append(parent);
  return parent;
}
function geometry(node: HTMLElement, top: () => number, left = () => 0) {
  return vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
    let y = top();
    let x = left();
    for (const effect of effects) {
      if (effect.active && effect.node.contains(node)) {
        y += effect.top;
        x += effect.left;
      }
    }
    return { top: y, left: x } as DOMRect;
  });
}
function row() {
  const node = document.createElement("li");
  geometry(node, () => Array.from(node.parentElement?.children ?? []).indexOf(node) * 32);
  return node;
}

describe("inbox list motion", () => {
  it("does not register geometry observers on compact viewports or with reduced motion", () => {
    const desktop = createListAnimationController();
    const compact = createListAnimationController(false);
    const register = vi.spyOn(desktop, "register");
    const compactRegister = vi.spyOn(compact, "register");
    function List({ controller }: { controller: typeof desktop }) {
      return createElement("ul", { ref: useListMotion<HTMLUListElement>(controller) });
    }
    const view = render(createElement(List, { controller: compact }));
    expect(compactRegister).not.toHaveBeenCalled();
    view.rerender(createElement(List, { controller: desktop }));
    expect(register).toHaveBeenCalledOnce();
    view.unmount();
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    render(createElement(List, { controller: desktop }));
    expect(register).toHaveBeenCalledOnce();
  });

  it("batches list changes into one frame and never animates layout dimensions", async () => {
    const controller = createListAnimationController();
    const first = list(2);
    const second = list(1);
    const detachFirst = controller.register(first);
    const detachSecond = controller.register(second);
    first.prepend(row());
    second.prepend(row());
    await flush();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledTimes(5);
    for (const args of animate.mock.calls) {
      for (const keyframe of (args as unknown as [Keyframe[]])[0]) {
        expect(Object.keys(keyframe).sort()).toEqual(["opacity", "transform"]);
      }
    }
    detachFirst();
    detachSecond();
    expect(effects.every((effect) => effect.cancel.mock.calls.length === 1)).toBe(true);
  });

  it("skips bulk expansion and collapse, keeps removed rows absent, and resumes small updates", async () => {
    const controller = createListAnimationController();
    const parent = list();
    const detach = controller.register(parent);
    parent.append(...Array.from({ length: 100 }, row));
    await flush();
    expect(animate).not.toHaveBeenCalled();
    parent.replaceChildren();
    await flush();
    expect(parent.children).toHaveLength(0);
    expect(animate).not.toHaveBeenCalled();
    parent.append(row());
    await flush();
    expect(animate).toHaveBeenCalledOnce();
    effects[0]!.finish();
    detach();
    expect(effects[0]!.cancel).not.toHaveBeenCalled();
  });

  it("continues an interrupted move from its current visual position", async () => {
    const controller = createListAnimationController();
    const parent = list(1);
    const original = parent.firstElementChild;
    const detach = controller.register(parent);
    parent.prepend(row());
    await flush();
    parent.prepend(row());
    await flush();
    const calls = animate.mock.calls.filter((_, index) => animate.mock.contexts[index] === original);
    // Half of the first 32px move remains when another row arrives.
    expect((calls.at(-1) as unknown as [Keyframe[]])[0][0]?.transform).toBe("translate(0px, -48px)");
    detach();
  });

  it("keeps stationary shelves still when the dock grows upward, including scroll changes", async () => {
    const controller = createListAnimationController();
    const scroller = document.createElement("div");
    scroller.dataset.listMotionScroller = "";
    geometry(
      scroller,
      () => 100,
      () => 50,
    );
    document.body.append(scroller);
    const dock = document.createElement("div");
    const snoozed = document.createElement("section");
    const settled = document.createElement("section");
    const rows = list();
    snoozed.append(rows);
    dock.append(snoozed, settled);
    scroller.append(dock);
    let height = 0;
    Object.defineProperty(settled, "offsetTop", { get: () => 50 + height });
    geometry(dock, () => 500 - height - scroller.scrollTop);
    geometry(snoozed, () => 500 - height - scroller.scrollTop);
    geometry(
      settled,
      () => 550 - scroller.scrollTop,
      () => 50 - scroller.scrollLeft,
    );
    const detachDock = controller.register(dock);
    const detachRows = controller.register(rows);
    for (const expanded of [true, false]) {
      // Settled's offset within the dock changes, but its content position does not.
      height = expanded ? 64 : 0;
      scroller.scrollTop += 10;
      scroller.scrollLeft += 5;
      rows.replaceChildren(...(expanded ? [row(), row()] : []));
      await flush();
      expect(animate.mock.contexts).not.toContain(settled);
    }
    expect(dock.style.position).toBe("");
    detachRows();
    detachDock();
  });

  it("re-measures after rows resize without list changes, so later motion starts on screen", async () => {
    const observers: Array<{ callback: () => void; targets: Set<Element> }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets = new Set<Element>();
        constructor(public callback: () => void) {
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.add(target);
        }
        unobserve(target: Element) {
          this.targets.delete(target);
        }
        disconnect() {}
      },
    );
    const controller = createListAnimationController();
    const outer = list();
    const above = document.createElement("section");
    const below = document.createElement("section");
    const rows = list();
    below.append(rows);
    outer.append(above, below);
    let growth = 0;
    geometry(above, () => 0);
    geometry(below, () => 100 + growth);
    const detachOuter = controller.register(outer);
    const detachRows = controller.register(rows);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.targets).toContain(outer);
    expect(observers[0]!.targets).toContain(rows);
    await flush();
    // A row in the upper shelf grows: no list gains or loses a child.
    growth = 37;
    observers[0]!.callback();
    expect(frames.size).toBe(0);
    rows.append(row());
    await flush();
    expect(animate.mock.contexts).not.toContain(below);
    expect(animate.mock.contexts).not.toContain(above);
    detachRows();
    detachOuter();
    expect(observers[0]!.targets.size).toBe(0);
  });

  it("animates later shelves when a shelf's list mounts or unmounts inside it", async () => {
    const controller = createListAnimationController();
    const outer = list();
    const active = document.createElement("section");
    const below = document.createElement("section");
    outer.append(active, below);
    let rowsHeight = 0;
    geometry(active, () => 0);
    geometry(below, () => 40 + rowsHeight);
    const detachOuter = controller.register(outer);
    await flush();
    // Expanding renders the shelf's row list for the first time: only the
    // shelf's own subtree changes, which no registered list observes.
    const rows = list(2);
    active.append(rows);
    rowsHeight = 64;
    const detachRows = controller.register(rows);
    await flush();
    const opened = animate.mock.calls.filter((_, index) => animate.mock.contexts[index] === below);
    expect((opened.at(-1) as unknown as [Keyframe[]])[0][0]?.transform).toBe("translate(0px, -64px)");
    effects.forEach((effect) => effect.finish());
    rows.remove();
    rowsHeight = 0;
    detachRows();
    await flush();
    const closed = animate.mock.calls.filter((_, index) => animate.mock.contexts[index] === below);
    expect((closed.at(-1) as unknown as [Keyframe[]])[0][0]?.transform).toBe("translate(0px, 64px)");
    detachOuter();
  });

  it("measures every list before writes and avoids doubling nested interrupted moves", async () => {
    const controller = createListAnimationController();
    const outer = list();
    const section = document.createElement("section");
    const inner = list(1);
    const child = inner.firstElementChild as HTMLElement;
    section.append(inner);
    outer.append(section);
    let top = 100;
    const reads: string[] = [];
    geometry(section, () => {
      reads.push("read");
      return top;
    });
    geometry(child, () => {
      reads.push("read");
      return top + 20;
    });
    // Child refs may register before their ancestor ref.
    const detachInner = controller.register(inner);
    const detachOuter = controller.register(outer);
    const originalAnimate = animate.getMockImplementation()!;
    animate.mockImplementation(function (this: HTMLElement, keyframes) {
      reads.push("write");
      return originalAnimate.call(this, keyframes);
    });
    for (const nextTop of [140, 180]) {
      reads.length = 0;
      top = nextTop;
      inner.append(document.createElement("li"));
      await flush();
      expect(reads.lastIndexOf("read")).toBeLessThan(reads.indexOf("write"));
      expect(animate.mock.contexts).not.toContain(child);
    }
    const calls = animate.mock.calls.filter((_, index) => animate.mock.contexts[index] === section);
    expect(calls.at(-1)?.[0][0]?.transform).toBe("translate(0px, -60px)");
    detachInner();
    detachOuter();
    animate.mockImplementation(originalAnimate);
  });

  it("isolates nested drag holds between inboxes and registers new lists while suspended", async () => {
    const first = createListAnimationController();
    const second = createListAnimationController();
    first.suspend();
    first.suspend();
    const a = list();
    const b = list();
    const detachA = first.register(a);
    const detachB = second.register(b);
    a.append(row());
    b.append(row());
    await flush();
    expect(animate).toHaveBeenCalledOnce();
    first.resume();
    a.append(row());
    await flush();
    expect(animate).toHaveBeenCalledOnce();
    first.resume();
    await flush();
    expect(animate).toHaveBeenCalledOnce();
    a.append(row());
    await flush();
    expect(animate).toHaveBeenCalledTimes(2);
    detachA();
    detachB();
  });

  it("cancels pending frames and animations on detach, and does no idle polling", async () => {
    const controller = createListAnimationController();
    const parent = list();
    const interval = vi.spyOn(window, "setInterval");
    const detach = controller.register(parent);
    parent.append(row());
    await flush();
    parent.append(row());
    await Promise.resolve();
    expect(frames.size).toBe(1);
    detach();
    expect(frames.size).toBe(0);
    expect(effects[0]!.cancel).toHaveBeenCalledOnce();
    expect(interval).not.toHaveBeenCalled();
    parent.append(row());
    await flush();
    expect(animate).toHaveBeenCalledOnce();
    interval.mockRestore();
  });
});
