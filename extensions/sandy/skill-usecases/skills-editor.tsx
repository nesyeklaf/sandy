import { useCallback, useMemo, useState } from "react";
import { useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import { SkillPanel } from "./skill-panel";
import { confirmLeaveSkill, skillSubPath } from "./skill-route";
import { INPUT, PANEL_PATH, ProjectSelect, useSkillUseCases } from "./shared";

const FIELD = INPUT + " w-full";

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
          <p className="p-4 text-sm text-muted-foreground">{skillName === null ? "Pick a skill to edit its overview, stages, files and source." : "No skill named " + skillName + " in this project."}</p>
        ) : (
          state.projectId === null ? null : <SkillPanel key={state.projectId + "\0" + selected.id} api={api} projectId={state.projectId} skillId={selected.id} name={selected.name} />
        )}
      </section>
    </div>
  );
}
