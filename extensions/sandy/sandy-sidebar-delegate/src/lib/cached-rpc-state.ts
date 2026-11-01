import { readStoredValue, writeStoredValue } from "./storage-codec";
import type { StorageCodec } from "./storage-codec";

export function createCachedRpcState<T>(
  key: string,
  codec: StorageCodec<T>,
  { rememberStoredReads = false }: { rememberStoredReads?: boolean } = {},
) {
  const byClient = new WeakMap<object, T>();
  return {
    read(client: object): T | null {
      const cached = byClient.get(client);
      if (cached !== undefined) return cached;
      const stored = readStoredValue(key, codec);
      // Settings historically remember a storage read; order and lifecycle
      // reread it until the first successful RPC response for this client.
      if (rememberStoredReads && stored !== null) byClient.set(client, stored);
      return stored;
    },
    write(client: object, value: T): T {
      byClient.set(client, value);
      writeStoredValue(key, codec, value);
      return value;
    },
  };
}
