import { useCallback, useEffect, useRef, useState } from "react";
import { newFileProblem } from "./skill-file";
import { GHOST, INPUT, PRIMARY, SECONDARY, errorText, type SkillUseCasesApi } from "./shared";

type Open = { path: string; base: string; revision: string | null; filePath: string; writable: boolean; text: string };

export function SkillFiles({ api, projectId, skillId, writable }: { api: SkillUseCasesApi; projectId: string; skillId: string; writable: boolean }) {
  const [files, setFiles] = useState<{ files: string[]; truncated: boolean } | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ currentRevision: string | null } | null>(null);
  const [newPath, setNewPath] = useState("");
  const request = useRef(0);

  const list = useCallback(() => {
    api.rpc.call("listSkillFiles", { projectId, skillId }).then(setFiles, (cause: unknown) => setError(errorText(cause)));
  }, [api.rpc, projectId, skillId]);
  useEffect(list, [list]);

  const keepChanges = () => open !== null && open.text !== open.base && !window.confirm("Discard your changes to " + open.path + "?");

  const read = (path: string, discard = false) => {
    if (!discard && keepChanges()) return;
    const ticket = ++request.current;
    setError(null);
    setConflict(null);
    api.rpc.call("readSkill", { projectId, skillId, path }).then(
      (file) => ticket === request.current && setOpen({ path, base: file.content, revision: file.revision, filePath: file.filePath, writable: file.writable, text: file.content }),
      (cause: unknown) => ticket === request.current && setError(errorText(cause)),
    );
  };

  const startNew = () => {
    if (keepChanges()) return;
    const path = newPath.trim();
    request.current += 1;
    setError(null);
    setConflict(null);
    setOpen({ path, base: "", revision: null, filePath: path, writable: true, text: "" });
    setNewPath("");
  };

  const save = (revision: string | null) => {
    if (open === null) return;
    const sent = open;
    setSaving(true);
    setError(null);
    api.rpc.call("writeSkill", { projectId, skillId, path: sent.path, content: sent.text, revision }).then(
      (result) => {
        setSaving(false);
        if (result.outcome === "conflict") {
          setConflict({ currentRevision: result.currentRevision });
          return;
        }
        setConflict(null);
        setOpen((latest) => (latest?.path === sent.path ? { ...latest, base: sent.text, revision: result.revision, filePath: result.filePath } : latest));
        if (sent.revision === null) list();
      },
      (cause: unknown) => {
        setSaving(false);
        setError(errorText(cause));
      },
    );
  };

  if (files === null) return error === null ? <p className="text-sm text-muted-foreground">Loading files…</p> : <p role="alert" className="text-sm text-destructive">{error}</p>;
  const others = files.files.filter((path) => path !== "SKILL.md");
  const dirty = open !== null && open.text !== open.base;
  const pathProblem = newFileProblem(newPath, files.files);
  const created = open !== null && open.revision === null;
  return (
    <div className="space-y-3">
      <ul aria-label="Skill files" className="space-y-0.5">
        <li className="px-2 py-1 font-mono text-xs text-muted-foreground">SKILL.md (Source tab)</li>
        {others.map((path) => (
          <li key={path}>
            <button type="button" aria-current={open?.path === path ? "true" : undefined} className={"w-full rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent " + (open?.path === path ? "bg-accent" : "")} onClick={() => read(path)}>
              {path}
            </button>
          </li>
        ))}
        {others.length === 0 ? <li className="px-2 py-1 text-xs text-muted-foreground">No other files in this skill folder.</li> : null}
        {files.truncated ? <li className="px-2 py-1 text-xs text-muted-foreground">The list is cut short; the folder has more files.</li> : null}
      </ul>
      {writable ? (
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (newPath.trim() !== "" && pathProblem === null) startNew();
          }}
        >
          <div className="flex gap-2">
            <input aria-label="New file path" placeholder="references/notes.md" className={INPUT + " min-w-0 flex-1 font-mono text-xs"} value={newPath} onChange={(event) => setNewPath(event.target.value)} />
            <button type="submit" className={SECONDARY} disabled={newPath.trim() === "" || pathProblem !== null}>
              Add file
            </button>
          </div>
          {pathProblem === null ? null : <p className="text-xs text-destructive">{pathProblem}</p>}
        </form>
      ) : null}
      {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
      {open === null ? null : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={open.filePath}>
              {open.path}
              {created ? <span className="text-muted-foreground"> · new</span> : null}
            </span>
            <button type="button" className={GHOST} disabled={saving || (!dirty && !created)} onClick={() => (created ? setOpen(null) : setOpen({ ...open, text: open.base }))}>
              {created ? "Cancel" : "Revert"}
            </button>
            <button type="button" className={PRIMARY} disabled={!dirty || saving || !open.writable} onClick={() => save(open.revision)}>
              {saving ? "Saving…" : created ? "Create file" : "Save file"}
            </button>
          </div>
          {conflict === null ? null : (
            <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm">
              <p>{created ? "A file with this path appeared on disk." : conflict.currentRevision === null ? "The file was removed after you opened it." : "The file changed on disk after you opened it."}</p>
              <div className="flex gap-2">
                <button type="button" className={SECONDARY} onClick={() => read(open.path, true)}>
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
          <textarea aria-label={"Content of " + open.path} className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs" rows={20} disabled={!open.writable} value={open.text} onChange={(event) => setOpen({ ...open, text: event.target.value })} />
        </div>
      )}
    </div>
  );
}
