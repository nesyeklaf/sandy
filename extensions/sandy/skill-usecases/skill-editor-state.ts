import type { SkillFile, SkillWrite } from "./contract.ts";
import { applyDraft, ioRowProblems, isDraftChanged, parseSkillFile, type SkillDraft } from "./skill-file.ts";

export type EditorTarget = { projectId: string; skillId: string };

export type Loaded =
  | { file: SkillFile; draft: SkillDraft; warnings: string[]; metadataLock: string | null }
  | { file: SkillFile; error: string };

export type Conflict = { currentRevision: string | null };

export interface EditorState {
  request: number;
  target: EditorTarget | null;
  loaded: Loaded | null;
  loadError: string | null;
  saving: boolean;
  saveError: string | null;
  conflict: Conflict | null;
  notice: string | null;
}

export type ReadTicket = { request: number };

export type SaveTicket = { request: number; submitted: SkillDraft; content: string };

export type SkillWriteRequest = EditorTarget & { content: string; revision: string };

export function startEditor(): EditorState {
  return { request: 0, target: null, loaded: null, loadError: null, saving: false, saveError: null, conflict: null, notice: null };
}

export function loadedFrom(file: SkillFile): Loaded {
  const parsed = parseSkillFile(file.content);
  return parsed.ok ? { file, draft: parsed.draft, warnings: parsed.warnings, metadataLock: parsed.metadataLock } : { file, error: parsed.error };
}

export function draftProblems(base: string, draft: SkillDraft): string[] {
  const problems: string[] = [];
  if (draft.description.trim() === "") problems.push("The description is empty.");
  for (const key of ["inputs", "outputs"] as const) {
    for (const problem of ioRowProblems(draft[key])) problems.push(key + ": " + problem);
  }
  const applied = applyDraft(base, draft);
  if (!applied.ok) problems.push(applied.error);
  return problems;
}

export function readStarted(state: EditorState, target: EditorTarget | null): { state: EditorState; ticket: ReadTicket } {
  const request = state.request + 1;
  return { state: { ...startEditor(), request, target }, ticket: { request } };
}

export function readDone(state: EditorState, ticket: ReadTicket, file: SkillFile): EditorState {
  if (ticket.request !== state.request) return state;
  return { ...state, loaded: loadedFrom(file), loadError: null, conflict: null, saveError: null };
}

export function readFailed(state: EditorState, ticket: ReadTicket, error: string): EditorState {
  if (ticket.request !== state.request) return state;
  return { ...state, loadError: error };
}

export function editedDraft(state: EditorState, patch: Partial<SkillDraft>): EditorState {
  const loaded = state.loaded;
  if (loaded === null || !("draft" in loaded)) return state;
  return { ...state, notice: null, loaded: { ...loaded, draft: { ...loaded.draft, ...patch } } };
}

export function reverted(state: EditorState): EditorState {
  if (state.loaded === null) return state;
  return { ...state, loaded: loadedFrom(state.loaded.file) };
}

export function isDirty(state: EditorState): boolean {
  const loaded = state.loaded;
  return loaded !== null && "draft" in loaded && isDraftChanged(loaded.file.content, loaded.draft);
}

export function canSave(state: EditorState): boolean {
  const loaded = state.loaded;
  if (state.target === null || loaded === null || !("draft" in loaded) || state.saving || !loaded.file.writable) return false;
  return isDirty(state) && draftProblems(loaded.file.content, loaded.draft).length === 0;
}

export function saveStarted(state: EditorState, revision: string): { state: EditorState; send: SkillWriteRequest | null; ticket: SaveTicket | null } {
  const loaded = state.loaded;
  const target = state.target;
  if (target === null || loaded === null || !("draft" in loaded) || state.saving || !loaded.file.writable) return { state, send: null, ticket: null };
  const applied = applyDraft(loaded.file.content, loaded.draft);
  if (!applied.ok) return { state: { ...state, saveError: applied.error }, send: null, ticket: null };
  return {
    state: { ...state, saving: true, saveError: null },
    send: { ...target, content: applied.content, revision },
    ticket: { request: state.request, submitted: loaded.draft, content: applied.content },
  };
}

export function saveDone(state: EditorState, ticket: SaveTicket, result: SkillWrite): EditorState {
  if (ticket.request !== state.request || state.loaded === null) return state;
  if (result.outcome === "conflict") return { ...state, saving: false, conflict: { currentRevision: result.currentRevision } };
  const saved = loadedFrom({ ...state.loaded.file, content: ticket.content, revision: result.revision, filePath: result.filePath });
  const current = state.loaded;
  const loaded = "draft" in saved && "draft" in current && current.draft !== ticket.submitted ? { ...saved, draft: current.draft } : saved;
  return { ...state, saving: false, loaded, conflict: null, notice: "Saved to " + result.filePath };
}

export function saveFailed(state: EditorState, ticket: SaveTicket, error: string): EditorState {
  if (ticket.request !== state.request) return state;
  return { ...state, saving: false, saveError: error };
}
