import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveNetworkPhases, type RequestTiming } from "./network.ts";

function request(startTime: number, responseEnd: number, wait: number, serverTiming: RequestTiming["serverTiming"] = []): RequestTiming {
  return { startTime, requestStart: startTime + 2, responseStart: startTime + 2 + wait, responseEnd, serverTiming };
}

test("without Server-Timing only the network phase exists and it is the wait for the first byte", () => {
  assert.deepEqual(deriveNetworkPhases([request(100, 180, 60)], 90, 200), { network: 60 });
});

test("server is the total metric and network is the wait minus the server time", () => {
  const timed = request(100, 200, 80, [{ name: "db", duration: 15 }, { name: "total", duration: 50 }]);
  assert.deepEqual(deriveNetworkPhases([timed], 90, 210), { server: 50, network: 30 });
});

test("without a total metric the largest metric stands for the server and cannot exceed the wait", () => {
  assert.deepEqual(deriveNetworkPhases([request(0, 100, 80, [{ name: "db", duration: 30 }, { name: "auth", duration: 10 }])], 0, 110), {
    server: 30,
    network: 50,
  });
  assert.deepEqual(deriveNetworkPhases([request(0, 100, 20, [{ name: "total", duration: 90 }])], 0, 110), { server: 20, network: 0 });
});

test("parallel requests count once, through the one that finishes last", () => {
  const slow = request(100, 300, 150, [{ name: "total", duration: 120 }]);
  const quick = request(110, 160, 30, [{ name: "total", duration: 20 }]);
  assert.deepEqual(deriveNetworkPhases([quick, slow], 90, 310), { server: 120, network: 30 });
});

test("a waterfall adds up the gating request of each step", () => {
  const first = request(100, 160, 40, [{ name: "total", duration: 30 }]);
  const second = request(170, 260, 70, [{ name: "total", duration: 50 }]);
  assert.deepEqual(deriveNetworkPhases([first, second], 90, 270), { server: 80, network: 30 });
});

test("requests that started outside the span or finished after it are ignored", () => {
  const before = request(10, 50, 20);
  const unfinished = request(150, 400, 200);
  assert.equal(deriveNetworkPhases([before, unfinished], 100, 300), null);
  assert.equal(deriveNetworkPhases([], 100, 300), null);
});

test("a cached response with no request start has no wait", () => {
  const cached: RequestTiming = { startTime: 100, requestStart: 0, responseStart: 102, responseEnd: 104, serverTiming: [] };
  assert.deepEqual(deriveNetworkPhases([cached], 90, 200), { network: 0 });
});
