// Track drivers v2: the only code that commits a run (design: docs/design-v2.md §6). Every command, from the agent's
// tools, the autopilot's CLI, the owner's RPC and the effect executor, goes through dispatch: per-thread queue, load,
// step (run.ts), size check, save, policy write, published, then the desired effects go to the executor.
// INVARIANT: one live plugin process writes a thread's run (sandy.storage has no compare-and-set; docs/decisions.md).
import { MAX_RUN_BYTES, boundedPrevious, desired, policyFor, step, toldBy, type Command, type Effect, type PolicyFile, type Reply, type Run, type RunId, type Ticket } from "./run.ts";

export type OperationDeps = {
  load(threadId: string): Promise<Run | null>;
  save(threadId: string, run: Run): Promise<void>;
  /** host.ts writePolicy on the thread's host; throws when it was not written. */
  writePolicy(threadId: string, policy: PolicyFile): Promise<void>;
  /** executor.reconcile: what should be in flight for the committed run. */
  effects(threadId: string, effects: Effect[]): void;
  /** The run changed (UI refresh, instruction mirror). */
  notify(threadId: string): void;
  warn(message: string): void;
  now(): number;
  newRunId(): RunId;
  /** The executor's boot id, for recover. */
  boot: string;
};

/**
 * A command's reply with the run as that command left it (not as a later command left it). unpublished: the command
 * changed the run but the guard policy of its rev was not written (the error); the executor retries the publish.
 */
export type Committed = { reply: Reply; run: Run | null; unpublished?: string };

export type Operations = {
  dispatch(threadId: string, command: Command): Promise<Reply>;
  /** dispatch, plus the committed run: a tool result describes its own transition, never a reloaded later one. */
  commit(threadId: string, command: Command): Promise<Committed>;
  /** The executor's publish port: writes the committed run's policy if the run is still at rev. */
  writePolicy(threadId: string, rev: number): Promise<void>;
  /**
   * Clears the guard policy of a thread without a v2 run (a v1 run is not continued), in the thread's queue so it is
   * ordered with commits; a v2 run in the thread publishes its own policy instead. Throws when not written (retry).
   */
  clearPolicy(threadId: string): Promise<void>;
  /** Plugin start: work started by another boot becomes interrupted, then effects are derived again. */
  recover(threadIds: string[]): Promise<void>;
  /** Interval: deadlines of every listed thread; also re-derives effects (retries a failed publish). */
  tick(threadIds: string[]): Promise<void>;
};

/**
 * The bytes the run may need once its current lease settles: passing copies the visit's submissions into the accepted
 * outputs and evidence and into the stage's last visit, and the next lease's previous copies a stage's last visit.
 */
export function settledBytes(run: Run): number {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const own = bytes(run);
  if (run.state.kind !== "active") return own + SETTLE_SLACK_BYTES;
  const previous = Math.max(0, ...Object.values(run.lastVisit).map((visit) => bytes(boundedPrevious(visit))));
  return own + bytes(run.state.lease.submissions) + previous + SETTLE_SLACK_BYTES;
}

/** The closed-lease log row, the clipped causeText and the outcome text a settlement adds (all capped in run.ts). */
const SETTLE_SLACK_BYTES = 4000;

/**
 * The lease work a system command settles: a check or run result (workId), or an owner's answer to a gate approval or
 * force proposal (the form id is the work id). Run-scoped answers (track approval) settle no lease work.
 */
function settledWork(command: Command): { ticket: Ticket; workId: number } | null {
  if (command.by !== "system") return null;
  if (command.op === "checked" || command.op === "ran" || command.op === "interrupted") return { ticket: command.ticket, workId: command.workId };
  if (command.op === "answered" && command.ticket !== null) return { ticket: command.ticket, workId: command.formId };
  return null;
}

export function createOperations(deps: OperationDeps): Operations {
  const queues = new Map<string, Promise<unknown>>();

  function queued<T>(threadId: string, job: () => Promise<T>): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const result = previous.then(job, job);
    const tail = result.catch(() => {});
    queues.set(threadId, tail);
    void tail.then(() => {
      if (queues.get(threadId) === tail) queues.delete(threadId);
    });
    return result;
  }

  async function commit(threadId: string, command: Command): Promise<Committed> {
    const run = await deps.load(threadId);
    const out = step(run, command, deps.now(), { newRunId: deps.newRunId });
    if (out.run === run || out.run === null) {
      deps.effects(threadId, desired(run));
      return { reply: out.reply, run };
    }
    let next = out.run;
    if (command.by === "meter") {
      // A measurement changes no rev and no policy (S6): saved and shown, never published again. It is held to the same
      // reservation as a driver's change, or late reports could use up the room that settling and owner commands need.
      const bytes = settledBytes(next);
      if (bytes > MAX_RUN_BYTES) {
        deps.effects(threadId, desired(run));
        return { reply: { kind: "refused", reasons: [`The track's stored state could grow to ${bytes} bytes with this report (limit ${MAX_RUN_BYTES}); the report is ignored.`] }, run };
      }
      await deps.save(threadId, next);
      deps.notify(threadId);
      deps.effects(threadId, desired(next));
      return { reply: out.reply, run: next };
    }
    if (command.by !== "system") {
      // Accept time reserves the settlement: a driver's change is refused if passing its gate could not be stored.
      const bytes = settledBytes(next);
      if (bytes > MAX_RUN_BYTES) {
        deps.effects(threadId, desired(run));
        return { reply: { kind: "refused", reasons: [`The track's stored state could grow to ${bytes} bytes once this stage settles (limit ${MAX_RUN_BYTES}); submit shorter values.`] }, run };
      }
    } else if (Buffer.byteLength(JSON.stringify(next)) > MAX_RUN_BYTES && settledWork(command) !== null && run !== null) {
      // A settlement is never refused: work whose result does not fit ends as outcome unsaved, the driver retries shorter.
      const work = settledWork(command)!;
      const reason = `it would grow the track's stored state to ${Buffer.byteLength(JSON.stringify(next))} bytes (limit ${MAX_RUN_BYTES}); submit shorter outputs or evidence and try again.`;
      deps.warn(`${threadId}: ${command.op} of work ${work.workId} not kept: ${reason}`);
      const unsaved = step(run, { by: "system", op: "unsaved", ...work, reason }, deps.now(), { newRunId: deps.newRunId });
      if (unsaved.run === run || unsaved.run === null) {
        deps.effects(threadId, desired(run));
        return { reply: unsaved.reply, run };
      }
      next = unsaved.run;
    }
    await deps.save(threadId, next);
    deps.notify(threadId);
    // Graft 3: the policy of the new rev is written in the same queue slot; tell, launch and driver mutations wait for it.
    try {
      await deps.writePolicy(threadId, policyFor(threadId, next));
      const published = step(next, { by: "system", op: "published", rev: next.rev, ...toldBy(command, out.reply) }, deps.now(), { newRunId: deps.newRunId });
      if (published.run !== null && published.run !== next) {
        next = published.run;
        await deps.save(threadId, next);
      }
    } catch (error) {
      const unpublished = error instanceof Error ? error.message : String(error);
      deps.warn(`${threadId}: guard policy rev ${next.rev} not written: ${unpublished}`);
      deps.effects(threadId, desired(next));
      return { reply: out.reply, run: next, unpublished };
    }
    deps.effects(threadId, desired(next));
    return { reply: out.reply, run: next };
  }

  return {
    dispatch: async (threadId, command) => (await queued(threadId, () => commit(threadId, command))).reply,
    commit: (threadId, command) => queued(threadId, () => commit(threadId, command)),
    writePolicy: (threadId, rev) =>
      queued(threadId, async () => {
        const run = await deps.load(threadId);
        if (run === null || run.rev !== rev) throw new Error(`rev ${rev} is not current (${run?.rev ?? "no run"})`);
        await deps.writePolicy(threadId, policyFor(threadId, run));
      }),
    clearPolicy: (threadId) =>
      queued(threadId, async () => {
        if ((await deps.load(threadId)) === null) await deps.writePolicy(threadId, policyFor(threadId, null));
      }),
    async recover(threadIds) {
      await Promise.all(threadIds.map((threadId) => queued(threadId, () => commit(threadId, { by: "system", op: "recover", boot: deps.boot }))));
    },
    async tick(threadIds) {
      await Promise.all(threadIds.map((threadId) => queued(threadId, () => commit(threadId, { by: "system", op: "tick" }))));
    },
  };
}
