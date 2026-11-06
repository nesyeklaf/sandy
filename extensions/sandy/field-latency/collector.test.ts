import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { startCollector, type Collector } from "./collector.ts";
import type { Sample } from "./contract.ts";

type Listener = (event: unknown) => void;
type Region = "main" | "sidebar";

class FakeElement {
  region: Region;
  attrs: Record<string, string>;
  trigger: boolean;
  constructor(region: Region, attrs: Record<string, string> = {}, trigger = false) {
    this.region = region;
    this.attrs = attrs;
    this.trigger = trigger;
  }
  get isConnected() {
    return true;
  }
  get parentElement() {
    return null;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  closest(selector: string) {
    if (selector === '[data-sidebar="inset"]') return this.region === "main" ? this : null;
    if (selector === "[data-sidebar-thread-id]") return this.attrs["data-sidebar-thread-id"] === undefined ? null : this;
    if (selector.startsWith("button, a")) return this.trigger ? this : null;
    return null;
  }
}

class FakeMutationObserver {
  static all: FakeMutationObserver[] = [];
  callback: (records: unknown[]) => void;
  observing = false;
  constructor(callback: (records: unknown[]) => void) {
    this.callback = callback;
    FakeMutationObserver.all.push(this);
  }
  observe() {
    this.observing = true;
  }
  disconnect() {
    this.observing = false;
  }
}

interface Timer {
  at: number;
  run: () => void;
  id: number;
}

interface Lab {
  samples: Sample[];
  now: () => number;
  advance(ms: number): void;
  click(threadId: string): void;
  ready(threadId: string): void;
  mutate(region: Region): void;
  hide(): void;
}

const globals = ["document", "location", "Element", "HTMLAnchorElement", "MutationObserver", "requestAnimationFrame", "MessageChannel", "CSS", "performance", "setTimeout", "clearTimeout"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let collector: Collector | null = null;
let controller: AbortController | null = null;

function install(): Lab {
  for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  let now = 5000;
  let nextId = 1;
  let timers: Timer[] = [];
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const schedule = (run: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ at: now + Math.max(0, ms), run, id });
    return id;
  };
  set("performance", { now: () => now });
  set("setTimeout", (run: () => void, ms = 0) => schedule(run, ms));
  set("clearTimeout", (id: number) => void (timers = timers.filter((timer) => timer.id !== id)));
  set("requestAnimationFrame", (run: (stamp: number) => void) => schedule(() => run(now), 16 - (now % 16)));
  set(
    "MessageChannel",
    class {
      port1: { onmessage: (() => void) | null; close(): void } = { onmessage: null, close() {} };
      port2 = { postMessage: () => void schedule(() => this.port1.onmessage?.(), 0) };
    },
  );
  set("CSS", { escape: (value: string) => value });
  set("Element", FakeElement);
  set("HTMLAnchorElement", class {});
  set("MutationObserver", FakeMutationObserver);
  FakeMutationObserver.all = [];
  const listeners = new Map<string, Listener[]>();
  let rowsOf: string | null = null;
  const document = {
    visibilityState: "visible",
    body: {},
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: () => {},
    getElementsByTagName: () => ({ length: 10 }),
    querySelector: (selector: string) => {
      if (selector === "#thread-detail-follow-up-composer") return {};
      if (selector.startsWith("[data-timeline-row-id^=")) return rowsOf !== null && selector.includes(rowsOf) ? {} : null;
      return null;
    },
  };
  const location = { pathname: "/threads/thr_start" };
  set("document", document);
  set("location", location);
  const sidebarItems = new Map<string, FakeElement>();
  const main = new FakeElement("main");
  const sidebar = new FakeElement("sidebar");
  const samples: Sample[] = [];
  controller = new AbortController();
  collector = startCollector((sample) => samples.push(sample), controller.signal);
  const dispatch = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    samples,
    now: () => now,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        now = Math.max(now, due.at);
        due.run();
      }
      now = target;
    },
    click(threadId) {
      let item = sidebarItems.get(threadId);
      if (!item) {
        item = new FakeElement("sidebar", { "data-sidebar-thread-id": threadId }, true);
        sidebarItems.set(threadId, item);
      }
      dispatch("pointerdown", { button: 0, target: item, timeStamp: now });
    },
    ready(threadId) {
      location.pathname = "/threads/" + threadId;
      rowsOf = threadId;
      this.mutate("main");
    },
    mutate(region) {
      const target = region === "main" ? main : sidebar;
      for (const observer of FakeMutationObserver.all) {
        if (observer.observing) observer.callback([{ target, addedNodes: [] }]);
      }
    },
    hide() {
      document.visibilityState = "hidden";
      dispatch("visibilitychange", {});
    },
  };
}

beforeEach(() => {
  saved.clear();
});

afterEach(() => {
  controller?.abort();
  collector?.dispose();
  collector = null;
  controller = null;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function onlySwitch(lab: Lab, index: number): Sample {
  const sample = lab.samples.filter((item) => item.kind === "switch")[index];
  assert.ok(sample, "switch sample " + index);
  return sample;
}

test("a late card write moves contentDoneMs past readyMs, a later sidebar write does not", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(300);
  lab.mutate("main");
  lab.advance(400);
  lab.mutate("sidebar");
  lab.advance(6000);
  assert.equal(lab.samples.length, 1);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "settled");
  assert.ok(sample.readyMs !== null && sample.readyMs >= 100 && sample.readyMs < 140, String(sample.readyMs));
  assert.ok(sample.contentDoneMs !== null && sample.contentDoneMs >= 400 && sample.contentDoneMs < 440, String(sample.contentDoneMs));
});

test("sidebar writes alone leave contentDoneMs at the ready paint", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(250);
  lab.mutate("sidebar");
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "settled");
  assert.equal(sample.contentDoneMs, sample.readyMs);
});

test("a new switch aborts the previous content measurement and measures the new one", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(200);
  lab.click("thr_b");
  lab.advance(100);
  lab.ready("thr_b");
  lab.advance(6000);
  const first = onlySwitch(lab, 0);
  const second = onlySwitch(lab, 1);
  assert.equal(first.contentDone, "aborted");
  assert.equal(first.contentDoneMs, null);
  assert.notEqual(first.readyMs, null);
  assert.equal(second.contentDone, "settled");
  assert.equal(second.contentDoneMs, second.readyMs);
});

test("hiding the tab aborts the content measurement", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(200);
  lab.hide();
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "aborted");
  assert.equal(sample.contentDoneMs, null);
});

test("content that keeps changing is capped at 5 s", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  for (let step = 0; step < 15; step += 1) {
    lab.advance(400);
    lab.mutate("main");
  }
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "capped");
  assert.ok(sample.contentDoneMs !== null && sample.contentDoneMs > 4500 && sample.contentDoneMs <= 5000, String(sample.contentDoneMs));
});

test("a switch that never becomes ready times out without a content value", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(1000);
  lab.mutate("main");
  lab.advance(20000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.timedOut, true);
  assert.equal(sample.contentDone, "aborted");
  assert.equal(sample.contentDoneMs, null);
});
