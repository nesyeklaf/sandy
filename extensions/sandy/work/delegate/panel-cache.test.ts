import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { describe, expect, it } from "vitest";
import { createPanelListCache } from "./server/panel-cache.ts";

async function collectGarbage() {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  for (let round = 0; round < 3; round++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function clock() {
  let value = 0;
  return { now: () => value, advance: (ms: number) => void (value += ms) };
}

describe("createPanelListCache", () => {
  it("shares one load between concurrent reads of a thread", async () => {
    let loads = 0;
    const cache = createPanelListCache(async (id) => ({ id, n: ++loads }), 2_000, clock().now);
    const [a, b] = await Promise.all([cache.get("t"), cache.get("t")]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
  });

  it("releases expired results of threads that are never read again", async () => {
    const time = clock();
    const refs: Array<WeakRef<object>> = [];
    const cache = createPanelListCache(
      async (id) => {
        const value = { id, rows: new Array(100).fill(id) };
        refs.push(new WeakRef(value));
        return value;
      },
      2_000,
      time.now,
      1_000,
    );
    for (let index = 0; index < 20; index++) await cache.get(`old-${index}`);
    time.advance(60_000);
    await cache.get("fresh");
    await collectGarbage();
    const retained = refs.filter((ref) => ref.deref() !== undefined).length;
    expect(retained).toBeLessThanOrEqual(1);
  });

  it("bounds the number of distinct settled entries", async () => {
    const time = clock();
    let loads = 0;
    const cache = createPanelListCache(async () => ++loads, 2_000, time.now, 3);
    for (const id of ["a", "b", "c", "d", "e"]) await cache.get(id);
    expect(loads).toBe(5);
    await cache.get("e");
    await cache.get("d");
    expect(loads).toBe(5);
    await cache.get("a");
    expect(loads).toBe(6);
  });

  it("never evicts an in-flight read to make room", async () => {
    const time = clock();
    const gates = new Map<string, () => void>();
    let loads = 0;
    const cache = createPanelListCache(
      (id) =>
        new Promise<number>((resolve) => {
          loads += 1;
          gates.set(id, () => resolve(loads));
        }),
      2_000,
      time.now,
      2,
    );
    const first = cache.get("a");
    cache.get("b");
    cache.get("c");
    expect(cache.get("a")).toBe(first);
    expect(loads).toBe(3);
    gates.get("a")?.();
    await first;
  });

  it("does not let an invalidated read settle over a newer entry", async () => {
    const time = clock();
    const gates: Array<() => void> = [];
    let loads = 0;
    const cache = createPanelListCache(
      () =>
        new Promise<number>((resolve) => {
          const generation = ++loads;
          gates.push(() => resolve(generation));
        }),
      2_000,
      time.now,
      4,
    );
    const stale = cache.get("t");
    cache.invalidate("t");
    const fresh = cache.get("t");
    gates[1]();
    await fresh;
    gates[0]();
    await stale;
    time.advance(1_000);
    expect(await cache.get("t")).toBe(2);
    expect(loads).toBe(2);
  });
});
