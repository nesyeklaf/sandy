import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc, useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import { skillInfo, type CreatableScope, type CreateFlowSkillResult, type FlowProposal, type SkillOverview, type rpcContract } from "./contract";
import { check, hasErrors } from "./check";
import { deleteNode, layout, needsLayout, record, redo, removeWire, startHistory, undo, type Edit, type History } from "./canvas-model";
import { FlowCanvas, type Selection } from "./flow-canvas";
import { reconcileEditor } from "./flow-sync";
import { confirmLeaveSkill, parseSkillPath, skillSubPath } from "./skill-route";
import { CheckList, Inspector, Outline } from "./flow-inspector";
import { flowRunText, flowSkillNames, linearSteps, migrateLinear, nodeTitle, withLinearSteps, type Flow } from "./graph";
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
  readStoredProject,
  useSkillUseCases,
  type SkillUseCasesApi,
} from "./shared";

type Suggestion = { rationale: string; proposal: FlowProposal };

function newFlowId(): string {
  return "flow-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function useFlowNavigation() {
  const navigate = useSandyNavigate();
  const go = (subPath: string) => {
    if (confirmLeaveSkill()) navigate.toPluginPanel(PANEL_PATH, { subPath });
  };
  return {
    toAreas: () => go(""),
    toFlows: () => go("flows"),
    toFlow: (id: string) => go("flows/" + id),
    toSkills: () => go(skillSubPath(null)),
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
    rpc.call("overview", { projectId: readStoredProject() }).then(setOverview, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("changed", refetch);
  const activeFlow = parseFlowId(subPath);
  const onSkills = parseSkillPath(subPath) !== undefined;
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
      <button type="button" className={row(activeFlow === undefined && !onSkills)} onClick={nav.toAreas}>
        Areas
      </button>
      <button type="button" className={row(onSkills)} onClick={nav.toSkills}>
        Skills
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

const SCOPES: { id: CreatableScope; label: string }[] = [
  { id: "sandy-project", label: "This project (.sandy/skills)" },
  { id: "shared-user", label: "My skills (~/.agents/skills)" },
];

function ScopeSelect({ value, onChange }: { value: CreatableScope; onChange: (scope: CreatableScope) => void }) {
  return (
    <select aria-label="Save the skill in" className={INPUT} value={value} onChange={(event) => onChange(SCOPES.find((scope) => scope.id === event.target.value)?.id ?? "sandy-project")}>
      {SCOPES.map((scope) => (
        <option key={scope.id} value={scope.id}>
          {scope.label}
        </option>
      ))}
    </select>
  );
}

function createdText(result: CreateFlowSkillResult): string | null {
  return result.outcome === "written" ? null : 'A skill named "' + result.flowId + '" already exists there. Pick another name.';
}

function FlowCreator({ api, onCreated }: { api: SkillUseCasesApi; onCreated: (id: string) => void }) {
  const { state, rpc, setError } = api;
  const [useCaseId, setUseCaseId] = useState<string | null>(null);
  const [scope, setScope] = useState<CreatableScope>("sandy-project");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [asking, setAsking] = useState(false);
  if (state === null) return null;
  const areaId = useCaseId ?? state.useCases[0]?.id ?? state.fallbackId;
  const areas = [...state.useCases.map((useCase) => ({ id: useCase.id, label: useCase.label })), { id: state.fallbackId, label: state.fallbackLabel }];
  const create = (flow: Flow) => {
    rpc.call("createFlowSkill", { projectId: state.projectId, flow, scope, legacyId: null }).then(
      (result) => {
        const failed = createdText(result);
        if (failed === null) onCreated(result.flowId);
        else setError(failed);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
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
        <ScopeSelect value={scope} onChange={setScope} />
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
            {flow.origin === undefined ? <span className="rounded border border-border px-1.5 text-xs leading-5 text-muted-foreground">Not a skill yet</span> : null}
            <span className="rounded bg-muted px-1.5 text-xs leading-5 text-muted-foreground">{labels.get(flow.useCaseId) ?? flow.useCaseId}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type Tab = "inspect" | "check" | "outline";

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function FlowEditor({ api, flow, onDeleted }: { api: SkillUseCasesApi; flow: Flow; onDeleted: () => void }) {
  const { state, rpc, saveFlows, savingFlows, setError } = api;
  const nav = useFlowNavigation();
  const [history, setHistory] = useState<History>(() => startHistory(needsLayout(flow) ? layout(flow) : flow));
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<Tab>("inspect");
  const [message, setMessage] = useState("");
  const [goal, setGoal] = useState("");
  const [asking, setAsking] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [scope, setScope] = useState<CreatableScope>("sandy-project");
  useEffect(() => {
    setHistory(startHistory(needsLayout(flow) ? layout(flow) : flow));
    setSelection(null);
    setSuggestion(null);
    setConfirming(false);
    setMessage("");
  }, [flow.id]);
  useEffect(() => {
    setHistory((before) => reconcileEditor(before, flow, savingFlows()));
  }, [flow, savingFlows]);
  const current = history.present.id === flow.id ? history.present : flow;
  useEffect(() => {
    if (selection?.kind === "node" && !current.nodes.some((node) => node.id === selection.id)) setSelection(null);
    else if (selection?.kind === "wire" && !current.wires.some((wire) => wire.id === selection.id)) setSelection(null);
  }, [current, selection]);
  const skills = useMemo(() => (state === null ? [] : state.skills.map(skillInfo)), [state]);
  const problems = useMemo(() => check(current, skills), [current, skills]);
  const historyRef = useRef(history);
  historyRef.current = history;
  const persist = (next: Flow) => {
    if (state !== null) saveFlows(state.flows.map((item) => (item.id === next.id ? next : item)));
  };
  const commit = (edit: Edit) => {
    if (edit.flow !== current) {
      setHistory(record(historyRef.current, edit.flow));
      persist(edit.flow);
    }
    if (edit.nodeId !== null && edit.flow.nodes.some((node) => node.id === edit.nodeId)) {
      setSelection({ kind: "node", id: edit.nodeId });
      setTab("inspect");
    } else if (selection?.kind === "node" && !edit.flow.nodes.some((node) => node.id === selection.id)) setSelection(null);
    else if (selection?.kind === "wire" && !edit.flow.wires.some((wire) => wire.id === selection.id)) setSelection(null);
    setMessage(edit.message);
  };
  const step = (direction: "undo" | "redo") => {
    const before = historyRef.current;
    const next = direction === "undo" ? undo(before) : redo(before);
    if (next === before) return;
    setHistory(next);
    persist(next.present);
    setMessage(direction === "undo" ? "Undone" : "Redone");
  };
  const removeSelection = () => {
    if (selection?.kind === "node") {
      const node = current.nodes.find((item) => item.id === selection.id);
      if (node !== undefined) commit({ flow: deleteNode(current, node.id), nodeId: null, message: "Deleted " + nodeTitle(node) });
    } else if (selection?.kind === "wire") commit({ flow: removeWire(current, selection.id), nodeId: null, message: "Removed the wire" });
  };
  const keys = useRef({ step, removeSelection });
  keys.current = { step, removeSelection };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") keys.current.step(event.shiftKey ? "redo" : "undo");
      else if (mod && event.key.toLowerCase() === "y") keys.current.step("redo");
      else if (event.key === "Delete" || event.key === "Backspace") keys.current.removeSelection();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (state === null) return null;
  const update = (change: Partial<Flow>, text: string) => commit({ flow: { ...current, ...change }, nodeId: null, message: text });
  const steps = linearSteps(current);
  const areas = [...state.useCases.map((useCase) => ({ id: useCase.id, label: useCase.label })), { id: state.fallbackId, label: state.fallbackLabel }];
  const askAi = () => {
    setAsking(true);
    setSuggestion(null);
    rpc
      .call("recommendFlow", { projectId: state.projectId, useCaseId: current.useCaseId, goal: goal.trim() === "" ? current.description : goal, current: steps === null || steps.length === 0 ? null : steps })
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
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const blocked = current.nodes.length === 0 ? "Add a block first" : hasErrors(problems) ? "Fix the errors in Check first" : null;
  const tabButton = (id: Tab, label: string) => (
    <button type="button" role="tab" aria-selected={tab === id} className={"h-8 flex-1 border-b-2 text-sm " + (tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")} onClick={() => setTab(id)}>
      {label}
    </button>
  );
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            key={current.id + "-name-" + current.name}
            aria-label="Flow name"
            className={INPUT + " min-w-48 flex-1 text-base font-semibold"}
            defaultValue={current.name}
            onBlur={(event) => event.target.value.trim() !== "" && event.target.value.trim() !== current.name && update({ name: event.target.value.trim() }, "Renamed the flow")}
          />
          <select aria-label="Use case" className={INPUT} value={current.useCaseId} onChange={(event) => update({ useCaseId: event.target.value }, "Moved the flow")}>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.label}
              </option>
            ))}
          </select>
          <ProjectSelect state={state} onChange={api.setProjectId} />
          <button type="button" className={GHOST} aria-label="Undo" title="Undo (Ctrl+Z)" disabled={history.past.length === 0} onClick={() => step("undo")}>
            ↶
          </button>
          <button type="button" className={GHOST} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={history.future.length === 0} onClick={() => step("redo")}>
            ↷
          </button>
          <button
            type="button"
            className={PRIMARY}
            disabled={blocked !== null}
            title={blocked ?? "Start a thread that runs this flow as a track"}
            onClick={() =>
              nav.navigate.toCompose({
                ...(state.projectId === null ? {} : { projectId: state.projectId }),
                initialPrompt: flowRunText(current),
                focusPrompt: true,
              })
            }
          >
            Run flow
          </button>
          <button type="button" className={SECONDARY} disabled={current.nodes.length === 0} onClick={() => copyText(flowRunText(current))}>
            Copy
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                className={GHOST + " !text-destructive"}
                onClick={() => {
                  if (current.origin === undefined) {
                    saveFlows(state.flows.filter((item) => item.id !== current.id));
                    onDeleted();
                    return;
                  }
                  rpc.call("deleteFlowSkill", { projectId: state.projectId, skillId: current.origin.skillId }).then(
                    (result) => (result.ok ? onDeleted() : setError("The skill could not be deleted.")),
                    (cause: unknown) => setError(errorText(cause)),
                  );
                }}
              >
                Delete?
              </button>
              <button type="button" className={GHOST} onClick={() => setConfirming(false)}>
                No
              </button>
            </>
          ) : (
            <button type="button" className={GHOST} aria-label="Delete flow" onClick={() => setConfirming(true)}>
              🗑
            </button>
          )}
        </div>
        {current.origin === undefined ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <span className="flex-1 text-muted-foreground">This flow is not a skill yet. Save it as a SKILL.md to run it with stage_start and edit it as a file.</span>
            <ScopeSelect value={scope} onChange={setScope} />
            <button
              type="button"
              className={SECONDARY}
              onClick={() =>
                rpc.call("createFlowSkill", { projectId: state.projectId, flow: current, scope, legacyId: current.id }).then(
                  (result) => {
                    const failed = createdText(result);
                    if (failed === null) nav.toFlow(result.flowId);
                    else setError(failed);
                  },
                  (cause: unknown) => setError(errorText(cause)),
                )
              }
            >
              Save as skill
            </button>
          </div>
        ) : (
          <p className="truncate text-xs text-muted-foreground" title={current.origin.filePath}>
            {current.origin.writable ? current.origin.filePath : "Read only: " + current.origin.filePath}
          </p>
        )}
        <input
          key={current.id + "-description-" + current.description}
          aria-label="Description"
          placeholder="What is this flow for?"
          className={INPUT + " w-full"}
          defaultValue={current.description}
          onBlur={(event) => event.target.value !== current.description && update({ description: event.target.value }, "Updated the description")}
        />
        {steps === null ? null : (
          <div className="flex flex-wrap gap-2">
            <input aria-label="Goal for AI" placeholder="Goal for the AI (optional)" className={INPUT + " min-w-48 flex-1"} value={goal} onChange={(event) => setGoal(event.target.value)} />
            <button type="button" className={SECONDARY} disabled={asking} onClick={askAi}>
              {asking ? "Asking AI…" : steps.length === 0 ? "Suggest steps" : "Improve with AI"}
            </button>
          </div>
        )}
        {suggestion === null ? null : (
          <SuggestionCard
            suggestion={suggestion}
            label="Use these steps"
            onAccept={() => {
              commit({
                flow: layout({
                  ...withLinearSteps(current, suggestion.proposal.steps),
                  ...(current.description === "" && suggestion.proposal.description !== "" ? { description: suggestion.proposal.description } : {}),
                }),
                nodeId: null,
                message: "Used the AI steps",
              });
              setSuggestion(null);
            }}
            onClose={() => setSuggestion(null)}
          />
        )}
        {api.error === null ? null : <p role="alert" className="text-sm text-destructive">{api.error}</p>}
      </div>
      <div className="flex min-h-0 flex-1">
        <FlowCanvas
          flow={current}
          skills={skills}
          problems={problems}
          selection={selection}
          fitKey={current.id}
          message={message}
          onSelect={(next) => {
            setSelection(next);
            if (next !== null) setTab("inspect");
          }}
          onChange={commit}
        />
        <aside aria-label="Flow details" className="flex w-80 shrink-0 flex-col border-l border-border">
          <div role="tablist" className="flex border-b border-border px-2">
            {tabButton("inspect", "Inspector")}
            {tabButton("check", errors > 0 ? "Check · " + String(errors) : problems.length > 0 ? "Check · " + String(problems.length) : "Check ✓")}
            {tabButton("outline", "Outline")}
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
            {tab === "inspect" ? <Inspector flow={current} selection={selection} skills={skills} problems={problems} onChange={commit} /> : null}
            {tab === "check" ? (
              <CheckList
                flow={current}
                problems={problems}
                skills={skills}
                onChange={commit}
                onSelect={(next) => {
                  setSelection(next);
                  setTab("inspect");
                }}
              />
            ) : null}
            {tab === "outline" ? <Outline flow={current} problems={problems} selection={selection} onSelect={setSelection} /> : null}
          </div>
        </aside>
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
        {state.skillFlowErrors.length === 0 ? null : (
          <section aria-label="Skills that do not open as flows" className="space-y-2">
            <h2 className="text-sm font-semibold">Skills that do not open as flows</h2>
            {state.skillFlowErrors.map((item) => (
              <div key={item.skillId} className="rounded-lg border px-3 py-2 text-sm">
                <p className="font-medium">{item.name}</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {item.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
