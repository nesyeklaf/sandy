import { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown, useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import type { SkillFile, SkillRow } from "./contract";
import {
  DESCRIPTION_MAX,
  IO_KINDS,
  applyDraft,
  emptyIoRow,
  ioRowProblems,
  isDraftChanged,
  parseSkillFile,
  type IoKey,
  type IoKind,
  type IoRow,
  type MetadataEntry,
  type SkillDraft,
} from "./skill-file";
import { confirmLeaveSkill, setUnsavedSkill, skillSubPath } from "./skill-route";
import { GHOST, INPUT, PANEL_PATH, PRIMARY, ProjectSelect, SECONDARY, errorText, useSkillUseCases, type SkillUseCasesApi } from "./shared";

const FIELD = INPUT + " w-full";
const AREA = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";
const LABEL = "block text-xs text-muted-foreground";

type Loaded = { file: SkillFile; draft: SkillDraft; warnings: string[] } | { file: SkillFile; error: string };
type Conflict = { currentRevision: string | null };

function useSkillNavigation() {
  const navigate = useSandyNavigate();
  return useCallback(
    (name: string | null) => {
      if (!confirmLeaveSkill()) return;
      navigate.toPluginPanel(PANEL_PATH, { subPath: skillSubPath(name) });
    },
    [navigate],
  );
}

function IoRows({ title, rows, disabled, onChange }: { title: string; rows: IoRow[]; disabled: boolean; onChange: (rows: IoRow[]) => void }) {
  const problems = ioRowProblems(rows);
  const update = (index: number, patch: Partial<IoRow>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{title}</legend>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">None declared.</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input aria-label={title + " name"} placeholder="Name" className={INPUT + " w-40"} value={row.name} onChange={(event) => update(index, { name: event.target.value })} />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={row.optional} onChange={(event) => update(index, { optional: event.target.checked })} />
            optional
          </label>
          <select aria-label={title + " type"} className={INPUT} value={row.kind} onChange={(event) => update(index, { kind: event.target.value as IoKind })}>
            {IO_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          {row.kind === "file" ? (
            <input aria-label={title + " file path"} placeholder="path, e.g. plan.md (optional)" className={INPUT + " min-w-40 flex-1"} value={row.path} onChange={(event) => update(index, { path: event.target.value })} />
          ) : null}
          {row.kind === "choice" ? (
            <input aria-label={title + " choice values"} placeholder="a, b" className={INPUT + " min-w-40 flex-1"} value={row.values} onChange={(event) => update(index, { values: event.target.value })} />
          ) : null}
          <button type="button" className={GHOST} onClick={() => onChange(rows.filter((_, at) => at !== index))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className={GHOST} onClick={() => onChange([...rows, emptyIoRow()])}>
        + Add {title.toLowerCase().replace(/s$/u, "")}
      </button>
      {problems.length === 0 ? null : (
        <ul className="space-y-0.5 text-xs text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function MetadataRows({ entries, kept, disabled, onChange }: { entries: MetadataEntry[]; kept: string[]; disabled: boolean; onChange: (entries: MetadataEntry[]) => void }) {
  const update = (index: number, patch: Partial<MetadataEntry>) => onChange(entries.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
  const keys = entries.map((entry) => entry.key.trim()).filter((key) => key !== "");
  const reserved = keys.filter((key) => key === "inputs" || key === "outputs" || kept.includes(key));
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">Other metadata</legend>
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          <input aria-label="Metadata key" placeholder="key" className={INPUT + " w-40"} value={entry.key} onChange={(event) => update(index, { key: event.target.value })} />
          <input aria-label="Metadata value" placeholder="value" className={INPUT + " min-w-0 flex-1"} value={entry.value} onChange={(event) => update(index, { value: event.target.value })} />
          <button type="button" className={GHOST} onClick={() => onChange(entries.filter((_, at) => at !== index))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className={GHOST} onClick={() => onChange([...entries, { key: "", value: "" }])}>
        + Add key
      </button>
      {kept.length === 0 ? null : <p className="text-xs text-muted-foreground">Kept as written: {kept.join(", ")}</p>}
      {reserved.length === 0 ? null : <p className="text-xs text-destructive">These keys are edited elsewhere and are ignored here: {[...new Set(reserved)].join(", ")}</p>}
      {repeated.length === 0 ? null : <p className="text-xs text-destructive">Repeated keys, the last one wins: {[...new Set(repeated)].join(", ")}</p>}
    </fieldset>
  );
}

export function draftProblems(draft: SkillDraft): string[] {
  const problems: string[] = [];
  if (draft.description.trim() === "") problems.push("The description is empty.");
  for (const key of ["inputs", "outputs"] as const) {
    for (const problem of ioRowProblems(draft[key])) problems.push(key + ": " + problem);
  }
  return problems;
}

function SkillEditor({ api, skill }: { api: SkillUseCasesApi; skill: SkillRow }) {
  const projectId = api.state?.projectId ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    if (projectId === null) return;
    setLoadError(null);
    api.rpc.call("readSkill", { projectId, skillId: skill.id }).then(
      (file) => {
        const parsed = parseSkillFile(file.content);
        setLoaded(parsed.ok ? { file, draft: parsed.draft, warnings: parsed.warnings } : { file, error: parsed.error });
        setConflict(null);
        setSaveError(null);
      },
      (cause: unknown) => setLoadError(errorText(cause)),
    );
  }, [api.rpc, projectId, skill.id]);
  useEffect(load, [load]);

  const draft = loaded !== null && "draft" in loaded ? loaded.draft : null;
  const dirty = useMemo(() => (loaded !== null && draft !== null ? isDraftChanged(loaded.file.content, draft) : false), [loaded, draft]);
  useEffect(() => {
    setUnsavedSkill(dirty ? skill.name : null);
  }, [dirty, skill.name]);
  useEffect(() => () => setUnsavedSkill(null), []);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  if (loadError !== null) return <p role="alert" className="p-4 text-sm text-destructive">{loadError}</p>;
  if (loaded === null || projectId === null) return <p className="p-4 text-sm text-muted-foreground">Loading {skill.name}…</p>;
  if (!("draft" in loaded) || draft === null)
    return (
      <div className="space-y-2 p-4 text-sm">
        <p role="alert" className="text-destructive">{"error" in loaded ? loaded.error : "The skill file cannot be read."}</p>
        <p className="text-xs text-muted-foreground">{loaded.file.filePath}</p>
      </div>
    );

  const writable = loaded.file.writable;
  const problems = draftProblems(draft);
  const edit = (patch: Partial<SkillDraft>) => {
    setNotice(null);
    setLoaded({ ...loaded, draft: { ...draft, ...patch } });
  };
  const save = (revision: string) => {
    const content = applyDraft(loaded.file.content, draft);
    setSaving(true);
    setSaveError(null);
    api.rpc.call("writeSkill", { projectId, skillId: skill.id, content, revision }).then(
      (result) => {
        setSaving(false);
        if (result.outcome === "conflict") {
          setConflict({ currentRevision: result.currentRevision });
          return;
        }
        const parsed = parseSkillFile(content);
        const file = { ...loaded.file, content, revision: result.revision, filePath: result.filePath };
        setLoaded(parsed.ok ? { file, draft: parsed.draft, warnings: parsed.warnings } : { file, error: parsed.error });
        setConflict(null);
        setNotice("Saved to " + result.filePath);
      },
      (cause: unknown) => {
        setSaving(false);
        setSaveError(errorText(cause));
      },
    );
  };
  const revert = () => {
    const parsed = parseSkillFile(loaded.file.content);
    if (parsed.ok) setLoaded({ file: loaded.file, draft: parsed.draft, warnings: parsed.warnings });
  };
  const length = draft.description.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{draft.name || skill.name}</h2>
          <p className="truncate text-xs text-muted-foreground" title={loaded.file.filePath}>
            {loaded.file.filePath}
          </p>
        </div>
        {writable ? null : <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Read-only</span>}
        <button type="button" className={SECONDARY} disabled={!dirty || saving} onClick={revert}>
          Revert
        </button>
        <button type="button" className={PRIMARY} disabled={!writable || !dirty || saving || problems.length > 0} onClick={() => save(loaded.file.revision)}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {writable ? null : <p className="text-sm text-muted-foreground">This skill ships with sandy or a plugin, so it cannot be edited here.</p>}
        {conflict === null ? null : (
          <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm">
            <p>{conflict.currentRevision === null ? "The file was removed after you opened it." : "The file changed on disk after you opened it."}</p>
            <div className="flex gap-2">
              <button type="button" className={SECONDARY} onClick={load}>
                Reload and discard my changes
              </button>
              {conflict.currentRevision === null ? null : (
                <button type="button" className={PRIMARY} disabled={saving} onClick={() => conflict.currentRevision !== null && save(conflict.currentRevision)}>
                  Overwrite with my version
                </button>
              )}
            </div>
          </div>
        )}
        {saveError === null ? null : <p role="alert" className="text-sm text-destructive">{saveError}</p>}
        {notice === null ? null : <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {loaded.warnings.length === 0 ? null : (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {loaded.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <label className="block space-y-1">
          <span className={LABEL}>Description</span>
          <textarea className={AREA} rows={3} disabled={!writable} value={draft.description} onChange={(event) => edit({ description: event.target.value })} />
          <span className={"block text-right text-xs tabular-nums " + (length > DESCRIPTION_MAX || length === 0 ? "text-destructive" : "text-muted-foreground")}>
            {length} / {DESCRIPTION_MAX}
          </span>
        </label>
        {(["inputs", "outputs"] as const).map((key: IoKey) => (
          <IoRows key={key} title={key === "inputs" ? "Inputs" : "Outputs"} rows={draft[key]} disabled={!writable} onChange={(rows) => edit({ [key]: rows })} />
        ))}
        <MetadataRows entries={draft.metadata} kept={draft.keptMetadataKeys} disabled={!writable} onChange={(metadata) => edit({ metadata })} />
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm font-medium">Body</span>
            <button type="button" className={GHOST} aria-pressed={preview} onClick={() => setPreview(!preview)}>
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div className="rounded-md border border-border p-3">
              <Markdown content={draft.body} />
            </div>
          ) : (
            <textarea aria-label="Body" className={AREA + " font-mono"} rows={24} disabled={!writable} value={draft.body} onChange={(event) => edit({ body: event.target.value })} />
          )}
        </div>
      </div>
    </div>
  );
}

export function SkillsPage({ skillName }: { skillName: string | null }) {
  const api = useSkillUseCases();
  const open = useSkillNavigation();
  const [query, setQuery] = useState("");
  const { state, error } = api;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (state?.skills ?? []).filter(
      (skill) => needle === "" || skill.name.toLowerCase().includes(needle) || (skill.description ?? "").toLowerCase().includes(needle),
    );
  }, [state, query]);
  if (state === null) {
    return error === null ? (
      <p className="p-4 text-sm text-muted-foreground">Loading…</p>
    ) : (
      <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
    );
  }
  const selected = skillName === null ? undefined : state.skills.find((skill) => skill.name === skillName);
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-3">
          <ProjectSelect state={state} onChange={(id) => confirmLeaveSkill() && api.setProjectId(id)} />
          <input type="search" aria-label="Search skills" placeholder="Search skills" className={FIELD} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {visible.map((skill) => (
            <li key={skill.id}>
              <button
                type="button"
                aria-current={skill.name === skillName ? "page" : undefined}
                className={"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent " + (skill.name === skillName ? "bg-accent font-medium" : "")}
                onClick={() => open(skill.name)}
              >
                <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                {skill.writable ? null : <span className="text-xs text-muted-foreground">read-only</span>}
              </button>
            </li>
          ))}
          {visible.length === 0 ? <li className="p-2 text-xs text-muted-foreground">No skills match.</li> : null}
        </ul>
      </aside>
      <section className="min-w-0 flex-1">
        {error === null ? null : <p role="alert" className="px-4 pt-3 text-sm text-destructive">{error}</p>}
        {selected === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">{skillName === null ? "Pick a skill to edit its description, inputs, outputs and body." : "No skill named " + skillName + " in this project."}</p>
        ) : (
          <SkillEditor key={selected.id} api={api} skill={selected} />
        )}
      </section>
    </div>
  );
}
