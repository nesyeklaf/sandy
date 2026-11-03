import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc, useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import type { FlowProposal, SkillOverview, SkillRow, rpcContract } from "./contract";
import { flowRunText, flowSkillNames, flowStepLines, linearSteps, migrateLinear, withLinearSteps, type Flow, type FlowStep } from "./graph";
import {
  GHOST,
  INPUT,
  PANEL_PATH,
  PRIMARY,
  SECONDARY,
  ProjectSelect,
  colorOf,
  copyText,
  errorText,
  useSkillUseCases,
  type SkillUseCasesApi,
} from "./shared";

type Drag = { kind: "skill"; name: string } | { kind: "step"; index: number } | null;
type Suggestion = { rationale: string; proposal: FlowProposal };

function newFlowId(): string {
  return "flow-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function useFlowNavigation() {
  const navigate = useSandyNavigate();
  return {
    toAreas: () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" }),
    toFlows: () => navigate.toPluginPanel(PANEL_PATH, { subPath: "flows" }),
    toFlow: (id: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: "flows/" + id }),
    navigate,
  };
}

export function parseFlowId(subPath: string): string | null | undefined {
  const [first, second] = subPath.split("/");
  if (first !== "flows") return undefined;
  return second === undefined || second === "" ? null : decodeURIComponent(second);
}

export function FlowsSidebar({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useFlowNavigation();
  const [overview, setOverview] = useState<SkillOverview | null>(null);
  const refetch = useCallback(() => {
    rpc.call("overview", {}).then(setOverview, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("changed", refetch);
  const activeFlow = parseFlowId(subPath);
  const groups = useMemo(() => {
    if (overview === null) return [];
    return [
      ...overview.useCases.map((useCase) => ({ id: useCase.id, label: useCase.label })),
      { id: overview.fallbackId, label: overview.fallbackLabel },
    ]
      .map((group) => ({ ...group, flows: overview.flows.filter((flow) => flow.useCaseId === group.id) }))
      .filter((group) => group.flows.length > 0);
  }, [overview]);
  const row = (active: boolean) =>
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent " +
    (active ? "bg-accent font-medium" : "text-muted-foreground");
  return (
    <nav aria-label="Skills by use case" className="space-y-1 p-2">
      <button type="button" className={row(activeFlow === undefined)} onClick={nav.toAreas}>
        Areas
      </button>
      <button type="button" className={row(activeFlow === null)} onClick={nav.toFlows}>
        Flows
        <span className="ml-auto text-xs">+ New</span>
      </button>
      {groups.map((group, index) => (
        <div key={group.id} className="pt-1">
          <p className="flex items-center gap-2 px-2 text-xs font-medium uppercase text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: colorOf(index) }} />
            {group.label}
          </p>
          {group.flows.map((flow) => (
            <button key={flow.id} type="button" className={row(activeFlow === flow.id) + " pl-5"} onClick={() => nav.toFlow(flow.id)}>
              <span className="min-w-0 flex-1 truncate">{flow.name}</span>
              <span className="text-xs tabular-nums">{flow.nodes.length}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function SuggestionCard({
  suggestion,
  label,
  onAccept,
  onClose,
}: {
  suggestion: Suggestion;
  label: string;
  onAccept: () => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-primary/40 bg-card/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">AI suggestion: {suggestion.proposal.name}</h3>
        <button type="button" className={PRIMARY} onClick={onAccept}>
          {label}
        </button>
        <button type="button" className={SECONDARY} onClick={onClose}>
          Dismiss
        </button>
      </div>
      {suggestion.rationale === "" ? null : <p className="mt-1 text-sm text-muted-foreground">{suggestion.rationale}</p>}
      <ol className="mt-2 space-y-0.5 text-sm">
        {suggestion.proposal.steps.map((step, index) => (
          <li key={step.skill}>
            <span className="tabular-nums text-muted-foreground">{index + 1}. </span>
            <span className="font-medium">{step.skill}</span>
            {step.note === "" ? null : <span className="text-muted-foreground"> - {step.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function FlowCreator({ api, onCreated }: { api: SkillUseCasesApi; onCreated: (id: string) => void }) {
  const { state, rpc, saveFlows, setError } = api;
  const [useCaseId, setUseCaseId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [asking, setAsking] = useState(false);
  if (state === null) return null;
  const areaId = useCaseId ?? state.useCases[0]?.id ?? state.fallbackId;
  const areas = [...state.useCases.map((useCase) => ({ id: useCase.id, label: useCase.label })), { id: state.fallbackId, label: state.fallbackLabel }];
  const create = (flow: Flow) => {
    saveFlows([...state.flows, flow]);
    onCreated(flow.id);
  };
  const createEmpty = () =>
    create(migrateLinear({ id: newFlowId(), useCaseId: areaId, name: name.trim() === "" ? "New flow" : name.trim(), description: goal.trim(), steps: [] }));
  const createWithAi = () => {
    setAsking(true);
    rpc.call("recommendFlow", { projectId: state.projectId, useCaseId: areaId, goal, current: null }).then(
      ({ proposal }) => {
        setAsking(false);
        create(
          migrateLinear({
            id: newFlowId(),
            useCaseId: areaId,
            name: name.trim() === "" ? proposal.name || "New flow" : name.trim(),
            description: proposal.description,
            steps: proposal.steps,
          }),
        );
      },
      (cause: unknown) => {
        setAsking(false);
        setError(errorText(cause));
      },
    );
  };
  return (
    <section className="space-y-2 rounded-xl border bg-card/40 p-4" aria-label="New flow">
      <h2 className="text-sm font-semibold">New flow</h2>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Use case" className={INPUT} value={areaId} onChange={(event) => setUseCaseId(event.target.value)}>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.label}
            </option>
          ))}
        </select>
        <input aria-label="Flow name" placeholder="Name (optional with AI)" className={INPUT + " min-w-48 flex-1"} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <textarea
        aria-label="Goal"
        placeholder="What should this flow achieve? e.g. Ship a feature from idea to merged PR"
        className="min-h-16 w-full rounded-md border border-border bg-background p-2 text-sm"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
      />
      <div className="flex gap-2">
        <button type="button" className={PRIMARY} disabled={asking} onClick={createWithAi}>
          {asking ? "Asking AI…" : "Create with AI"}
        </button>
        <button type="button" className={SECONDARY} disabled={asking} onClick={createEmpty}>
          Create empty
        </button>
      </div>
    </section>
  );
}

function FlowList({ api, onOpen }: { api: SkillUseCasesApi; onOpen: (id: string) => void }) {
  const state = api.state;
  if (state === null || state.flows.length === 0) return null;
  const labels = new Map([...state.useCases.map((useCase) => [useCase.id, useCase.label] as const), [state.fallbackId, state.fallbackLabel] as const]);
  return (
    <ul className="space-y-1">
      {state.flows.map((flow) => (
        <li key={flow.id}>
          <button type="button" onClick={() => onOpen(flow.id)} className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-accent/50">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{flow.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{flowSkillNames(flow).join(" → ") || "No steps yet"}</span>
            </span>
            <span className="rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">{labels.get(flow.useCaseId) ?? flow.useCaseId}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function StepList({
  steps,
  drag,
  setDrag,
  onChange,
}: {
  steps: FlowStep[];
  drag: Drag;
  setDrag: (drag: Drag) => void;
  onChange: (steps: FlowStep[]) => void;
}) {
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dropAt = (index: number) => {
    setOverIndex(null);
    if (drag === null) return;
    if (drag.kind === "skill") {
      if (steps.some((step) => step.skill === drag.name)) {
        setDrag(null);
        return;
      }
      onChange([...steps.slice(0, index), { skill: drag.name, note: "" }, ...steps.slice(index)]);
    } else {
      const moved = steps[drag.index];
      if (moved !== undefined) {
        const rest = steps.filter((_, position) => position !== drag.index);
        const target = index > drag.index ? index - 1 : index;
        onChange([...rest.slice(0, target), moved, ...rest.slice(target)]);
      }
    }
    setDrag(null);
  };
  const slot = (index: number) => (
    <li
      key={"slot-" + index}
      aria-hidden="true"
      onDragOver={(event) => {
        event.preventDefault();
        setOverIndex(index);
      }}
      onDragLeave={() => setOverIndex(null)}
      onDrop={(event) => {
        event.preventDefault();
        dropAt(index);
      }}
      className={"rounded transition-all " + (overIndex === index ? "h-8 border-2 border-dashed border-primary" : drag !== null ? "h-3" : "h-1")}
    />
  );
  const swap = (from: number, to: number) => {
    const next = [...steps];
    const moved = next[from];
    const other = next[to];
    if (moved === undefined || other === undefined) return;
    next[from] = other;
    next[to] = moved;
    onChange(next);
  };
  return (
    <ol className="space-y-0" aria-label="Flow steps">
      {steps.flatMap((step, index) => [
        slot(index),
        <li
          key={step.skill}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("text/plain", step.skill);
            event.dataTransfer.effectAllowed = "move";
            setDrag({ kind: "step", index });
          }}
          className="flex cursor-grab items-start gap-2 rounded-lg border bg-card/60 px-3 py-2 active:cursor-grabbing"
        >
          <span className="mt-0.5 w-5 shrink-0 text-sm tabular-nums text-muted-foreground">{index + 1}</span>
          <div className="min-w-0 flex-1 space-y-1">
            <span className="text-sm font-medium">{step.skill}</span>
            <input
              aria-label={"Note for " + step.skill}
              placeholder="What this step achieves"
              className="h-7 w-full rounded border border-transparent bg-transparent px-1 text-xs text-muted-foreground hover:border-border focus:border-border"
              defaultValue={step.note}
              onBlur={(event) => event.target.value !== step.note && onChange(steps.map((item, position) => (position === index ? { ...item, note: event.target.value } : item)))}
            />
          </div>
          <button type="button" className={GHOST} aria-label="Move up" disabled={index === 0} onClick={() => swap(index, index - 1)}>
            ↑
          </button>
          <button type="button" className={GHOST} aria-label="Move down" disabled={index === steps.length - 1} onClick={() => swap(index, index + 1)}>
            ↓
          </button>
          <button type="button" className={GHOST} aria-label={"Remove " + step.skill} onClick={() => onChange(steps.filter((_, position) => position !== index))}>
            ✕
          </button>
        </li>,
      ])}
      {slot(steps.length)}
      {steps.length === 0 ? (
        <li className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">Drag skills here from the list on the right</li>
      ) : null}
    </ol>
  );
}

function Palette({
  skills,
  areaId,
  used,
  setDrag,
  onAdd,
}: {
  skills: SkillRow[];
  areaId: string;
  used: ReadonlySet<string>;
  setDrag: (drag: Drag) => void;
  onAdd: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyArea, setOnlyArea] = useState(true);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills
      .filter((skill) => !used.has(skill.name))
      .filter((skill) => (!onlyArea || needle !== "" || skill.useCaseId === areaId))
      .filter((skill) => needle === "" || skill.name.toLowerCase().includes(needle) || (skill.description ?? "").toLowerCase().includes(needle));
  }, [skills, used, query, onlyArea, areaId]);
  return (
    <aside aria-label="Skills" className="flex min-h-0 flex-col gap-2">
      <input type="search" aria-label="Search skills" placeholder="Search skills" className={INPUT} value={query} onChange={(event) => setQuery(event.target.value)} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={onlyArea} onChange={(event) => setOnlyArea(event.target.checked)} />
        Only this use case (search always looks everywhere)
      </label>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {shown.map((skill) => (
          <li
            key={skill.name}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", skill.name);
              event.dataTransfer.effectAllowed = "copy";
              setDrag({ kind: "skill", name: skill.name });
            }}
            className="flex cursor-grab items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/50"
          >
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium">{skill.name}</span>
              {skill.description === null ? null : <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>}
            </div>
            <button type="button" className={GHOST} aria-label={"Add " + skill.name} onClick={() => onAdd(skill.name)}>
              +
            </button>
          </li>
        ))}
        {shown.length === 0 ? <li className="p-2 text-xs text-muted-foreground">No matching skills.</li> : null}
      </ul>
    </aside>
  );
}

function FlowEditor({ api, flow, onDeleted }: { api: SkillUseCasesApi; flow: Flow; onDeleted: () => void }) {
  const { state, rpc, saveFlows, setError } = api;
  const nav = useFlowNavigation();
  const [drag, setDrag] = useState<Drag>(null);
  const [goal, setGoal] = useState("");
  const [asking, setAsking] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setSuggestion(null);
    setConfirming(false);
  }, [flow.id]);
  if (state === null) return null;
  const update = (change: Partial<Flow>) =>
    saveFlows(state.flows.map((item) => (item.id === flow.id ? { ...item, ...change } : item)));
  const steps = linearSteps(flow);
  const setSteps = (next: FlowStep[]) => update(withLinearSteps(flow, next));
  const areas = [...state.useCases.map((useCase) => ({ id: useCase.id, label: useCase.label })), { id: state.fallbackId, label: state.fallbackLabel }];
  const askAi = () => {
    setAsking(true);
    setSuggestion(null);
    rpc
      .call("recommendFlow", { projectId: state.projectId, useCaseId: flow.useCaseId, goal: goal.trim() === "" ? flow.description : goal, current: steps === null || steps.length === 0 ? null : steps })
      .then(
        (result) => {
          setAsking(false);
          setSuggestion(result);
        },
        (cause: unknown) => {
          setAsking(false);
          setError(errorText(cause));
        },
      );
  };
  const names = flowSkillNames(flow);
  const used = new Set(names);
  const missing = names.filter((skill) => !state.skills.some((row) => row.name === skill));
  return (
    <div className="flex h-full flex-col" onDragEnd={() => setDrag(null)}>
      <div className="space-y-2 border-b border-border px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            key={flow.id + "-name"}
            aria-label="Flow name"
            className={INPUT + " min-w-48 flex-1 text-base font-semibold"}
            defaultValue={flow.name}
            onBlur={(event) => event.target.value.trim() !== "" && event.target.value.trim() !== flow.name && update({ name: event.target.value.trim() })}
          />
          <select aria-label="Use case" className={INPUT} value={flow.useCaseId} onChange={(event) => update({ useCaseId: event.target.value })}>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.label}
              </option>
            ))}
          </select>
          <ProjectSelect state={state} onChange={api.setProjectId} />
          <button
            type="button"
            className={PRIMARY}
            disabled={flow.nodes.length === 0}
            onClick={() =>
              nav.navigate.toCompose({
                ...(state.projectId === null ? {} : { projectId: state.projectId }),
                initialPrompt: flowRunText(flow),
                focusPrompt: true,
              })
            }
          >
            Run flow
          </button>
          <button type="button" className={SECONDARY} disabled={flow.nodes.length === 0} onClick={() => copyText(flowRunText(flow))}>
            Copy
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                className={GHOST + " !text-destructive"}
                onClick={() => {
                  saveFlows(state.flows.filter((item) => item.id !== flow.id));
                  onDeleted();
                }}
              >
                Delete?
              </button>
              <button type="button" className={GHOST} onClick={() => setConfirming(false)}>
                No
              </button>
            </>
          ) : (
            <button type="button" className={GHOST} onClick={() => setConfirming(true)}>
              🗑
            </button>
          )}
        </div>
        <input
          key={flow.id + "-description"}
          aria-label="Description"
          placeholder="What is this flow for?"
          className={INPUT + " w-full"}
          defaultValue={flow.description}
          onBlur={(event) => event.target.value !== flow.description && update({ description: event.target.value })}
        />
        {steps === null ? null : (
        <div className="flex flex-wrap gap-2">
          <input aria-label="Goal for AI" placeholder="Goal for the AI (optional)" className={INPUT + " min-w-48 flex-1"} value={goal} onChange={(event) => setGoal(event.target.value)} />
          <button type="button" className={SECONDARY} disabled={asking} onClick={askAi}>
            {asking ? "Asking AI…" : steps.length === 0 ? "Suggest steps" : "Improve with AI"}
          </button>
        </div>
        )}
        {api.error === null ? null : <p role="alert" className="text-sm text-destructive">{api.error}</p>}
      </div>
      <div className="grid min-h-0 flex-1 gap-4 p-4 md:grid-cols-[minmax(0,1fr)_20rem] md:p-5">
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {suggestion === null ? null : (
            <SuggestionCard
              suggestion={suggestion}
              label="Use these steps"
              onAccept={() => {
                update({
                  ...withLinearSteps(flow, suggestion.proposal.steps),
                  ...(flow.description === "" && suggestion.proposal.description !== "" ? { description: suggestion.proposal.description } : {}),
                });
                setSuggestion(null);
              }}
              onClose={() => setSuggestion(null)}
            />
          )}
          {missing.length === 0 ? null : (
            <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
              Not installed in this project: {missing.join(", ")}
            </p>
          )}
          {steps === null ? (
            <>
              <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">This flow branches. The list shows it read-only; branches are edited on the flow canvas.</p>
              <ol className="space-y-1 text-sm" aria-label="Flow steps">
                {flowStepLines(flow, "").map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ol>
            </>
          ) : (
            <StepList steps={steps} drag={drag} setDrag={setDrag} onChange={setSteps} />
          )}
        </div>
        {steps === null ? null : (
          <Palette skills={state.skills} areaId={flow.useCaseId} used={used} setDrag={setDrag} onAdd={(name) => setSteps([...steps, { skill: name, note: "" }])} />
        )}
      </div>
    </div>
  );
}

export function FlowsPage({ flowId }: { flowId: string | null }) {
  const api = useSkillUseCases();
  const nav = useFlowNavigation();
  const { state, error } = api;
  if (state === null) {
    return error === null ? (
      <p className="p-4 text-sm text-muted-foreground">Loading…</p>
    ) : (
      <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
    );
  }
  if (flowId !== null) {
    const flow = state.flows.find((item) => item.id === flowId);
    return flow === undefined ? (
      <div className="p-4 text-sm text-muted-foreground">
        This flow does not exist.{" "}
        <button type="button" className="underline" onClick={nav.toFlows}>
          Back to flows
        </button>
      </div>
    ) : (
      <FlowEditor api={api} flow={flow} onDeleted={nav.toFlows} />
    );
  }
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-base font-semibold">Flows</h1>
          <ProjectSelect state={state} onChange={api.setProjectId} />
        </div>
        {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
        <FlowCreator api={api} onCreated={nav.toFlow} />
        <FlowList api={api} onOpen={nav.toFlow} />
      </div>
    </div>
  );
}
