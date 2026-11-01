import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeSwitches,
  contentMainThread,
  createProfileAnalysis,
  matchLabWindows,
  parseJsFrame,
  stackCategories,
  summarizeWindows,
  switchWindows,
} from "./gecko-profile.mjs";

const CATEGORIES = [
  { name: "Idle", subcategories: ["Other"] },
  { name: "Other", subcategories: ["Other"] },
  { name: "Layout", subcategories: ["Other", "Style computation", "Reflow"] },
  { name: "JavaScript", subcategories: ["Other", "JIT (ion)"] },
];
const IDLE = 0;
const LAYOUT = 2;
const JS = 3;

const measure = (name, startTime, endTime) => [
  0,
  startTime,
  endTime,
  1,
  0,
  { type: "UserTiming", name, entryType: "measure" },
];

const thread = ({
  name = "GeckoMain",
  processType = "tab",
  pid = 10,
  frames = [],
  stacks = [],
  samples = [],
  markers = [],
  strings = [],
}) => ({
  name,
  processType,
  pid,
  tid: pid + 1,
  stringTable: ["marker", ...strings],
  frameTable: {
    schema: { location: 0, category: 1, subcategory: 2 },
    data: frames.map(([location, category = null, subcategory = null]) => [
      location === null ? null : strings.indexOf(location) + 1,
      category,
      subcategory,
    ]),
  },
  stackTable: {
    schema: { prefix: 0, frame: 1 },
    data: stacks,
  },
  samples: {
    schema: { stack: 0, time: 1, threadCPUDelta: 2 },
    data: samples,
  },
  markers: {
    schema: {
      name: 0,
      startTime: 1,
      endTime: 2,
      phase: 3,
      category: 4,
      data: 5,
    },
    data: markers,
  },
});

const MAIN_STRINGS = [
  "render (http://app/assets/boot.js:1:100)[5]",
  "measure (http://app/assets/boot.js:1:900)[5]",
  "Reflow http://app/",
  "0x7f00",
];

const mainThread = (overrides = {}) =>
  thread({
    strings: MAIN_STRINGS,
    frames: [
      [MAIN_STRINGS[0], JS, 1],
      [MAIN_STRINGS[1], JS, 0],
      [MAIN_STRINGS[2], LAYOUT, 2],
      [MAIN_STRINGS[3]],
      [null, IDLE, 0],
    ],
    stacks: [
      [null, 0],
      [0, 1],
      [1, 2],
      [2, 3],
      [null, 4],
    ],
    samples: [
      [0, 100, 0],
      [1, 101, 1e6],
      [3, 102, 1e6],
      [3, 103, 1e6],
      [4, 104, 1e6],
      [0, 105, 0],
      [0, 200, 1e6],
    ],
    markers: [
      measure("lab:switch", 99, 106),
      measure("sandy:switch", 100, 106),
      measure("sandy:switch:render", 101, 104),
    ],
    ...overrides,
  });

const profileWith = (threads) => ({
  meta: { categories: CATEGORIES },
  threads: [],
  processes: [{ threads }],
});

describe("parseJsFrame", () => {
  it("reads named, anonymous and non-JS frame locations", () => {
    assert.deepEqual(
      parseJsFrame("render (http://app/assets/boot.js:3:7)[2]"),
      {
        name: "render",
        url: "http://app/assets/boot.js",
        line: 3,
        column: 7,
      },
    );
    assert.deepEqual(parseJsFrame("http://app/assets/boot.js:4:1"), {
      name: "(anonymous)",
      url: "http://app/assets/boot.js",
      line: 4,
      column: 1,
    });
    assert.equal(parseJsFrame("Reflow http://app/"), null);
    assert.equal(parseJsFrame("0x7f00"), null);
  });
});

describe("stackCategories", () => {
  it("lets frames without a category inherit the category of their caller", () => {
    const { category, subcategory } = stackCategories(mainThread(), CATEGORIES);
    assert.deepEqual([...category], [JS, JS, LAYOUT, LAYOUT, IDLE]);
    assert.deepEqual([...subcategory], [1, 0, 2, 2, 0]);
  });
});

describe("contentMainThread", () => {
  it("picks the content GeckoMain that recorded switch spans", () => {
    const parent = mainThread({ processType: "default", pid: 1 });
    const otherTab = mainThread({ pid: 20, markers: [] });
    const app = mainThread({ pid: 30 });
    assert.equal(contentMainThread(profileWith([parent, otherTab, app])), app);
    assert.equal(contentMainThread(profileWith([parent, otherTab])), null);
  });
});

describe("createProfileAnalysis", () => {
  it("charges native leaf time to the innermost JS function but only JS samples to jsMs", () => {
    const analysis = createProfileAnalysis(profileWith([mainThread()]));
    const result = analysis.attribute({ name: "w", start: 100, end: 105 });
    assert.equal(result.durationMs, 5);
    assert.equal(result.sampledMs, 4);
    assert.equal(result.idleMs, 1);
    assert.deepEqual(
      result.categories
        .map(({ category, ms }) => [category, ms])
        .sort((a, b) => a[0].localeCompare(b[0])),
      [
        ["JavaScript", 2],
        ["Layout", 2],
      ],
    );
    assert.deepEqual(
      result.functions.map(({ name, ms, jsMs }) => [name, ms, jsMs]),
      [
        ["measure", 3, 1],
        ["render", 1, 1],
      ],
    );
    assert.equal(result.functions[0].location, "boot.js:1:900");
  });

  it("clips samples to the window and caps the weight of a sample before a gap", () => {
    const analysis = createProfileAnalysis(profileWith([mainThread()]));
    const clipped = analysis.attribute({ name: "w", start: 101.5, end: 102.5 });
    assert.equal(clipped.sampledMs, 1);
    const gap = analysis.attribute({ name: "w", start: 105, end: 200 });
    assert.equal(gap.sampledMs, 10);
  });

  it("names functions by their source-mapped location when a resolver knows the chunk", () => {
    const analysis = createProfileAnalysis(profileWith([mainThread()]), {
      resolve: (url, line, column) =>
        url.endsWith("boot.js") && line === 0 && column === 899
          ? { source: "src/measure.ts", line: 41 }
          : null,
    });
    const result = analysis.attribute({ name: "w", start: 100, end: 105 });
    assert.deepEqual(
      result.functions.map(({ name, location }) => [name, location]),
      [
        ["measure", "src/measure.ts:42"],
        ["render", "boot.js:1:100"],
      ],
    );
  });

  it("prorates style thread CPU of the same process to the window", () => {
    const style = thread({
      name: "StyleThread#0",
      pid: 10,
      samples: [
        [null, 100, 0],
        [null, 104, 8e6],
      ],
    });
    const foreign = thread({
      name: "StyleThread#0",
      pid: 99,
      samples: [
        [null, 100, 0],
        [null, 104, 8e6],
      ],
    });
    const analysis = createProfileAnalysis(
      profileWith([mainThread(), style, foreign]),
    );
    const result = analysis.attribute({ name: "w", start: 101, end: 103 });
    assert.equal(result.styloMs, 4);
    assert.equal(result.styloThreads.length, 1);
    assert.equal(result.mainCpuMs, 2);
  });
});

describe("switch windows", () => {
  it("nests phases in their switch and pairs each lab action with the switch it started", () => {
    const timings = [
      { name: "lab:switch", start: 0, end: 50 },
      { name: "sandy:switch", start: 10, end: 60 },
      { name: "sandy:switch:render", start: 20, end: 40 },
      { name: "lab:switch", start: 100, end: 150 },
      { name: "sandy:switch", start: 300, end: 400 },
      { name: "sandy:switch:render", start: 310, end: 320 },
    ];
    const switches = switchWindows(timings);
    assert.deepEqual(
      switches.map((entry) => entry.phases.map((phase) => phase.start)),
      [[20], [310]],
    );
    const pairs = matchLabWindows(timings, switches);
    assert.equal(pairs[0].app.start, 10);
    assert.equal(pairs[1].app, null);
  });

  it("attributes every lab window and averages them per phase", () => {
    const result = analyzeSwitches(profileWith([mainThread()]));
    assert.equal(result.windows.length, 1);
    const [window] = result.windows;
    assert.deepEqual(
      window.phases.map(({ phase, durationMs }) => [phase, durationMs]),
      [["render", 3]],
    );
    const summary = summarizeWindows([window.phases[0], window.phases[0]]);
    assert.equal(summary.windows, 2);
    assert.equal(summary.durationMs, 3);
    assert.deepEqual(
      summary.functions.map(({ name, ms, jsMs }) => [name, ms, jsMs]),
      [["measure", 3, 1]],
    );
  });
});
