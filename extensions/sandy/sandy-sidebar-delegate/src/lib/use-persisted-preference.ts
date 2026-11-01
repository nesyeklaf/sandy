import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import { decodeStoredValue, readStorageRaw, readStoredValue, writeStoredValue } from "./storage-codec";
import type { StorageCodec } from "./storage-codec";

export interface PreferenceCodec<T> extends StorageCodec<T> {
  fallback(): T;
  // External preferences write only on explicit changes and read storage on events.
  subscribe?(listener: () => void): () => void;
  notify?(): void;
}

const noSubscription = () => () => {};
const noSnapshot = () => null;

export function usePersistedPreference<T>(key: string, codec: PreferenceCodec<T>): [T, Dispatch<SetStateAction<T>>] {
  const [local, setLocal] = useState(() => readStoredValue(key, codec) ?? codec.fallback());
  const snapshot = useCallback(() => readStorageRaw(key, codec.storage), [key, codec.storage]);
  const stored = useSyncExternalStore(
    codec.subscribe ?? noSubscription,
    codec.subscribe ? snapshot : noSnapshot,
    noSnapshot,
  );
  const value = codec.subscribe ? (decodeStoredValue(stored, codec) ?? codec.fallback()) : local;

  useEffect(() => {
    if (!codec.subscribe) writeStoredValue(key, codec, local);
  }, [key, codec, local]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (!codec.subscribe) {
        setLocal(next);
        return;
      }
      const current = readStoredValue(key, codec) ?? codec.fallback();
      const updated = typeof next === "function" ? (next as (previous: T) => T)(current) : next;
      writeStoredValue(key, codec, updated);
      codec.notify?.();
    },
    [key, codec],
  );
  return [value, setValue];
}
