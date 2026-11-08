import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseEvidenceLines, type Evidence } from "../core/format.ts";
import type { CodeChanges, EvalEnv } from "../core/evaluate.ts";

export const SHOP = fileURLToPath(new URL("../../../../docs/designs/holons/fixtures/shop", import.meta.url));
export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
export const FIXTURE_NOW = "2026-11-08T12:00:00Z";
export const FIXTURE_COMMIT = "fixture";

export const noGit: CodeChanges = { changedPaths: () => null };

export const fixtureEnv: EvalEnv = { nowMs: Date.parse(FIXTURE_NOW), commit: FIXTURE_COMMIT, code: noGit };

export function shopEvidence(): Evidence[] {
  const parsed = parseEvidenceLines(readFileSync(join(SHOP, "evidence.jsonl"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

export function expected(name: string): unknown {
  return JSON.parse(readFileSync(join(SHOP, "expected", name), "utf8")) as unknown;
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
