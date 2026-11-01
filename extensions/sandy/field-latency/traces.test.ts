import { test } from "node:test";
import assert from "node:assert/strict";
import { TraceBook, parseTraceDetail } from "./traces.ts";

function measure(id: number, phase: string, startTime: number, duration: number, kind = "switch", label = "thr_a") {
  return { startTime, duration, detail: { sandy: { interaction: kind, id, label, phase }, devtools: {} } };
}

test("assembles phases into one record when the total arrives", () => {
  const book = new TraceBook();
  assert.equal(book.add(measure(1, "input", 100, 4)), null);
  assert.equal(book.add(measure(1, "render", 104, 80)), null);
  assert.equal(book.add(measure(1, "paint", 184, 16)), null);
  const record = book.add(measure(1, "total", 100, 100));
  assert.deepEqual(record, { id: 1, kind: "switch", label: "thr_a", start: 100, end: 200, phases: { input: 4, render: 80, paint: 16 } });
});

test("a pointer interaction claims the trace that started at its pointerdown, once", () => {
  const book = new TraceBook();
  book.add(measure(2, "total", 500, 30, "open", "menu"));
  assert.equal(book.claim("switch", 500), null);
  assert.equal(book.claim("open", 520), null);
  assert.equal(book.claim("open", 500.5)?.label, "menu");
  assert.equal(book.claim("open", 500.5), null);
});

test("hands out traces nobody claimed, such as keyboard switches", () => {
  const book = new TraceBook();
  book.add(measure(3, "total", 100, 50));
  book.add(measure(4, "total", 900, 50));
  assert.deepEqual(book.takeUnclaimed(500).map((record) => record.id), [3]);
  assert.deepEqual(book.takeUnclaimed(500), []);
});

test("ignores measures that are not sandy traces", () => {
  assert.equal(parseTraceDetail(null), null);
  assert.equal(parseTraceDetail({ devtools: {} }), null);
  assert.equal(parseTraceDetail({ sandy: { interaction: "scroll", id: 1, label: "x", phase: "total" } }), null);
  const book = new TraceBook();
  assert.equal(book.add({ startTime: 0, duration: 1, detail: undefined }), null);
});
