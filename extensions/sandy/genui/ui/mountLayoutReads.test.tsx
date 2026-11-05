// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Value } from "../core/types";
import { rememberHeight, useReservedHeight } from "./reservedHeight";
import { UiRuntimeContext, type UiRuntime } from "./runtime";
import { useWidth } from "./components/chartKit";
import { TextArea } from "./components/fields";
import { useSmoothHeight } from "./components/motion";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: { supports: () => true } });
});

vi.mock("@sandy-sdk/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sandy-sdk/plugin-sdk/app")>()),
  useSettings: () => ({ values: undefined, isLoading: true }),
}));

const runtime: UiRuntime = {
  setValue() {},
  run: async () => {},
  openFile: null,
  loadImage: null,
  holdHeight: () => () => {},
  readText: null,
  loadAudio: null,
  loadAsset: null,
  superseded: false,
  threadId: null,
  blockKey: null,
};

const observers = new Set<{ report(width: number, height: number): void }>();

class FakeResizeObserver {
  private target: Element | null = null;
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  unobserve() {}
  disconnect() {
    observers.delete(this);
  }
  report(width: number, height: number) {
    if (this.target === null) return;
    const entry = {
      target: this.target,
      contentRect: new DOMRect(0, 0, width, height),
      borderBoxSize: [{ inlineSize: width, blockSize: height }],
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

function report(width: number, height: number): void {
  act(() => {
    for (const observer of [...observers]) observer.report(width, height);
  });
}

function deliverWithoutAct(width: number, height: number): void {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  try {
    for (const observer of [...observers]) observer.report(width, height);
  } finally {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  }
}

function flushQueuedUpdates(): void {
  act(() => {});
}

const LAYOUT_PROPERTIES = ["offsetHeight", "offsetWidth", "clientHeight", "clientWidth", "scrollHeight", "scrollWidth"] as const;
let reads: string[];
const restore: (() => void)[] = [];

function countLayoutReads(): void {
  reads = [];
  for (const property of LAYOUT_PROPERTIES) {
    const owner = [HTMLElement.prototype, Element.prototype].find((prototype) => Object.getOwnPropertyDescriptor(prototype, property)) ?? Element.prototype;
    const original = Object.getOwnPropertyDescriptor(owner, property)!;
    Object.defineProperty(owner, property, {
      configurable: true,
      get() {
        reads.push(property);
        return original.get!.call(this);
      },
    });
    restore.push(() => Object.defineProperty(owner, property, original));
  }
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    reads.push("getBoundingClientRect");
    return rect.call(this);
  };
  restore.push(() => (Element.prototype.getBoundingClientRect = rect));
  const style = window.getComputedStyle;
  window.getComputedStyle = ((...args: Parameters<typeof style>) => {
    reads.push("getComputedStyle");
    return style(...args);
  }) as typeof style;
  restore.push(() => (window.getComputedStyle = style));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {} }) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  countLayoutReads();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  observers.clear();
  while (restore.length > 0) restore.pop()!();
  vi.unstubAllGlobals();
});

function render(element: ReactNode): void {
  act(() => root.render(element));
}

describe("TextArea", () => {
  const AREA = { scrollHeight: 0, clientHeight: 80, offsetHeight: 82 };

  function area(value: string) {
    const binding: Value = { kind: "binding", name: "notes", value };
    return (
      <UiRuntimeContext value={runtime}>
        <TextArea props={{ value: binding, label: "Notes" }} />
      </UiRuntimeContext>
    );
  }

  function measured(): HTMLTextAreaElement {
    const element = container.querySelector("textarea")!;
    for (const property of Object.keys(AREA) as (keyof typeof AREA)[]) {
      Object.defineProperty(element, property, { configurable: true, get: () => AREA[property] });
    }
    return element;
  }

  beforeEach(() => {
    AREA.scrollHeight = 80;
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ paddingTop: "6px", paddingBottom: "6px", lineHeight: "20px" } as CSSStyleDeclaration);
  });

  it("reads no layout when it mounts, and keeps its three rows when the text fits them", () => {
    render(area("short"));
    expect(reads).toEqual([]);
    const element = measured();
    report(300, 82);
    expect(element.style.height).toBe("");
  });

  it("grows at its first report when a long text overflows its three rows", () => {
    render(area("long ".repeat(200)));
    expect(reads).toEqual([]);
    const element = measured();
    AREA.scrollHeight = 150;
    report(300, 82);
    expect(element.style.height).toBe("152px");
    expect(element.style.overflowY).toBe("hidden");
  });

  it("follows the text while typing: grows to the content, stops at twelve rows and scrolls, shrinks again", () => {
    render(area("one"));
    report(300, 82);
    const element = measured();
    AREA.scrollHeight = 150;
    render(area("one\ntwo\nthree\nfour\nfive\nsix"));
    expect(element.style.height).toBe("152px");
    AREA.scrollHeight = 1000;
    render(area("many ".repeat(400)));
    expect(element.style.height).toBe("254px");
    expect(element.style.overflowY).toBe("auto");
    AREA.scrollHeight = 90;
    render(area("two"));
    expect(element.style.height).toBe("92px");
    expect(element.style.overflowY).toBe("hidden");
  });

  it("fits again when the pane narrows, and ignores a report at the same width", () => {
    render(area("some text that wraps"));
    report(300, 82);
    const element = measured();
    AREA.scrollHeight = 120;
    report(300, 82);
    expect(element.style.height).toBe("");
    report(200, 82);
    expect(element.style.height).toBe("122px");
  });
});

describe("useReservedHeight", () => {
  function Block({ id }: { id: string }) {
    const { content, minHeight } = useReservedHeight(id, false);
    return (
      <div data-testid="holder" style={{ minHeight }}>
        <div ref={content}>text</div>
      </div>
    );
  }

  it("reads no layout when it mounts, and holds the remembered height at the width it was laid out at", () => {
    rememberHeight("mount-same", 720, 500);
    render(<Block id="mount-same" />);
    expect(reads).toEqual([]);
    report(720, 300);
    expect(container.querySelector<HTMLElement>("[data-testid=holder]")?.style.minHeight).toBe("500px");
  });

  it("drops the remembered height before paint when the first report is at another width", () => {
    rememberHeight("mount-narrow", 720, 500);
    render(<Block id="mount-narrow" />);
    expect(container.querySelector<HTMLElement>("[data-testid=holder]")?.style.minHeight).toBe("500px");
    deliverWithoutAct(360, 700);
    expect(container.querySelector<HTMLElement>("[data-testid=holder]")?.style.minHeight).toBe("");
    flushQueuedUpdates();
    expect(container.querySelector<HTMLElement>("[data-testid=holder]")?.style.minHeight).toBe("");
  });
});

describe("useWidth", () => {
  function Frame() {
    const [ref, width] = useWidth<HTMLDivElement>();
    return <div ref={ref}>{width}</div>;
  }

  it("reads no layout when it attaches, and takes the width from the first report", () => {
    render(<Frame />);
    expect(reads).toEqual([]);
    expect(container.textContent).toBe("0");
    deliverWithoutAct(321, 100);
    expect(container.textContent).toBe("321");
    flushQueuedUpdates();
    expect(container.textContent).toBe("321");
    report(400, 100);
    expect(container.textContent).toBe("400");
  });
});

describe("useSmoothHeight", () => {
  function Section() {
    const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
    return (
      <div ref={outer}>
        <div ref={inner}>content</div>
      </div>
    );
  }

  it("reads no layout when it mounts, and does not glide to its first size", () => {
    const animate = vi.spyOn(Element.prototype, "animate");
    render(<Section />);
    expect(reads).toEqual([]);
    window.dispatchEvent(new Event("pointerdown"));
    report(300, 120);
    expect(animate).not.toHaveBeenCalled();
  });
});
