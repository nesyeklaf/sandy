import { layout, needsLayout, record, startHistory, type History } from "./canvas-model.ts";
import type { Flow } from "./graph.ts";

export interface FlowSync {
  local: Flow[] | null;
  inFlight: boolean;
  queued: Flow[] | null;
  saves: number;
  fetches: number;
  applied: number;
}

export interface FetchTicket {
  seq: number;
  saves: number;
}

export function startSync(): FlowSync {
  return { local: null, inFlight: false, queued: null, saves: 0, fetches: 0, applied: 0 };
}

export function isSaving(sync: FlowSync): boolean {
  return sync.inFlight || sync.queued !== null;
}

export function edited(sync: FlowSync, flows: Flow[]): { sync: FlowSync; send: Flow[] | null } {
  if (sync.inFlight) return { sync: { ...sync, local: flows, queued: flows }, send: null };
  return { sync: { ...sync, local: flows, inFlight: true, saves: sync.saves + 1 }, send: flows };
}

export function acked(sync: FlowSync): { sync: FlowSync; send: Flow[] | null } {
  if (sync.queued === null) return { sync: { ...sync, inFlight: false }, send: null };
  return { sync: { ...sync, queued: null, inFlight: true, saves: sync.saves + 1 }, send: sync.queued };
}

export function fetchStarted(sync: FlowSync): { sync: FlowSync; ticket: FetchTicket } {
  const seq = sync.fetches + 1;
  return { sync: { ...sync, fetches: seq }, ticket: { seq, saves: sync.saves } };
}

export function fetched(sync: FlowSync, ticket: FetchTicket, server: Flow[]): { sync: FlowSync; flows: Flow[] | null } {
  if (ticket.seq <= sync.applied) return { sync, flows: null };
  const next = { ...sync, applied: ticket.seq };
  const stale = isSaving(sync) || ticket.saves !== sync.saves;
  if (stale && sync.local !== null) return { sync: next, flows: sync.local };
  return { sync: { ...next, local: server }, flows: server };
}

export function sameFlow(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameFlow(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = new Map(Object.entries(b).filter(([, value]) => value !== undefined));
  return left.length === right.size && left.every(([key, value]) => right.has(key) && sameFlow(value, right.get(key)));
}

export function reconcileEditor(history: History, incoming: Flow, saving: boolean): History {
  const laid = needsLayout(incoming) ? layout(incoming) : incoming;
  if (history.present.id !== incoming.id) return startHistory(laid);
  if (saving || sameFlow(incoming, history.present) || sameFlow(laid, history.present)) return history;
  return record(history, laid);
}
