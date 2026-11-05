import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillFile } from "./contract";
import { GHOST, PRIMARY, SECONDARY, errorText, type SkillUseCasesApi } from "./shared";

type Open = { path: string; file: SkillFile; text: string };

export function SkillFiles({ api, projectId, skillId }: { api: SkillUseCasesApi; projectId: string; skillId: string }) {
  const [files, setFiles] = useState<{ files: string[]; truncated: boolean } | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ currentRevision: string | null } | null>(null);
  const request = useRef(0);

  const list = useCallback(() => {
    api.rpc.call("listSkillFiles", { projectId, skillId }).then(setFiles, (cause: unknown) => setError(errorText(cause)));
  }, [api.rpc, projectId, skillId]);
  useEffect(list, [list]);

  const read = (path: string) => {
    if (open !== null && open.text !== open.file.content && !window.confirm("Discard your changes to " + open.path + "?")) return;
    const ticket = ++request.current;
    setError(null);
    setConflict(null);
    api.rpc.call("readSkill", { projectId, skillId, path }).then(
      (file) => ticket === request.current && setOpen({ path, file, text: file.content }),
      (cause: unknown) => ticket === request.current && setError(errorText(cause)),
    );
  };

  const save = (revision: string) => {
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
        setOpen((latest) => (latest?.path === sent.path ? { ...latest, file: { ...latest.file, content: sent.text, revision: result.revision } } : latest));
      },
      (cause: unknown) => {
        setSaving(false);
        setError(errorText(cause));
      },
    );
  };

  if (files === null) return error === null ? <p className="text-sm text-muted-foreground">Loading files…</p> : <p role="alert" className="text-sm text-destructive">{error}</p>;
  const others = files.files.filter((path) => path !== "SKILL.md");
  const dirty = open !== null && open.text !== open.file.content;
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
      {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
      {open === null ? null : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={open.file.filePath}>
              {open.path}
            </span>
            <button type="button" className={GHOST} disabled={!dirty || saving} onClick={() => setOpen({ ...open, text: open.file.content })}>
              Revert
            </button>
            <button type="button" className={PRIMARY} disabled={!dirty || saving || !open.file.writable} onClick={() => save(open.file.revision)}>
              {saving ? "Saving…" : "Save file"}
            </button>
          </div>
          {conflict === null ? null : (
            <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm">
              <p>{conflict.currentRevision === null ? "The file was removed after you opened it." : "The file changed on disk after you opened it."}</p>
              <div className="flex gap-2">
                <button type="button" className={SECONDARY} onClick={() => { setOpen(null); read(open.path); }}>
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
          <textarea aria-label={"Content of " + open.path} className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs" rows={20} disabled={!open.file.writable} value={open.text} onChange={(event) => setOpen({ ...open, text: event.target.value })} />
        </div>
      )}
    </div>
  );
}
