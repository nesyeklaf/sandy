import { WAKE_DIGEST_ENTRIES_MAX, WAKE_DIGEST_INTERVAL_MS } from "./space-coordination-contract";
import type { ServerContext } from "./server-context";
import type { SpaceDeps } from "./server-space-deps";
import type { SpaceRolesService } from "./server-space-roles-service";

type WakeOutcome = "failed" | "question" | "finished";

interface WakeEntry {
  threadId: string;
  title: string;
  outcome: WakeOutcome;
}

interface PendingDigest {
  entries: WakeEntry[];
  omittedCount: number;
  timer: ReturnType<typeof setTimeout>;
}

function formatDigest(entries: readonly WakeEntry[], omittedCount: number): string {
  const lines = entries.map((entry) => `- ${entry.title} (${entry.threadId}): ${entry.outcome}`);
  const omitted = omittedCount > 0 ? [`(${omittedCount} older outcomes omitted)`] : [];
  return ["Managed sessions in your Space need a look:", ...omitted, ...lines].join("\n");
}

function createWakeDigest(deps: SpaceDeps, rolesService: SpaceRolesService) {
  const pending = new Map<string, PendingDigest>();

  async function flush(spaceId: string): Promise<void> {
    const digest = pending.get(spaceId);
    if (digest === undefined) return;
    pending.delete(spaceId);
    const text = formatDigest(digest.entries, digest.omittedCount);
    for (const orchestratorId of await rolesService.verifiedOrchestrators(spaceId)) {
      try {
        await deps.ctx.sandy.sdk.threads.send({
          threadId: orchestratorId,
          input: [{ type: "text", text, mentions: [] }],
          mode: "queue-if-active",
        });
      } catch (error) {
        deps.ctx.sandy.log.warn(`Could not send the wake digest to ${orchestratorId}: ${String(error)}`);
      }
    }
  }

  function record(spaceId: string, entry: WakeEntry): void {
    if (!deps.roles.wakeEnabled(spaceId)) return;
    const existing = pending.get(spaceId);
    const digest =
      existing ??
      ({
        entries: [],
        omittedCount: 0,
        timer: setTimeout(() => void flush(spaceId), WAKE_DIGEST_INTERVAL_MS),
      } satisfies PendingDigest);
    digest.entries.push(entry);
    if (digest.entries.length > WAKE_DIGEST_ENTRIES_MAX) {
      digest.entries.shift();
      digest.omittedCount += 1;
    }
    pending.set(spaceId, digest);
  }

  function recordOutcome(thread: { id: string; title: string | null; sectionId: string | null }, outcome: WakeOutcome) {
    if (thread.sectionId === null) return;
    if (deps.roles.modeOf(thread.id) !== "managed") return;
    if (deps.roles.orchestratorSpaceOf(thread.id) !== null) return;
    record(thread.sectionId, { threadId: thread.id, title: thread.title ?? thread.id, outcome });
  }

  function dispose(): void {
    for (const digest of pending.values()) clearTimeout(digest.timer);
    pending.clear();
  }

  return { recordOutcome, flush, dispose };
}

export function registerWakeDigest(ctx: ServerContext, deps: SpaceDeps, rolesService: SpaceRolesService): void {
  const wake = createWakeDigest(deps, rolesService);
  ctx.sandy.events.on("thread.failed", ({ thread }) => wake.recordOutcome(thread, "failed"));
  ctx.sandy.events.on("thread.idle", ({ thread }) => wake.recordOutcome(thread, "finished"));
  ctx.sandy.events.on("interaction.pending", ({ thread }) => wake.recordOutcome(thread, "question"));
  ctx.sandy.onDispose(() => wake.dispose());
}
