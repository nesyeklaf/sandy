import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import type { AssignmentProposal, SkillRow } from "./contract";
import {
  GHOST,
  INPUT,
  PRIMARY,
  SECONDARY,
  ProjectSelect,
  colorOf,
  copyText,
  errorText,
  skillPrompt,
  slug,
  useSkillUseCases,
  type Option,
  type UseCase,
} from "./shared";

function SkillRowItem({
  skill,
  options,
  onMove,
  onUnpin,
  onDragStart,
  onUse,
}: {
  skill: SkillRow;
  options: Option[];
  onMove: (useCaseId: string) => void;
  onUnpin: () => void;
  onDragStart: () => void;
  onUse: () => void;
}) {
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", skill.name);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      className="flex cursor-grab items-start gap-3 rounded-lg px-3 py-2 hover:bg-accent/50 active:cursor-grabbing"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{skill.name}</span>
          {skill.sources.map((source) => (
            <span key={source} className="rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">
              {source}
            </span>
          ))}
          {skill.manual ? (
            <button type="button" className={GHOST} title="Back to automatic placement" onClick={onUnpin}>
              pinned ✕
            </button>
          ) : null}
        </div>
        {skill.description === null ? null : (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
        )}
      </div>
      <button type="button" className={GHOST} title="Insert /" onClick={onUse}>
        Use
      </button>
      <button type="button" className={GHOST} title="Copy /skill" onClick={() => copyText(skillPrompt(skill.name).trim())}>
        Copy
      </button>
      <select
        aria-label={"Move " + skill.name + " to"}
        className="h-7 w-28 shrink-0 rounded border border-transparent bg-transparent text-xs text-muted-foreground hover:border-border focus:border-border"
        value=""
        onChange={(event) => event.target.value !== "" && onMove(event.target.value)}
      >
        <option value="">Move to…</option>
        {options
          .filter((option) => option.id !== skill.useCaseId)
          .map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
      </select>
    </li>
  );
}

function Section({
  id,
  index,
  label,
  skills,
  useCase,
  options,
  dragging,
  register,
  onDropSkill,
  onMove,
  onUnpin,
  onDragStart,
  onUse,
  onChange,
  onDelete,
}: {
  id: string;
  index: number;
  label: string;
  skills: SkillRow[];
  useCase: UseCase | null;
  options: Option[];
  dragging: boolean;
  register: (id: string, element: HTMLElement | null) => void;
  onDropSkill: () => void;
  onMove: (skillName: string, useCaseId: string) => void;
  onUnpin: (skillName: string) => void;
  onDragStart: (skillName: string) => void;
  onUse: (skillName: string) => void;
  onChange: (change: Partial<UseCase>) => void;
  onDelete: () => void;
}) {
  const [over, setOver] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showKeywords, setShowKeywords] = useState(false);
  const [name, setName] = useState(label);
  const [keywords, setKeywords] = useState(useCase?.keywords.join(", ") ?? "");
  useEffect(() => setName(label), [label]);
  useEffect(() => setKeywords(useCase?.keywords.join(", ") ?? ""), [useCase]);
  const color = colorOf(index);
  return (
    <section
      ref={(element) => register(id, element)}
      aria-label={label}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onDropSkill();
      }}
      className="rounded-xl border bg-card/40 transition-colors"
      style={{
        borderColor: over ? color : undefined,
        borderStyle: dragging && !over ? "dashed" : undefined,
        backgroundColor: over ? "color-mix(in oklab, " + color + " 10%, transparent)" : undefined,
        borderLeft: "4px solid " + color,
      }}
    >
      <header className="sticky top-0 z-10 flex items-center gap-1 rounded-t-xl bg-background/90 px-3 py-2 backdrop-blur">
        {useCase === null ? (
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</h2>
        ) : (
          <input
            aria-label="Area name"
            className="min-w-0 flex-1 rounded bg-transparent px-1 text-sm font-semibold hover:bg-accent focus:bg-background"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => name.trim() !== "" && name.trim() !== label && onChange({ label: name.trim() })}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
        )}
        <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">{skills.length}</span>
        {useCase === null ? null : (
          <>
            <button type="button" className={GHOST} title="Edit keywords" onClick={() => setShowKeywords((value) => !value)}>
              ⚙
            </button>
            {confirming ? (
              <>
                <button type="button" className={GHOST + " !text-destructive"} onClick={onDelete}>
                  Delete?
                </button>
                <button type="button" className={GHOST} onClick={() => setConfirming(false)}>
                  No
                </button>
              </>
            ) : (
              <button type="button" className={GHOST} title="Delete area" onClick={() => setConfirming(true)}>
                🗑
              </button>
            )}
          </>
        )}
      </header>
      {showKeywords && useCase !== null ? (
        <div className="space-y-1 px-3 pb-2">
          <input
            aria-label={"Keywords for " + label}
            className={INPUT + " w-full"}
            placeholder="keyword, keyword, …"
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
            onBlur={() => onChange({ keywords: keywords.split(",").map((k) => k.trim()).filter((k) => k !== "") })}
          />
          <p className="text-xs text-muted-foreground">Skills whose name or description match are placed here automatically.</p>
        </div>
      ) : null}
      <ul className="px-1 pb-2">
        {skills.length === 0 ? (
          <li className="mx-2 rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            Drop skills here
          </li>
        ) : (
          skills.map((skill) => (
            <SkillRowItem
              key={skill.name}
              skill={skill}
              options={options}
              onMove={(useCaseId) => onMove(skill.name, useCaseId)}
              onUnpin={() => onUnpin(skill.name)}
              onDragStart={() => onDragStart(skill.name)}
              onUse={() => onUse(skill.name)}
            />
          ))
        )}
      </ul>
    </section>
  );
}

function IndexEntry({
  label,
  count,
  color,
  active,
  onJump,
  onDropSkill,
}: {
  label: string;
  count: number;
  color: string;
  active: boolean;
  onJump: () => void;
  onDropSkill: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={onJump}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          onDropSkill();
        }}
        className={
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent " +
          (active ? "bg-accent font-medium" : "text-muted-foreground") +
          (over ? " ring-2 ring-primary" : "")
        }
      >
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-xs tabular-nums">{count}</span>
      </button>
    </li>
  );
}

function AssignmentReview({
  proposals,
  busy,
  onApply,
  onClose,
}: {
  proposals: AssignmentProposal[];
  busy: boolean;
  onApply: (picked: AssignmentProposal[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(proposals.map((proposal) => proposal.skillName)));
  const toggle = (name: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <div className="rounded-xl border border-primary/40 bg-card/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">AI suggestions ({proposals.length})</h3>
        <button type="button" className={GHOST} onClick={() => setPicked(new Set(proposals.map((proposal) => proposal.skillName)))}>
          All
        </button>
        <button type="button" className={GHOST} onClick={() => setPicked(new Set())}>
          None
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={busy || picked.size === 0}
          onClick={() => onApply(proposals.filter((proposal) => picked.has(proposal.skillName)))}
        >
          Apply {picked.size}
        </button>
        <button type="button" className={SECONDARY} onClick={onClose}>
          Dismiss
        </button>
      </div>
      {proposals.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing to change: the AI agrees with the current placement.</p>
      ) : (
        <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto">
          {proposals.map((proposal) => (
            <li key={proposal.skillName}>
              <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-accent/50">
                <input type="checkbox" className="mt-1" checked={picked.has(proposal.skillName)} onChange={() => toggle(proposal.skillName)} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{proposal.skillName}</span>
                  <span className="text-muted-foreground"> to </span>
                  <span className="font-medium">{proposal.areaLabel}</span>
                  {proposal.newAreaLabel === null ? null : (
                    <span className="ml-1 rounded bg-muted px-1.5 text-[11px] text-muted-foreground">new area</span>
                  )}
                  {proposal.reason === "" ? null : <span className="block text-xs text-muted-foreground">{proposal.reason}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AreasPage() {
  const { state, error, setError, setProjectId, rpc, run, moveLocally } = useSkillUseCases();
  const navigate = useSandyNavigate();
  const [proposals, setProposals] = useState<AssignmentProposal[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const [activeSources, setActiveSources] = useState<ReadonlySet<string>>(new Set());
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());

  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element === null) sections.current.delete(id);
    else sections.current.set(id, element);
  }, []);

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of state?.skills ?? []) {
      for (const source of skill.sources) counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [state]);

  const columns = useMemo(() => {
    if (state === null) return [];
    const needle = query.trim().toLowerCase();
    const visible = state.skills.filter(
      (skill) =>
        (activeSources.size === 0 || skill.sources.some((source) => activeSources.has(source))) &&
        (needle === "" ||
          skill.name.toLowerCase().includes(needle) ||
          (skill.description ?? "").toLowerCase().includes(needle)),
    );
    return [
      ...state.useCases.map((useCase) => ({ id: useCase.id, label: useCase.label, useCase })),
      { id: state.fallbackId, label: state.fallbackLabel, useCase: null },
    ]
      .map((column) => ({ ...column, skills: visible.filter((skill) => skill.useCaseId === column.id) }))
      .filter((column) => column.useCase !== null || column.skills.length > 0);
  }, [state, query, activeSources]);

  const updateActive = useCallback(() => {
    const top = (scroller.current?.getBoundingClientRect().top ?? 0) + 24;
    let current: string | null = null;
    for (const [id, element] of sections.current) {
      if (element.getBoundingClientRect().top <= top) current = id;
    }
    setActiveSection(current);
  }, []);

  const jump = (id: string) => {
    sections.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  };

  if (state === null) {
    return error === null ? (
      <p className="p-4 text-sm text-muted-foreground">Loading…</p>
    ) : (
      <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
    );
  }

  const options = columns.map((column) => ({ id: column.id, label: column.label }));
  const move = (skillName: string, useCaseId: string) => {
    moveLocally(skillName, useCaseId);
    run(rpc.call("assign", { skillName, useCaseId }));
  };
  const use = (skillName: string) =>
    navigate.toCompose({
      ...(state.projectId === null ? {} : { projectId: state.projectId }),
      initialPrompt: skillPrompt(skillName),
      focusPrompt: true,
    });
  const askAi = () => {
    setAsking(true);
    setProposals(null);
    rpc.call("recommendAssignments", { projectId: state.projectId }).then(
      (result) => {
        setProposals(result.proposals);
        setAsking(false);
      },
      (cause: unknown) => {
        setError(errorText(cause));
        setAsking(false);
      },
    );
  };
  const applyAi = (picked: AssignmentProposal[]) => {
    setProposals(null);
    run(
      rpc.call("applyAssignments", {
        items: picked.map((proposal) => ({
          skillName: proposal.skillName,
          areaId: proposal.areaId,
          newAreaLabel: proposal.newAreaLabel,
        })),
      }),
    );
  };
  const unpin = (skillName: string) => run(rpc.call("assign", { skillName, useCaseId: null }));
  const save = (useCases: UseCase[]) => run(rpc.call("saveUseCases", { useCases }));
  const dropOn = (id: string) => {
    if (dragged !== null) move(dragged, id);
    setDragged(null);
  };
  const addArea = () => {
    const label = newName.trim();
    if (label === "") return;
    const id = slug(label, new Set(state.useCases.map((useCase) => useCase.id)));
    setNewName("");
    save([...state.useCases, { id, label, keywords: [] }]);
  };
  const toggleSource = (source: string) =>
    setActiveSources((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });

  return (
    <div className="flex h-full flex-col" onDragEnd={() => setDragged(null)}>
      <div className="space-y-2 border-b border-border px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectSelect state={state} onChange={setProjectId} />
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search skills"
            className={INPUT + " min-w-48 flex-1"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addArea();
            }}
          >
            <input
              aria-label="New area name"
              placeholder="New area"
              className={INPUT + " w-36"}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="submit" disabled={newName.trim() === ""} className={PRIMARY}>
              Add area
            </button>
          </form>
          <button type="button" className={SECONDARY} disabled={asking} onClick={askAi}>
            {asking ? "Asking AI…" : "Sort with AI"}
          </button>
          <button
            type="button"
            className={GHOST}
            onClick={() =>
              window.confirm("Restore the default areas and clear all manual placements?") &&
              run(rpc.call("resetUseCases", {}))
            }
          >
            Reset
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Sources">
          <span className="text-xs text-muted-foreground">Sources</span>
          <button
            type="button"
            aria-pressed={activeSources.size === 0}
            onClick={() => setActiveSources(new Set())}
            className={
              "rounded-full border px-2.5 py-0.5 text-xs " +
              (activeSources.size === 0 ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent")
            }
          >
            All
          </button>
          {sourceCounts.map(([source, count]) => (
            <button
              key={source}
              type="button"
              aria-pressed={activeSources.has(source)}
              onClick={() => toggleSource(source)}
              className={
                "rounded-full border px-2.5 py-0.5 text-xs " +
                (activeSources.has(source) ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent")
              }
            >
              {source} <span className="opacity-70">{count}</span>
            </button>
          ))}
        </div>
        {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      {state.projectId === null ? (
        <p className="p-4 text-sm text-muted-foreground">No project available.</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div ref={scroller} onScroll={updateActive} className="min-w-0 flex-1 overflow-y-auto p-4 md:p-5">
            <select
              aria-label="Jump to area"
              className={INPUT + " mb-3 w-full md:hidden"}
              value=""
              onChange={(event) => event.target.value !== "" && jump(event.target.value)}
            >
              <option value="">Jump to…</option>
              {columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.label} ({column.skills.length})
                </option>
              ))}
            </select>
            <div className="mx-auto max-w-3xl space-y-4">
              {proposals === null ? null : (
                <AssignmentReview proposals={proposals} busy={false} onApply={applyAi} onClose={() => setProposals(null)} />
              )}
              {columns.map((column, index) => (
                <Section
                  key={column.id}
                  id={column.id}
                  index={index}
                  label={column.label}
                  skills={column.skills}
                  useCase={column.useCase}
                  options={options}
                  dragging={dragged !== null}
                  register={register}
                  onDropSkill={() => dropOn(column.id)}
                  onMove={move}
                  onUnpin={unpin}
                  onDragStart={setDragged}
                  onUse={use}
                  onChange={(change) =>
                    save(state.useCases.map((useCase) => (useCase.id === column.id ? { ...useCase, ...change } : useCase)))
                  }
                  onDelete={() => save(state.useCases.filter((useCase) => useCase.id !== column.id))}
                />
              ))}
            </div>
          </div>
          <nav aria-label="Areas" className="hidden w-56 shrink-0 overflow-y-auto border-l border-border p-3 md:block">
            <p className="px-2 pb-1 text-xs font-medium uppercase text-muted-foreground">Overview</p>
            <ul className="space-y-0.5">
              {columns.map((column, index) => (
                <IndexEntry
                  key={column.id}
                  label={column.label}
                  count={column.skills.length}
                  color={colorOf(index)}
                  active={(activeSection ?? columns[0]?.id) === column.id}
                  onJump={() => jump(column.id)}
                  onDropSkill={() => dropOn(column.id)}
                />
              ))}
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}

