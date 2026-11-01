import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import type { WorkerAdmitResult, WorkerAttachResult, WorkerReleaseResult } from "../../delegate/server/workers.ts";
import type { WorkersLink } from "../../workers-link.ts";

/**
 * Worker slots from the delegate part of sandy/work. Before a worker spawn or a kept-session continuation,
 * the service asks the delegate ledger for a slot of the origin's root (admit), reports the spawned thread
 * (attach) and frees the slot when the call settles (release); attach and release present the lease admit
 * granted. The calls go through the in-process link (sandy/work/workers-link.ts). Admission is skipped (and
 * logged) only when the delegate part is not linked; a failing admit is retried with backoff, then fails
 * the call.
 */

/** Poll delays while the root is full or the kept worker runs another call; the last one repeats. */
export const ADMISSION_POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000];
/** Retry delays after a failed admit; the call fails once they run out. */
export const ADMISSION_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000];

export interface WorkerAdmissionRequest {
  originThreadId: string;
  runId: string;
  callId: string;
  /** Provider retry attempt of the call: each attempt is its own spawn. */
  attempt: number;
  /** The kept thread a continuation runs on. */
  threadId?: string;
}

/** A slot delegate granted: attach and release present its lease. */
export interface WorkerSlot {
  reservationId: string;
  lease: string;
}

export interface WorkerAdmission {
  /**
   * Waits for a slot of the origin's root; cancellable with the signal. Returns the slot, or null when
   * the delegate part is not linked. Throws when delegate refuses the worker outright (not a full root or
   * a busy worker) or keeps failing.
   */
  admit(request: WorkerAdmissionRequest, signal: AbortSignal): Promise<WorkerSlot | null>;
  /** Reports the spawned thread. False when delegate no longer holds the reservation for it. */
  attach(slot: WorkerSlot, threadId: string): Promise<boolean>;
  release(slot: WorkerSlot): Promise<void>;
}

export class WorkerAdmissionRefused extends Error {}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createWorkerAdmission(
  sandy: SandyPluginApi,
  workers: Pick<WorkersLink, "delegate">,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
): WorkerAdmission {
  const failed = (what: string, error: unknown) => sandy.log.warn(`Worker ${what}: delegate failed: ${describe(error)}`);
  const admission: WorkerAdmission = {
    async admit(request, signal) {
      const delegate = workers.delegate;
      if (delegate === null) {
        sandy.log.warn(`Worker admission skipped (run ${request.runId} call ${request.callId}): the delegate part is not loaded`);
        return null;
      }
      let failures = 0;
      for (let polls = 0; ; ) {
        // sleep resolves early on abort: the wait ends with the run.
        if (signal.aborted) throw new Error("Workflow cancelled");
        let result: WorkerAdmitResult;
        try {
          // The admit is not cancelled with the run: delegate may already have granted the slot, so the
          // answer is awaited in the background and a slot granted after the run ended is released.
          result = await untilAborted(delegate.admit({ ...request }), signal, (late) => {
            if (late.ok) void admission.release({ reservationId: late.reservationId, lease: late.lease });
          });
        } catch (error) {
          if (signal.aborted) throw error;
          const delay = ADMISSION_RETRY_DELAYS_MS[failures];
          failures += 1;
          if (delay === undefined) {
            throw new Error(`Worker admission failed after ${failures} attempts: ${describe(error)}`);
          }
          failed(`admission (run ${request.runId} call ${request.callId}, retry in ${delay} ms)`, error);
          await sleep(delay, signal);
          continue;
        }
        failures = 0;
        if (result.ok) return { reservationId: result.reservationId, lease: result.lease };
        if (result.code !== "limit_reached" && result.code !== "worker_busy") {
          throw new WorkerAdmissionRefused(`Worker refused by delegate (${result.code}): ${result.message}`);
        }
        if (polls === 0) {
          sandy.log.info(`[${request.runId}] Waiting for a worker slot: ${result.message}`);
        }
        await sleep(ADMISSION_POLL_DELAYS_MS[Math.min(polls, ADMISSION_POLL_DELAYS_MS.length - 1)]!, signal);
        polls += 1;
      }
    },
    async attach(slot, threadId) {
      if (workers.delegate === null) return true;
      let result: WorkerAttachResult;
      try {
        result = await workers.delegate.attach({ reservationId: slot.reservationId, lease: slot.lease, threadId });
      } catch (error) {
        // delegate's reconcile pass attaches it from the worker's pluginMetadata.
        failed(`attach ${threadId}`, error);
        return true;
      }
      if (!result.ok) sandy.log.warn(`Worker ${threadId} not attached to ${slot.reservationId}: ${result.message}`);
      return result.ok;
    },
    async release(slot) {
      if (workers.delegate === null) return;
      let result: WorkerReleaseResult;
      try {
        result = await workers.delegate.release({ reservationId: slot.reservationId, lease: slot.lease });
      } catch (error) {
        // delegate's sweep frees the slot once SANDY shows the worker idle.
        failed(`release ${slot.reservationId}`, error);
        return;
      }
      if (!result.ok) sandy.log.warn(`Worker slot ${slot.reservationId} not released: ${result.message}`);
    },
  };
  return admission;
}

/**
 * The answer, or a "Workflow cancelled" rejection as soon as the signal aborts; an answer that arrives
 * after the abort goes to onLateAnswer (a failed one is dropped).
 */
function untilAborted<T>(answer: Promise<T>, signal: AbortSignal, onLateAnswer: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new Error("Workflow cancelled"));
      answer.then(onLateAnswer, () => undefined);
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    answer.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) reject(error);
      },
    );
  });
}
