import { createHash } from "node:crypto";

export const DAY_MS = 86_400_000;

export function contractHash(contract: string): string {
  return `sha256:${createHash("sha256").update(contract, "utf8").digest("hex")}`;
}

export function parseInstant(value: string): number {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) throw new Error(`not a timestamp: ${value}`);
  return ms;
}

export function formatInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
