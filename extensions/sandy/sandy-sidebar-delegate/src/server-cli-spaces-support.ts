import { PluginCliError, type PluginCliResult } from "@sandy-sdk/plugin-sdk";
import { ZodError } from "zod";
import { SpaceCoordinationError } from "./space-coordination-error";
import type { PluginCliContext } from "@sandy-sdk/plugin-sdk";
import type { SpaceActor } from "./server-space-deps";
import type { ServerSpace } from "./server-space";

export const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;

export function actorOf(ctx: PluginCliContext): SpaceActor {
  return ctx.threadId === undefined ? { kind: "owner" } : { kind: "session", threadId: ctx.threadId };
}

export function requireOwner(ctx: PluginCliContext): void {
  if (ctx.threadId !== undefined) {
    throw new PluginCliError("This command is for the owner. Sessions cannot run it.", { code: "owner_only" });
  }
}

export function jsonResult(value: unknown): PluginCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` };
}

function textResult(lines: readonly string[]): PluginCliResult {
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

export function render(asJson: boolean, value: unknown, lines: readonly string[]): PluginCliResult {
  return asJson ? jsonResult(value) : textResult(lines);
}

export async function attempt(work: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    if (error instanceof SpaceCoordinationError) throw new PluginCliError(error.message, { code: error.code });
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
      throw new PluginCliError(message, { code: "invalid_value" });
    }
    throw error;
  }
}

export async function resolveSpaceId(space: ServerSpace, idOrName: string): Promise<string> {
  const names = await space.deps.membership.sectionNames();
  if (names.has(idOrName)) return idOrName;
  const matches = [...names.entries()].filter(([, name]) => name.toLowerCase() === idOrName.toLowerCase());
  const [match] = matches;
  if (matches.length === 1 && match !== undefined) return match[0];
  if (matches.length > 1) {
    throw new PluginCliError(`Several Spaces are named ${idOrName}; use the Space id.`, { code: "invalid_value" });
  }
  throw new PluginCliError(`Space ${idOrName} does not exist.`, { code: "space_missing" });
}
