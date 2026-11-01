// Worker slots between the workflows part and the delegate part of sandy/work. Both run in the same plugin
// process, so the workflows service asks the delegate ledger directly instead of through SANDY's plugin rpc.
// Each part fills its side when it registers; a side that stays null means that part is not loaded.
import type { WorkerAdmitInput, WorkerAdmitResult, WorkerAttachResult, WorkerReleaseResult } from "./delegate/server/workers.ts";

export interface DelegateWorkers {
  admit(input: WorkerAdmitInput): Promise<WorkerAdmitResult>;
  attach(input: { reservationId: string; lease: string; threadId: string }): Promise<WorkerAttachResult>;
  release(input: { reservationId: string; lease: string }): Promise<WorkerReleaseResult>;
}

export interface WorkflowWorkers {
  /** Whether the call attempt still runs; the delegate sweep keeps the slot of a worker idling between its own turns. */
  callRunning(call: { runId: string; callId: string; attempt: number }): boolean;
}

export interface WorkersLink {
  delegate: DelegateWorkers | null;
  workflows: WorkflowWorkers | null;
}

export const createWorkersLink = (): WorkersLink => ({ delegate: null, workflows: null });
