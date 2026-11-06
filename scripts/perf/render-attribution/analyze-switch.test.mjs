import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSwitch, HARNESS, ownerOfUrl } from "./analyze-switch.mjs";

const PID = 7;
const TID = 3;
const HOST = "http://127.0.0.1:32910/assets/index-abc.js";
const GENUI = "http://127.0.0.1:32910/api/v1/plugin-app-assets/5500e24ccb7f8088/app.js";
const pluginByHash = { "5500e24ccb7f8088": "genui" };

const mark = (name, ph, ts, local) => ({ cat: "blink.user_timing", name, ph, ts, pid: PID, tid: TID, id2: { local } });
const slice = (name, ts, dur, args = {}) => ({ name, ph: "X", ts, dur, pid: PID, tid: TID, args });
const frame = (id, parent, functionName, url = "") => ({ id, parent, callFrame: { functionName, url, lineNumber: 0, columnNumber: id } });

const traceEvents = () => [
  { ph: "M", name: "thread_name", pid: PID, tid: TID, args: { name: "CrRendererMain" } },
  mark("lab:switch", "b", 1000, "0x1"),
  mark("lab:switch", "e", 31000, "0x1"),
  mark("lab:done", "b", 1000, "0x2"),
  mark("lab:done", "e", 41000, "0x2"),
  slice("RunTask", 1000, 30000),
  slice("FunctionCall", 1000, 20000),
  slice("Layout", 15000, 5000, { beginData: { dirtyObjects: 4, totalObjects: 90, stackTrace: [{ functionName: "measure", url: GENUI }] } }),
  slice("UpdateLayoutTree", 22000, 8000, { elementCount: 120 }),
  { name: "Profile", ph: "P", pid: PID, tid: TID, id: "0x9", ts: 0, args: { data: { startTime: 1000 } } },
  {
    name: "ProfileChunk",
    ph: "P",
    pid: PID,
    tid: TID,
    id: "0x9",
    ts: 0,
    args: {
      data: {
        cpuProfile: {
          nodes: [
            frame(1, undefined, "(root)"),
            frame(2, 1, "dispatch", HOST),
            frame(3, 2, "renderCard", GENUI),
            frame(4, 3, "commitWork", HOST),
            frame(5, 2, "commitRoot", HOST),
            frame(6, 1, "(idle)"),
            frame(7, 1, "cardsRendered"),
            frame(8, 7, "querySelectorAll"),
          ],
          samples: [3, 4, 4, 5, 5, 3, 8, 6],
          timeDeltas: [1000, 4000, 4000, 4000, 2000, 1000, 3000, 2000],
        },
        timeDeltas: [1000, 4000, 4000, 4000, 2000, 1000, 3000, 2000],
      },
    },
  },
];

describe("analyzeSwitch", () => {
  it("charges host frames called from a plugin to that plugin and leaves browser work to the engine", () => {
    const result = analyzeSwitch(traceEvents(), { pluginByHash });
    assert.equal(result.windowMs, 40);
    assert.equal(result.readyMs, 30);
    assert.deepEqual(result.jsByStackOwner, { genui: 12, [HARNESS]: 2, host: 2 });
    assert.deepEqual(result.jsByLeafOwner, { host: 10, genui: 4, [HARNESS]: 2 });
    assert.equal(result.browser.style, 8);
    assert.equal(result.browser.layout, 5);
    assert.equal(result.forced.length, 1);
    assert.equal(result.forced[0].owner, "genui");
    assert.equal(result.styleRecalcs[0].elements, 120);
    assert.equal(result.styleRecalcs[0].forced, false);
  });

  it("refuses a capture without its lab windows", () => {
    const result = analyzeSwitch(traceEvents().filter((event) => event.name !== "lab:done"), { pluginByHash });
    assert.match(result.error, /missing lab windows/);
  });
});

describe("ownerOfUrl", () => {
  it("names a plugin by its asset hash and falls back to the hash", () => {
    assert.equal(ownerOfUrl(GENUI, pluginByHash), "genui");
    assert.equal(ownerOfUrl("http://h/api/v1/plugin-app-assets/ffff/app.js", pluginByHash), "plugin:ffff");
    assert.equal(ownerOfUrl(HOST, pluginByHash), "host");
    assert.equal(ownerOfUrl("", pluginByHash), null);
  });
});
