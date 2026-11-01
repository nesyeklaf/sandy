import type { Thread } from "@sandy/domain";

type ForkableThread = Pick<Thread, "archivedAt" | "environmentId" | "providerId">;

export function isThreadForkable(
  sourceThread: ForkableThread | null,
  providerSupportsFork: boolean,
): boolean {
  if (
    sourceThread === null ||
    sourceThread.environmentId === null ||
    sourceThread.archivedAt !== null
  ) {
    return false;
  }
  return providerSupportsFork;
}
