// Pure file logic of the host entry: merge the policy into pi's permissions.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Policy, PolicyState } from "./contract.ts";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
  return path.join(dir, "permissions.json");
}

function readObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`${file} is not valid JSON; fix or remove it (not overwritten): ${String(cause)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object (not overwritten)`);
  }
  return parsed as Record<string, unknown>;
}

/** Writes only mode, readOnly and blockedCommands; every other key survives. */
export function applyPolicy(file: string, policy: Policy): void {
  const next = {
    version: 1,
    ...readObject(file),
    mode: policy.mode,
    readOnly: policy.readOnly,
    blockedCommands: { programs: policy.programs, allow: policy.allow },
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

export function readPolicy(file: string): PolicyState {
  const raw = readObject(file);
  const blocked = (raw.blockedCommands ?? {}) as Record<string, unknown>;
  return {
    path: file,
    mode: typeof raw.mode === "string" ? raw.mode : null,
    readOnly: typeof raw.readOnly === "boolean" ? raw.readOnly : null,
    programs: strings(blocked.programs),
    allow: strings(blocked.allow),
  };
}
