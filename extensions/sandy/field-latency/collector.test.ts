import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { startCollector, type Collector } from "./collector.ts";
import type { Load, Sample } from "./contract.ts";
import type { LoadProbe } from "./load.ts";

type Listener = (event: unknown) => void;
type Region = "main" | "sidebar" | "toc" | "genui";

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
    if (selector === '[data-sidebar="inset"]') return this.region === "main" || this.region === "toc" || this.region === "genui" ? this : null;
    if (selector === "[data-thread-toc]") return this.region === "toc" ? this : null;
    if (selector === "[data-sandy-plugin-root]") return this.attrs["data-sandy-plugin"] === undefined ? null : this;
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
  options: MutationObserverInit | undefined;
  observe(_target: unknown, options?: MutationObserverInit) {
    this.observing = true;
    this.options = options;
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
  mutateAttribute(region: Region, name: string, from: string | null, to: string | null): void;
  hide(): void;
}

const globals = ["document", "location", "Element", "HTMLAnchorElement", "MutationObserver", "requestAnimationFrame", "MessageChannel", "CSS", "performance", "setTimeout", "clearTimeout"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let collector: Collector | null = null;
let controller: AbortController | null = null;

function install(probe: LoadProbe | null = null): Lab {
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
  const toc = new FakeElement("toc");
  const genui = new FakeElement("genui", { "data-sandy-plugin": "genui" });
  const samples: Sample[] = [];
  controller = new AbortController();
  collector = startCollector((sample) => samples.push(sample), controller.signal, probe);
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
      const target = region === "main" ? main : region === "toc" ? toc : region === "genui" ? genui : sidebar;
      for (const observer of FakeMutationObserver.all) {
        if (observer.observing) observer.callback([{ target, addedNodes: [] }]);
      }
    },
    mutateAttribute(region, name, from, to) {
      const target = region === "main" ? main : region === "toc" ? toc : sidebar;
      if (to === null) delete target.attrs[name];
      else target.attrs[name] = to;
      for (const observer of FakeMutationObserver.all) {
        if (observer.observing) observer.callback([{ type: "attributes", attributeName: name, oldValue: from, target }]);
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

test("a content write just before the quiet deadline extends the mark instead of settling early", () => {
  for (let offset = 980; offset < 1000; offset += 3) {
    const lab = install();
    lab.click("thr_a");
    lab.advance(100);
    lab.ready("thr_a");
    lab.advance(offset);
    lab.mutate("main");
    lab.advance(6000);
    const sample = onlySwitch(lab, 0);
    assert.equal(sample.contentDone, "settled", "offset " + offset);
    assert.ok(sample.contentDoneMs !== null && sample.contentDoneMs >= 100 + offset, "offset " + offset + ": " + sample.contentDoneMs);
    controller?.abort();
    collector?.dispose();
  }
});

test("a burst of writes before the paint queues one paint callback and one result", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(500);
  for (let write = 0; write < 20; write += 1) lab.mutate("main");
  lab.advance(6000);
  assert.equal(lab.samples.length, 1);
  assert.equal(onlySwitch(lab, 0).contentDone, "settled");
});

test("a second thread click between mount and the ready paint aborts the first content measurement", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(50);
  lab.ready("thr_a");
  lab.click("thr_b");
  lab.advance(100);
  lab.mutate("main");
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.threadId, "thr_a");
  assert.notEqual(sample.readyMs, null);
  assert.equal(sample.contentDone, "aborted");
  assert.equal(sample.contentDoneMs, null);
});

test("a second click on the same thread between mount and the ready paint keeps the measurement", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(50);
  lab.ready("thr_a");
  lab.click("thr_a");
  lab.advance(6000);
  assert.equal(onlySwitch(lab, 0).contentDone, "settled");
});

test("a late attribute-only reveal in the content moves the mark; sidebar and unchanged attributes do not", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(200);
  lab.mutateAttribute("sidebar", "class", "a", "b");
  lab.advance(100);
  lab.mutateAttribute("main", "class", "same", "same");
  lab.advance(100);
  lab.mutateAttribute("main", "style", "display:none", "display:block");
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "settled");
  assert.ok(sample.readyMs !== null && sample.contentDoneMs !== null);
  assert.ok(sample.contentDoneMs >= sample.readyMs + 400 && sample.contentDoneMs < sample.readyMs + 440, String(sample.contentDoneMs));
});

test("a late class change in the table of contents does not extend content done, a late card attribute change does", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(300);
  lab.mutateAttribute("toc", "class", "w-3", "w-5");
  lab.advance(600);
  lab.mutate("toc");
  lab.advance(6000);
  const withToc = onlySwitch(lab, 0);
  assert.equal(withToc.contentDone, "settled");
  assert.ok(withToc.readyMs !== null && withToc.contentDoneMs !== null);
  assert.ok(withToc.contentDoneMs < withToc.readyMs + 40, String(withToc.contentDoneMs));

  const other = install();
  other.click("thr_a");
  other.advance(100);
  other.ready("thr_a");
  other.advance(300);
  other.mutateAttribute("toc", "class", "w-3", "w-5");
  other.advance(100);
  other.mutateAttribute("main", "class", "card-a", "card-b");
  other.advance(6000);
  const withCard = onlySwitch(other, 0);
  assert.ok(withCard.readyMs !== null && withCard.contentDoneMs !== null);
  assert.ok(withCard.contentDoneMs >= withCard.readyMs + 400, String(withCard.contentDoneMs));
});

test("the content watch asks the browser only for visual attributes and old values", () => {
  const lab = install();
  lab.click("thr_a");
  const options = FakeMutationObserver.all.map((observer) => observer.options).find((candidate) => candidate?.attributes === true);
  assert.ok(options);
  assert.equal(options.attributeOldValue, true);
  const filter = options.attributeFilter ?? [];
  for (const name of ["style", "class", "hidden", "data-cc-collapsed", "data-cc-fold", "data-cc-pin"]) assert.ok(filter.includes(name), name);
  assert.ok(!filter.includes("data-testid") && !filter.includes("aria-label"));
});

test("every sample carries the load read for the window that ends at its pointerdown", () => {
  const ends: number[] = [];
  const load: Load = { windowMs: 5000, busyPct: 42, maxLagMs: 900, pressure: "fair", charging: true, batteryPct: 80 };
  const lab = install({
    read: (end) => {
      ends.push(end);
      return load;
    },
  });
  const clickedAt = lab.now();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(6000);
  assert.deepEqual(onlySwitch(lab, 0).load, load);
  assert.deepEqual(ends, [clickedAt]);
});

test("without a probe the sample has no load", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(6000);
  assert.equal(onlySwitch(lab, 0).load, null);
});

test("the plugin that writes last after ready is the sample's content source", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(150);
  lab.mutate("main");
  lab.advance(200);
  lab.mutate("genui");
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "settled");
  assert.equal(sample.contentSource, "genui");
  assert.equal(sample.contentWrites, 2);
});

test("a host ticker after ready is named as the content source of a capped switch", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  for (let step = 0; step < 8; step += 1) {
    lab.advance(900);
    lab.mutate("main");
  }
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "capped");
  assert.equal(sample.contentSource, "host");
  assert.ok(sample.contentWrites !== null && sample.contentWrites >= 4, String(sample.contentWrites));
});

test("a switch with no content change after ready has no content source", () => {
  const lab = install();
  lab.click("thr_a");
  lab.advance(100);
  lab.ready("thr_a");
  lab.advance(6000);
  const sample = onlySwitch(lab, 0);
  assert.equal(sample.contentDone, "settled");
  assert.equal(sample.contentSource, null);
  assert.equal(sample.contentWrites, 0);
});
