import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SHOP = fileURLToPath(new URL("../../../../docs/designs/holons/fixtures/shop", import.meta.url));
export const FIXTURE_NOW = "2026-11-08T12:00:00Z";
export const FIXTURE_COMMIT = "fixture";

export function expected(name: string): unknown {
  return JSON.parse(readFileSync(join(SHOP, "expected", name), "utf8")) as unknown;
}

export function tempCopy(source: string): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "holon-test-"));
  cpSync(source, dir, { recursive: true });
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function strip(value: unknown, key: string | null): unknown {
  if (Array.isArray(value)) return key === "warnings" ? value.map((item) => (typeof item === "string" ? "<text>" : strip(item, null))) : value.map((item) => strip(item, null));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, inner] of Object.entries(value)) {
      if (name === "detail" && typeof inner === "string") out[name] = "<text>";
      else if (key === "warnings" && name === "message") out[name] = "<text>";
      else out[name] = strip(inner, name);
    }
    return out;
  }
  return value;
}

export function withoutText(value: unknown): unknown {
  return strip(JSON.parse(JSON.stringify(value)) as unknown, null);
}
