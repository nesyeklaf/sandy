import type { StorageCodec } from "./storage-codec";

export function decodeInboxOrder(input: unknown): readonly string[] | null {
  return Array.isArray(input) && input.every((id) => typeof id === "string") ? [...new Set(input)] : null;
}

export const inboxOrderCodec: StorageCodec<readonly string[]> = {
  decode: (stored) => decodeInboxOrder(JSON.parse(stored ?? "null")),
  encode: JSON.stringify,
};
