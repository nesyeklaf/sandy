import { renderTemplate } from "@sandy/templates";
import { truncateToWidthAtWordBoundary } from "@sandy/text-utils";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { preferredAiPluginId, runTextAiTask } from "./ai-tasks.js";

const MAX_COMMIT_SUBJECT_WIDTH = 72;

export interface GenerateCommitMessageArgs {
  diffDescription: string;
  shortstat: string;
  files: string;
  patch: string;
}

export function buildCommitMessagePrompt(
  args: GenerateCommitMessageArgs,
): string {
  return renderTemplate("generateCommitMessage", {
    diffDescription: args.diffDescription,
    shortstat: args.shortstat,
    files: args.files,
    patch: args.patch,
  });
}

export function sanitizeGeneratedCommitMessage(value: string): string | null {
  const message = truncateToWidthAtWordBoundary(
    value.replace(/\s+/gu, " ").trim(),
    MAX_COMMIT_SUBJECT_WIDTH,
  ).trim();
  return message.length > 0 ? message : null;
}

export async function generateCommitMessage(
  deps: LoggedWorkSessionDeps,
  args: GenerateCommitMessageArgs,
  providerId: string | null,
): Promise<string | null> {
  const preferredPluginId = preferredAiPluginId(deps, providerId);
  const outcome = await runTextAiTask(deps, {
    task: "commit-message",
    label: "Commit message generation",
    prompt: buildCommitMessagePrompt(args),
    ...(preferredPluginId === undefined ? {} : { preferredPluginId }),
  });
  return outcome.ok ? sanitizeGeneratedCommitMessage(outcome.value) : null;
}
