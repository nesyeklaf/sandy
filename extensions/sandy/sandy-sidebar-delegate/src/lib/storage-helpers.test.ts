// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_EVENTS } from "./browser-events";
import { createCachedRpcState } from "./cached-rpc-state";
import { lifecycleRowsCodec } from "./lifecycle-cache-codec";
import { STORAGE_KEYS } from "./storage-keys";
import { usePersistedPreference } from "./use-persisted-preference";
import type { PreferenceCodec } from "./use-persisted-preference";

const key = STORAGE_KEYS.activeSort.key;
const codec: PreferenceCodec<number> = {
  fallback: () => 7,
  decode: (stored) => {
    const value: unknown = JSON.parse(stored ?? "null");
    return typeof value === "number" ? value : null;
  },
  encode: JSON.stringify,
};

function blockStorage() {
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  return remove;
}

function quotaStorage() {
  localStorage.setItem(STORAGE_KEYS.workingSince.key, "x".repeat(20));
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
    const size = Object.keys(this).reduce(
      (total, storedKey) => total + (storedKey === name ? 0 : this.getItem(storedKey)!.length),
      value.length,
    );
    if (size > 20) throw new DOMException("Full", "QuotaExceededError");
    original.call(this, name, value);
  });
  return vi.spyOn(Storage.prototype, "removeItem");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("persisted preference", () => {
  it("restores window preferences from session storage without changing local preferences", () => {
    const sessionCodec: PreferenceCodec<number> = { ...codec, storage: "session" };
    localStorage.setItem(key, "99");
    const first = renderHook(() => usePersistedPreference(key, sessionCodec));
    expect(first.result.current[0]).toBe(7);
    act(() => first.result.current[1](12));
    first.unmount();
    const restored = renderHook(() => usePersistedPreference(key, sessionCodec));
    expect(restored.result.current[0]).toBe(12);
    expect(localStorage.getItem(key)).toBe("99");
    sessionStorage.clear();
    const freshWindow = renderHook(() => usePersistedPreference(key, sessionCodec));
    expect(freshWindow.result.current[0]).toBe(7);
  });

  it.each([null, "bad JSON", "{}", '"wrong type"'])("falls back for %s and writes the fallback on mount", (stored) => {
    if (stored !== null) localStorage.setItem(key, stored);
    const hook = renderHook(() => usePersistedPreference(key, codec));
    expect(hook.result.current[0]).toBe(7);
    expect(localStorage.getItem(key)).toBe("7");
  });

  it("reads lazily, accepts functional updates, and writes on changes only", () => {
    localStorage.setItem(key, "12");
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    const hook = renderHook(() => usePersistedPreference(key, codec));
    expect(hook.result.current[0]).toBe(12);
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    hook.rerender();
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    act(() => hook.result.current[1]((current) => current + 1));
    expect(hook.result.current[0]).toBe(13);
    expect(localStorage.getItem(key)).toBe("13");
  });

  it("prunes persisted values and reapplies pruning when its context changes", () => {
    const hook = renderHook(
      ({ cap }) => usePersistedPreference(key, { ...codec, prune: (value) => Math.min(value, cap) }),
      { initialProps: { cap: 5 } },
    );
    expect(hook.result.current[0]).toBe(7);
    expect(localStorage.getItem(key)).toBe("5");
    hook.rerender({ cap: 3 });
    expect(localStorage.getItem(key)).toBe("3");
    expect(hook.result.current[0]).toBe(7);
  });

  it("keeps UI updates usable if storage is blocked", () => {
    const remove = blockStorage();
    const hook = renderHook(() => usePersistedPreference(key, codec));
    act(() => hook.result.current[1](9));
    expect(hook.result.current[0]).toBe(9);
    expect(remove).not.toHaveBeenCalled();
  });

  it("falls back when reading storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    const hook = renderHook(() => usePersistedPreference(key, codec));
    expect(hook.result.current[0]).toBe(7);
  });

  it("recovers from quota pressure through the registry", () => {
    const remove = quotaStorage();
    const hook = renderHook(() => usePersistedPreference(key, codec));
    expect(hook.result.current[0]).toBe(7);
    expect(remove.mock.calls).toEqual([[STORAGE_KEYS.workingSince.key]]);
    expect(localStorage.getItem(key)).toBe("7");
  });

  it("keeps the preference usable when its value cannot fit after all evictions", () => {
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const hook = renderHook(() => usePersistedPreference(key, codec));
    act(() => hook.result.current[1](9));
    expect(hook.result.current[0]).toBe(9);
    expect(localStorage.getItem(key)).toBeNull();
    expect(remove).toHaveBeenLastCalledWith(key);
  });

  it("synchronizes external consumers without writing on mount or external events", () => {
    const external: PreferenceCodec<number> = {
      ...codec,
      subscribe: (listener) => {
        window.addEventListener("storage", listener);
        window.addEventListener(BROWSER_EVENTS.portLinkHostChanged, listener);
        return () => {
          window.removeEventListener("storage", listener);
          window.removeEventListener(BROWSER_EVENTS.portLinkHostChanged, listener);
        };
      },
      notify: () => window.dispatchEvent(new Event(BROWSER_EVENTS.portLinkHostChanged)),
    };
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const first = renderHook(() => usePersistedPreference(key, external));
    const second = renderHook(() => usePersistedPreference(key, external));
    expect(writes).not.toHaveBeenCalled();
    act(() => first.result.current[1](10));
    expect(second.result.current[0]).toBe(10);
    expect(writes).toHaveBeenCalledTimes(1);
    act(() => {
      localStorage.setItem(key, "20");
      window.dispatchEvent(new Event("storage"));
    });
    expect(first.result.current[0]).toBe(20);
    expect(second.result.current[0]).toBe(20);
    expect(writes).toHaveBeenCalledTimes(2);
    act(() => second.result.current[1]((value) => value + 1));
    expect(first.result.current[0]).toBe(21);
    const remove = blockStorage();
    act(() => first.result.current[1](30));
    expect(first.result.current[0]).toBe(21);
    expect(second.result.current[0]).toBe(21);
    expect(remove).not.toHaveBeenCalled();
    const unsubscribe = vi.spyOn(window, "removeEventListener");
    first.unmount();
    second.unmount();
    expect(unsubscribe.mock.calls.filter(([event]) => event === "storage")).toHaveLength(2);
    expect(unsubscribe.mock.calls.filter(([event]) => event === BROWSER_EVENTS.portLinkHostChanged)).toHaveLength(2);
  });
});

describe("cached RPC state", () => {
  it.each([null, "bad JSON", "{}", '"wrong type"'])("returns null for %s", (stored) => {
    if (stored !== null) localStorage.setItem(key, stored);
    expect(createCachedRpcState(key, codec).read({})).toBeNull();
  });

  it("isolates live state per client while new clients read the latest storage", () => {
    localStorage.setItem(key, "1");
    const cache = createCachedRpcState(key, codec);
    const first = {},
      second = {};
    expect(cache.read(first)).toBe(1);
    cache.write(first, 2);
    expect(cache.read(second)).toBe(2);
    cache.write(second, 3);
    expect(cache.read(first)).toBe(2);
    expect(cache.read(second)).toBe(3);
    expect(cache.read({})).toBe(3);
  });

  it("preserves both historical storage-read caching policies", () => {
    const reread = createCachedRpcState(key, codec);
    const remembered = createCachedRpcState(key, codec, { rememberStoredReads: true });
    const client = {};
    localStorage.setItem(key, "1");
    expect(reread.read(client)).toBe(1);
    expect(remembered.read(client)).toBe(1);
    localStorage.setItem(key, "2");
    expect(reread.read(client)).toBe(2);
    expect(remembered.read(client)).toBe(1);
  });

  it("prunes storage without losing complete live lifecycle rows", () => {
    const cache = createCachedRpcState(STORAGE_KEYS.lifecycle.key, lifecycleRowsCodec);
    const client = {};
    const rows = new Map(
      Array.from({ length: 501 }, (_, i) => [
        String(i),
        {
          threadId: String(i),
          parkedAt: i,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
        },
      ]),
    );
    expect(cache.write(client, rows)).toBe(rows);
    expect(cache.read(client)).toBe(rows);
    expect(cache.read({})?.size).toBe(500);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.lifecycle.key)!)).toHaveLength(500);
  });

  it("keeps successful RPC values in memory when storage is blocked", () => {
    const remove = blockStorage();
    const cache = createCachedRpcState(key, codec),
      client = {};
    expect(cache.write(client, 9)).toBe(9);
    expect(cache.read(client)).toBe(9);
    expect(cache.read({})).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns null when reading storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    expect(createCachedRpcState(key, codec).read({})).toBeNull();
  });

  it("retains the RPC result when quota recovery still cannot save it", () => {
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const cache = createCachedRpcState(key, codec),
      client = {};
    cache.write(client, 9);
    expect(cache.read(client)).toBe(9);
    expect(cache.read({})).toBeNull();
    expect(remove).toHaveBeenLastCalledWith(key);
  });

  it("recovers from quota pressure without losing per-client state", () => {
    const remove = quotaStorage();
    const cache = createCachedRpcState(key, codec),
      client = {};
    cache.write(client, 9);
    expect(cache.read(client)).toBe(9);
    expect(localStorage.getItem(key)).toBe("9");
    expect(remove.mock.calls).toEqual([[STORAGE_KEYS.workingSince.key]]);
  });
});
