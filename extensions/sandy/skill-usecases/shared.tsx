import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { SkillUseCaseState, rpcContract } from "./contract";
import type { Flow } from "./graph";

export const PANEL_PATH = "skills-by-use-case";
export const INPUT = "h-8 rounded-md border border-border bg-background px-2 text-sm";
export const GHOST = "rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";
export const PRIMARY = "h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50";
export const SECONDARY = "h-8 rounded-md border border-border px-3 text-sm hover:bg-accent disabled:opacity-50";

const PROJECT_STORAGE_KEY = "skill-usecases:project";

export type UseCase = SkillUseCaseState["useCases"][number];
export type Option = { id: string; label: string };

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function slug(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "area";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = base + "-" + n;
  return id;
}

export function colorOf(index: number): string {
  return "hsl(" + ((index * 47 + 210) % 360) + " 60% 55%)";
}

export function skillPrompt(skillName: string): string {
  return "/" + skillName + " ";
}

export function readStoredProject(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function useSkillUseCases() {
  const rpc = useRpc<typeof rpcContract>();
  const [projectId, setProjectIdState] = useState<string | null>(readStoredProject);
  const [state, setState] = useState<SkillUseCaseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("state", { projectId }).then(
      (next) => {
        setState(next);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc, projectId]);
  useEffect(refetch, [refetch]);
  useRealtime("changed", refetch);
  const setProjectId = useCallback((id: string) => {
    setProjectIdState(id);
    try {
      window.localStorage.setItem(PROJECT_STORAGE_KEY, id);
    } catch {
      return;
    }
  }, []);
  const run = useCallback(
    (call: Promise<{ ok: boolean }>) => {
      call.then(
        (result) => {
          if (!result.ok) setError("That change was rejected.");
          refetch();
        },
        (cause: unknown) => {
          setError(errorText(cause));
          refetch();
        },
      );
    },
    [refetch],
  );
  const moveLocally = useCallback((skillName: string, useCaseId: string) => {
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            skills: current.skills.map((skill) =>
              skill.name === skillName ? { ...skill, useCaseId, manual: true } : skill,
            ),
          },
    );
  }, []);
  const saveFlows = useCallback(
    (flows: Flow[]) => {
      setState((current) => (current === null ? current : { ...current, flows }));
      run(rpc.call("saveFlows", { flows }));
    },
    [rpc, run],
  );
  return { state, error, setError, setProjectId, rpc, run, moveLocally, saveFlows };
}

export type SkillUseCasesApi = ReturnType<typeof useSkillUseCases>;

export function ProjectSelect({ state, onChange }: { state: SkillUseCaseState; onChange: (id: string) => void }) {
  return (
    <select aria-label="Project" className={INPUT} value={state.projectId ?? ""} onChange={(event) => onChange(event.target.value)}>
      {state.projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}

export function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => undefined);
}
