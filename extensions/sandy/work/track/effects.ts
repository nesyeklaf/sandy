// Track drivers v2: the effect executor (design: docs/design-v2.md §5). Its in-memory map is a cache of desired(run),
// never an owner: results come back only as SystemCommands through operations.dispatch.
import { TAIL_CHARS, type Effect, type Reply, type SystemCommand } from "./run.ts";

const DETAIL_CHARS = 500;

/** The end of a check's output for its detail, starting at a line boundary so it does not begin mid-word; kept as cut when the slice has no line break. */
function detailTail(tail: string): string {
  if (tail.length <= DETAIL_CHARS) return tail;
  const slice = tail.slice(-DETAIL_CHARS);
  if (tail[tail.length - DETAIL_CHARS - 1] === "\n") return slice;
  const newline = slice.indexOf("\n");
  return newline < 0 || newline === slice.length - 1 ? slice : slice.slice(newline + 1);
}

export type EffectPorts = {
  /** host.ts runCheck on the thread's host; tail is the end of the output. */
  runCheck(threadId: string, input: { command: string; timeoutSec: number }, signal: AbortSignal): Promise<{ exitCode: number; durationMs: number; tail: string }>;
  /** sandy.ui.requestInput; null = cancelled or timed out (a rejection). */
  requestInput(threadId: string, form: { rendererId: string; title: string; payload: unknown }, signal: AbortSignal): Promise<{ approved: boolean; note?: string } | null>;
  /** sandy.sdk.threads.send; SANDY queues it while the thread is busy. */
  send(threadId: string, text: string): Promise<void>;
  /** Writes the guard policy of the committed run if it is still at rev; the host refuses a rev older than the file's. */
  writePolicy(threadId: string, rev: number): Promise<void>;
  warn(message: string): void;
};

export type Executor = {
  /** This process's boot id: stamped on every check/run it starts (workStarted) and used by recover. */
  readonly boot: string;
  /**
   * Diff desired against in flight by effect key: start what is missing, abort what is no longer desired.
   * check/run: dispatch workStarted first and start the job only if that reply shows this boot owns it.
   * tell/launch: send, then dispatch woke (at-least-once). A failed port call is logged and forgotten; the next
   * reconcile starts it again. A started check/run always settles (a port failure is its result).
   */
  reconcile(threadId: string, effects: Effect[]): void;
  /** Aborts everything in flight (plugin dispose). */
  dispose(): void;
};

type Dispatch = (threadId: string, command: SystemCommand) => Promise<Reply>;

/** The sandy host's rejection of a call whose plugin worker exited (sandy host contract: no typed error). */
const HOST_WORKER_GONE = /\bplugin worker exited\b/i;

export function createExecutor(ports: EffectPorts, dispatch: Dispatch, boot: string): Executor {
  const inFlight = new Map<string, Map<string, AbortController>>();

  function start(threadId: string, effect: Effect) {
    const running = inFlight.get(threadId) ?? new Map<string, AbortController>();
    inFlight.set(threadId, running);
    const controller = new AbortController();
    running.set(effect.key, controller);
    const signal = controller.signal;
    const report = async (command: SystemCommand) => {
      if (!signal.aborted) await dispatch(threadId, command);
    };
    perform(effect, threadId, signal, report)
      .catch((error) => ports.warn(`${threadId}: ${effect.key} failed: ${message(error)}`))
      .finally(() => {
        if (running.get(effect.key) === controller) running.delete(effect.key);
        if (running.size === 0 && inFlight.get(threadId) === running) inFlight.delete(threadId);
      });
  }

  async function perform(effect: Effect, threadId: string, signal: AbortSignal, report: (command: SystemCommand) => Promise<void>) {
    switch (effect.kind) {
      case "publish":
        await ports.writePolicy(threadId, effect.rev);
        return report({ by: "system", op: "published", rev: effect.rev });
      case "tell":
        await ports.send(threadId, effect.text);
        return report({ by: "system", op: "woke", runId: effect.runId, ticket: effect.ticket, kind: "told", attempt: 1 });
      case "launch":
        await ports.send(threadId, effect.text);
        return report({ by: "system", op: "woke", runId: effect.runId, ticket: effect.ticket, kind: "launched", attempt: effect.attempt });
      case "tellOutcome":
        await ports.send(threadId, effect.text);
        return report({ by: "system", op: "outcomeTold", ticket: effect.ticket, workId: effect.workId });
      case "tellPending":
        await ports.send(threadId, effect.text);
        return report({ by: "system", op: "pendingTold", runId: effect.runId, rev: effect.rev });
      case "ask": {
        const answer = await ports.requestInput(threadId, effect.form, signal);
        const note = answer?.note?.trim();
        return report({ by: "system", op: "answered", runId: effect.runId, ticket: effect.ticket, formId: effect.formId, approved: answer?.approved === true, ...(note ? { note } : {}) });
      }
      case "check":
      case "run": {
        // D3: a job started by another boot is interrupted by recover; one started by this boot is already settling.
        if (effect.startedIn !== null) return;
        const owned = await dispatch(threadId, { by: "system", op: "workStarted", ticket: effect.ticket, workId: effect.workId, boot });
        if (owned.kind !== "ok" || signal.aborted) return;
        // A command whose host worker exited (e.g. on a plugin reload) has no exit code: interrupted, not failed.
        const interrupted = (reason: string) => report({ by: "system", op: "interrupted", ticket: effect.ticket, workId: effect.workId, reason });
        if (effect.kind === "run") {
          const result = await runSettled(threadId, effect.command, effect.timeoutSec, signal);
          if ("couldNotRun" in result) return interrupted(result.couldNotRun);
          return report({ by: "system", op: "ran", ticket: effect.ticket, workId: effect.workId, ...result });
        }
        const results: Record<string, { ok: boolean; detail: string; at: number }> = {};
        for (const check of effect.checks) {
          if (signal.aborted) return;
          const result = await runSettled(threadId, check.command, check.timeoutSec, signal);
          if ("couldNotRun" in result) return interrupted(result.couldNotRun);
          const tail = result.tail.trim();
          const detail = `exit ${result.exitCode} after ${result.durationMs} ms${tail ? `: ${detailTail(tail)}` : ""}`;
          results[check.ruleKey] = { ok: result.exitCode === 0, detail, at: Date.now() };
          if (result.exitCode !== 0) break;
        }
        return report({ by: "system", op: "checked", ticket: effect.ticket, workId: effect.workId, results });
      }
    }
  }

  async function runSettled(threadId: string, command: string, timeoutSec: number, signal: AbortSignal): Promise<{ exitCode: number; durationMs: number; tail: string } | { couldNotRun: string }> {
    try {
      const result = await ports.runCheck(threadId, { command, timeoutSec }, signal);
      return { exitCode: result.exitCode, durationMs: result.durationMs, tail: result.tail.slice(-TAIL_CHARS) };
    } catch (error) {
      const reason = `the command could not run: ${message(error)}`;
      // Only a gone host worker (a plugin reload kills it mid-command; the sandy host rejects with "host plugin worker
      // exited (<code>)") says nothing about the command. Any other error (no workspace path, spawn failure) fails it.
      if (HOST_WORKER_GONE.test(message(error))) return { couldNotRun: reason };
      return { exitCode: -1, durationMs: 0, tail: reason.slice(-TAIL_CHARS) };
    }
  }

  return {
    boot,
    reconcile(threadId, effects) {
      const wanted = new Set(effects.map((e) => e.key));
      const running = inFlight.get(threadId);
      for (const [key, controller] of running ?? []) {
        if (wanted.has(key)) continue;
        controller.abort();
        running!.delete(key);
      }
      for (const effect of effects) if (!inFlight.get(threadId)?.has(effect.key)) start(threadId, effect);
    },
    dispose() {
      for (const running of inFlight.values()) for (const controller of running.values()) controller.abort();
      inFlight.clear();
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
