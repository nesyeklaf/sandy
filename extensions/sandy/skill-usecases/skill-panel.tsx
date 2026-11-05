import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompiledStage } from "@sandy/skill-dialect";
import {
  DESCRIPTION_MAX,
  IO_KINDS,
  emptyIoRow,
  ioRowProblems,
  type IoKey,
  type IoKind,
  type IoRow,
  type MetadataEntry,
  type SkillDraft,
} from "./skill-file";
import {
  canSave,
  draftProblems,
  editedDraft,
  editedSource,
  isDirty,
  loadedContent,
  readDone,
  readFailed,
  readStarted,
  reverted,
  saveDone,
  saveFailed,
  saveStarted,
  startEditor,
  type EditorState,
} from "./skill-editor-state";
import { readStages, replaceStage, setTag, sourceProblems, stageSource, type StageView, type TagValue } from "./skill-stages";
import { SkillFiles } from "./skill-files";
import { setUnsavedSkill } from "./skill-route";
import { GHOST, INPUT, PRIMARY, SECONDARY, errorText, type SkillUseCasesApi } from "./shared";

const AREA = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";
const LABEL = "block text-xs text-muted-foreground";

type PanelTab = "overview" | "stages" | "files" | "source";

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

function Overview({ draft, writable, metadataLock, onEdit }: { draft: SkillDraft; writable: boolean; metadataLock: string | null; onEdit: (patch: Partial<SkillDraft>) => void }) {
  const length = draft.description.length;
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <span className={LABEL}>Name</span>
        <p className="font-mono text-sm">{draft.name}</p>
      </div>
      <label className="block space-y-1">
        <span className={LABEL}>Description</span>
        <textarea className={AREA} rows={3} disabled={!writable} value={draft.description} onChange={(event) => onEdit({ description: event.target.value })} />
        <span className={"block text-right text-xs tabular-nums " + (length > DESCRIPTION_MAX || length === 0 ? "text-destructive" : "text-muted-foreground")}>
          {length} / {DESCRIPTION_MAX}
        </span>
      </label>
      {metadataLock === null ? null : (
        <p role="note" className="text-sm text-muted-foreground">
          {metadataLock}
        </p>
      )}
      {(["inputs", "outputs"] as const).map((key: IoKey) => (
        <IoRows key={key} title={key === "inputs" ? "Inputs" : "Outputs"} rows={draft[key]} disabled={!writable} onChange={(rows) => onEdit({ [key]: rows })} />
      ))}
      <MetadataRows entries={draft.metadata} kept={draft.keptMetadataKeys} disabled={!writable || metadataLock !== null} onChange={(metadata) => onEdit({ metadata })} />
    </div>
  );
}

function gateText(stage: CompiledStage): string {
  if (stage.gate.length === 0) return "none";
  return stage.gate
    .map((rule) => {
      if (rule.type === "user") return "owner approves" + (rule.prompt === undefined ? "" : ": " + rule.prompt);
      if (rule.type === "check") return "command " + rule.command;
      if (rule.type === "evidence") return "evidence " + rule.name;
      if (rule.type === "goal") return "goal" + (rule.label === undefined ? "" : " " + rule.label);
      return "all outputs";
    })
    .join(", ");
}

function allowText(stage: CompiledStage): string {
  const allow = stage.allow;
  if (allow === undefined) return "as the skill allows";
  const parts: string[] = [];
  if (allow.skills !== undefined) parts.push("skills " + allow.skills.join(", "));
  if (allow.edits !== undefined) parts.push(allow.edits ? "edits" : "no edits");
  if (allow.subagents !== undefined) parts.push("subagents " + allow.subagents.map((item) => item.agent ?? item.model ?? "").join(", "));
  if (allow.denyTools !== undefined) parts.push("denied " + allow.denyTools.join(", "));
  return parts.join("; ");
}

function StageCard({ source, stage, writable, onSource }: { source: string; stage: StageView; writable: boolean; onSource: (edit: (source: string) => string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const compiled = stage.compiled;
  const setOutput = (index: number, attrs: Record<string, TagValue>) => {
    const tag = stage.outputs[index];
    if (tag !== undefined) onSource((current) => setTag(current, tag, attrs));
  };
  return (
    <section aria-label={"Stage " + stage.id} className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{stage.title}</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {stage.id} · line {stage.line}
        </span>
      </div>
      {compiled === null ? <p className="text-xs text-destructive">This stage does not compile; see the Source tab.</p> : null}
      {compiled === null ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Gate</dt>
          <dd>{gateText(compiled)}</dd>
          <dt className="text-muted-foreground">Allowed</dt>
          <dd>{allowText(compiled)}</dd>
          <dt className="text-muted-foreground">Branches</dt>
          <dd>
            {compiled.next.length === 0 ? "ends here" : null}
            <ul className="space-y-0.5">
              {compiled.next.map((edge, index) => (
                <li key={index}>
                  <span className="font-mono">{edge.to}</span>
                  {edge.when === undefined ? null : <span className="text-muted-foreground"> when {edge.when}</span>}
                  {edge.max === undefined ? null : <span className="text-muted-foreground"> at most {edge.max}×</span>}
                </li>
              ))}
            </ul>
          </dd>
        </dl>
      )}
      {stage.outputs.length === 0 ? null : (
        <fieldset className="space-y-1" disabled={!writable}>
          <legend className="text-xs text-muted-foreground">Outputs</legend>
          {stage.outputs.map((output, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate font-mono text-xs">{String(output.attrs.name ?? "")}</span>
              <input
                aria-label={"Description of " + String(output.attrs.name ?? "")}
                placeholder="description"
                className={INPUT + " min-w-0 flex-1"}
                value={typeof output.attrs.description === "string" ? output.attrs.description : ""}
                onChange={(event) => {
                  const { description: _old, ...rest } = output.attrs;
                  setOutput(index, event.target.value === "" ? rest : { ...rest, description: event.target.value });
                }}
              />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={output.attrs.optional === true}
                  onChange={(event) => {
                    const { optional: _old, ...rest } = output.attrs;
                    setOutput(index, event.target.checked ? { ...rest, optional: true } : rest);
                  }}
                />
                optional
              </label>
            </div>
          ))}
        </fieldset>
      )}
      {text === null ? (
        <button type="button" className={GHOST} disabled={!writable} onClick={() => setText(stageSource(source, stage))}>
          Edit stage text
        </button>
      ) : (
        <div className="space-y-1">
          <textarea aria-label={"Source of stage " + stage.id} className={AREA + " font-mono text-xs"} rows={12} value={text} onChange={(event) => setText(event.target.value)} />
          <div className="flex gap-2">
            <button
              type="button"
              className={PRIMARY}
              onClick={() => {
                onSource((current) => replaceStage(current, stage, text.endsWith("\n") || stage.end === current.length ? text : text + "\n"));
                setText(null);
              }}
            >
              Apply
            </button>
            <button type="button" className={SECONDARY} onClick={() => setText(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Stages({ source, writable, onSource }: { source: string; writable: boolean; onSource: (edit: (source: string) => string) => void }) {
  const read = useMemo(() => readStages(source), [source]);
  if (!read.ok) return <p role="alert" className="text-sm text-destructive">{read.error}</p>;
  if (read.stages.length === 0) return <p className="text-sm text-muted-foreground">This skill has no stages. Add them in the Source tab with {"{% stage %}"} tags.</p>;
  return (
    <div className="space-y-3">
      {read.stages.map((stage, index) => (
        <StageCard key={String(index) + stage.id} source={source} stage={stage} writable={writable} onSource={onSource} />
      ))}
    </div>
  );
}

function Source({ source, writable, onSource }: { source: string; writable: boolean; onSource: (edit: (source: string) => string) => void }) {
  const problems = useMemo(() => sourceProblems(source), [source]);
  return (
    <div className="space-y-2">
      <textarea aria-label="SKILL.md source" className={AREA + " font-mono text-xs"} rows={28} disabled={!writable} value={source} onChange={(event) => onSource(() => event.target.value)} />
      {problems.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          The dialect parser finds no problems.
        </p>
      ) : (
        <ul aria-label="Parser problems" className="space-y-1 text-xs">
          {problems.map((problem, index) => (
            <li key={index}>
              <span className="text-destructive">
                line {problem.line}, {problem.tag}: {problem.message}
              </span>
              <span className="text-muted-foreground"> · {problem.fix}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SkillPanel({ api, projectId, skillId, name }: { api: SkillUseCasesApi; projectId: string; skillId: string; name: string }) {
  const [state, setState] = useState<EditorState>(startEditor);
  const current = useRef(state);
  current.current = state;
  const [tab, setTab] = useState<PanelTab>("overview");

  const load = useCallback(() => {
    const read = readStarted(current.current, { projectId, skillId });
    current.current = read.state;
    setState(read.state);
    api.rpc.call("readSkill", { projectId, skillId, path: "SKILL.md" }).then(
      (file) => setState((latest) => readDone(latest, read.ticket, file)),
      (cause: unknown) => setState((latest) => readFailed(latest, read.ticket, errorText(cause))),
    );
  }, [api.rpc, projectId, skillId]);
  useEffect(load, [load]);

  const { loaded, loadError, saveError, conflict, saving, notice } = state;
  const dirty = useMemo(() => isDirty(state), [state]);
  useEffect(() => {
    setUnsavedSkill(dirty ? name : null);
  }, [dirty, name]);
  useEffect(() => () => setUnsavedSkill(null), []);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  if (loadError !== null) return <p role="alert" className="p-4 text-sm text-destructive">{loadError}</p>;
  if (loaded === null) return <p className="p-4 text-sm text-muted-foreground">Loading {name}…</p>;

  const writable = loaded.file.writable;
  const content = loadedContent(loaded);
  const source = content.ok ? content.content : loaded.working;
  const problems = loaded.draft === null ? [] : draftProblems(loaded.working, loaded.draft);
  const edit = (patch: Partial<SkillDraft>) => setState((latest) => editedDraft(latest, patch));
  const editSource = (change: (source: string) => string) => setState((latest) => editedSource(latest, change));
  const save = (revision: string) => {
    const step = saveStarted(current.current, revision);
    current.current = step.state;
    setState(step.state);
    const { send, ticket } = step;
    if (send === null || ticket === null) return;
    api.rpc.call("writeSkill", send).then(
      (result) => setState((latest) => saveDone(latest, ticket, result)),
      (cause: unknown) => setState((latest) => saveFailed(latest, ticket, errorText(cause))),
    );
  };
  const tabButton = (id: PanelTab, label: string) => (
    <button type="button" role="tab" aria-selected={tab === id} className={"h-8 flex-1 border-b-2 text-sm " + (tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{loaded.draft?.name || name}</h2>
          <p className="truncate text-xs text-muted-foreground" title={loaded.file.filePath}>
            {loaded.file.filePath}
          </p>
        </div>
        {writable ? null : <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Read-only</span>}
        <button type="button" className={SECONDARY} disabled={!dirty || saving} onClick={() => setState((latest) => reverted(latest))}>
          Revert
        </button>
        <button type="button" className={PRIMARY} disabled={!canSave(state)} onClick={() => save(loaded.file.revision)}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="space-y-2 px-4 pt-3 empty:hidden">
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
        {loaded.error === null ? null : <p role="alert" className="text-sm text-destructive">{loaded.error}</p>}
        {problems.length === 0 ? null : (
          <ul role="alert" className="space-y-0.5 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
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
      </div>
      <div role="tablist" aria-label="Skill parts" className="flex border-b border-border px-2">
        {tabButton("overview", "Overview")}
        {tabButton("stages", "Stages")}
        {tabButton("files", "Files")}
        {tabButton("source", "Source")}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === "overview" ? (
          loaded.draft === null ? (
            <p className="text-sm text-muted-foreground">Fix the frontmatter in the Source tab to edit the overview.</p>
          ) : (
            <Overview draft={loaded.draft} writable={writable} metadataLock={loaded.metadataLock} onEdit={edit} />
          )
        ) : null}
        {tab === "stages" ? <Stages source={source} writable={writable} onSource={editSource} /> : null}
        {tab === "files" ? <SkillFiles api={api} projectId={projectId} skillId={skillId} writable={writable} /> : null}
        {tab === "source" ? <Source source={source} writable={writable} onSource={editSource} /> : null}
      </div>
    </div>
  );
}
