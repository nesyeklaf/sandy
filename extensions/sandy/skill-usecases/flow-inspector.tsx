import type { ReactNode } from "react";
import type { Fix, Problem, SkillInfo, SourcePort } from "./check";
import { applyFix, autoBind, bindOptions, deleteNode, forkValues, removeGateOption, removePath, removeWire, summaryText, syncForkPaths, syncSkill, type Edit } from "./canvas-model";
import { GATE_OWNERS, INPUT_FIELD_TYPES, MAX_CHOICES, exitLabels, nodeTitle, orderedNodes, type Binding, type Flow, type FlowNode, type ForkNode, type GateNode, type InputNode, type OutputNode, type SkillNode, type Wire } from "./graph";
import { formatType } from "./io";
import type { Selection } from "./flow-canvas";

const FIELD = "h-8 w-full rounded-md border border-border bg-background px-2 text-sm";
const SMALL = "rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50";
const OWNER_LABEL: Record<GateNode["owner"], string> = { owner: "You", agent: "Agent decides", anyone: "Anyone" };

type Commit = (edit: Edit) => void;

function withNode(flow: Flow, node: FlowNode): Flow {
  return { ...flow, nodes: flow.nodes.map((item) => (item.id === node.id ? node : item)) };
}

function syncForksOf(flow: Flow, inputId: string): Flow {
  return flow.nodes.reduce((next, node) => (node.kind === "fork" && node.choice?.nodeId === inputId ? syncForkPaths(next, node.id) : next), flow);
}

function renameBindings(flow: Flow, nodeId: string, from: string, to: string): Flow {
  const move = (binding: Binding | null): Binding | null => (binding !== null && binding.nodeId === nodeId && binding.port === from ? { nodeId, port: to } : binding);
  const nodes = flow.nodes.map((node): FlowNode => {
    switch (node.kind) {
      case "skill":
        return { ...node, inputs: node.inputs.map((input) => ({ ...input, bind: move(input.bind) })) };
      case "fork":
        return { ...node, choice: move(node.choice) };
      case "output":
        return { ...node, source: move(node.source) };
      case "gate":
        return { ...node, material: node.material.map((item) => move(item) ?? item) };
      default:
        return node;
    }
  });
  return { ...flow, nodes };
}

function bindingKey(binding: Binding | null): string {
  return binding === null ? "" : JSON.stringify([binding.nodeId, binding.port]);
}

function parseBinding(value: string): Binding | null {
  if (value === "") return null;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? { nodeId: parsed[0], port: parsed[1] } : null;
}

function sourceLabel(source: SourcePort): string {
  return nodeTitle(source.node) + " › " + source.port + " (" + formatType(source.type) + ")";
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border px-3 py-3 first:border-t-0">
      <div className="flex items-center gap-2">
        <h4 className="flex-1 text-xs font-medium text-muted-foreground">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function TextField({ label, value, required = true, multiline = false, placeholder, onCommit }: { label: string; value: string; required?: boolean; multiline?: boolean; placeholder?: string; onCommit: (value: string) => void }) {
  const commit = (raw: string) => {
    const next = required ? raw.trim() : raw;
    if (next === value || (required && next === "")) return;
    onCommit(next);
  };
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      {multiline ? (
        <textarea key={value} className="min-h-16 w-full rounded-md border border-border bg-background p-2 text-sm" defaultValue={value} placeholder={placeholder} onBlur={(event) => commit(event.target.value)} />
      ) : (
        <input
          key={value}
          className={FIELD}
          defaultValue={value}
          placeholder={placeholder}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        />
      )}
    </label>
  );
}

function BindSelect({ label, value, options, onChange }: { label: string; value: Binding | null; options: readonly SourcePort[]; onChange: (binding: Binding | null) => void }) {
  const current = bindingKey(value);
  const known = options.some((option) => bindingKey({ nodeId: option.node.id, port: option.port }) === current);
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <select className={FIELD} value={current} onChange={(event) => onChange(parseBinding(event.target.value))}>
        <option value="">Not bound</option>
        {current !== "" && !known ? <option value={current}>{(value?.nodeId ?? "") + " › " + (value?.port ?? "")} (not upstream)</option> : null}
        {options.map((option) => {
          const key = bindingKey({ nodeId: option.node.id, port: option.port });
          return (
            <option key={key} value={key}>
              {sourceLabel(option)}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function FixButtons({ flow, problem, skills, onChange }: { flow: Flow; problem: Problem; skills: readonly SkillInfo[]; onChange: Commit }) {
  if (problem.fixes.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {problem.fixes.map((fix: Fix) => (
        <button key={fix.label} type="button" className="h-6 rounded-md border border-border px-2 text-xs hover:bg-accent" onClick={() => onChange(applyFix(flow, problem.nodeId, fix.action, skills))}>
          {fix.label}
        </button>
      ))}
    </div>
  );
}

function ProblemItem({ flow, problem, skills, onChange, onSelect }: { flow: Flow; problem: Problem; skills: readonly SkillInfo[]; onChange: Commit; onSelect?: (selection: Selection) => void }) {
  const node = flow.nodes.find((item) => item.id === problem.nodeId);
  const tone = problem.severity === "error" ? "border-destructive/60" : "border-warning";
  return (
    <li className={"rounded-md border bg-card/60 p-2 " + tone}>
      <p className="text-sm">
        <span className={problem.severity === "error" ? "text-destructive" : "text-warning-text"}>{problem.severity === "error" ? "Error" : "Warning"}</span>
        {node === undefined || onSelect === undefined ? null : (
          <>
            {" · "}
            <button type="button" className="underline" onClick={() => onSelect({ kind: "node", id: node.id })}>
              {nodeTitle(node)}
            </button>
          </>
        )}
      </p>
      <p className="text-sm">{problem.message}</p>
      <FixButtons flow={flow} problem={problem} skills={skills} onChange={onChange} />
    </li>
  );
}

export function CheckList({ flow, problems, skills, onChange, onSelect }: { flow: Flow; problems: readonly Problem[]; skills: readonly SkillInfo[]; onChange: Commit; onSelect: (selection: Selection) => void }) {
  if (problems.length === 0) return <p className="p-3 text-sm text-muted-foreground">No problems. This flow can run.</p>;
  const sorted = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return (
    <ul className="space-y-2 p-3" aria-label="Check">
      {sorted.map((problem, index) => (
        <ProblemItem key={String(index) + problem.message} flow={flow} problem={problem} skills={skills} onChange={onChange} onSelect={onSelect} />
      ))}
    </ul>
  );
}

const KIND_NAME: Record<FlowNode["kind"], string> = { skill: "Skill", input: "Input", gate: "Gate", fork: "Fork", output: "Output" };

export function Outline({ flow, problems, selection, onSelect }: { flow: Flow; problems: readonly Problem[]; selection: Selection; onSelect: (selection: Selection) => void }) {
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">{summaryText(flow)}</p>
      <ol className="space-y-0.5" aria-label="Outline">
        {orderedNodes(flow).map((node, index) => {
          const errors = problems.filter((problem) => problem.nodeId === node.id);
          const active = selection?.kind === "node" && selection.id === node.id;
          return (
            <li key={node.id}>
              <button type="button" className={"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent " + (active ? "bg-accent" : "")} onClick={() => onSelect({ kind: "node", id: node.id })}>
                <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground">{KIND_NAME[node.kind]}</span>
                <span className="min-w-0 flex-1 truncate">{nodeTitle(node)}</span>
                {errors.length === 0 ? null : <span className={"text-xs " + (errors.some((problem) => problem.severity === "error") ? "text-destructive" : "text-warning-text")}>{errors.length}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      {flow.nodes.length === 0 ? <p className="text-sm text-muted-foreground">No blocks yet.</p> : null}
    </div>
  );
}

function SkillStepPanel({ flow, node, skills, onChange, onOpenSkill }: { flow: Flow; node: SkillNode; skills: readonly SkillInfo[]; onChange: Commit; onOpenSkill: () => void }) {
  const save = (next: SkillNode, message: string) => onChange({ flow: withNode(flow, next), nodeId: node.id, message });
  const pickSkill = (name: string) => {
    const info = skills.find((skill) => skill.name === name);
    if (info === undefined) {
      save({ ...node, skill: null }, node.name + " is now an ad hoc step");
      return;
    }
    const renamed = node.name === node.skill || node.name === "New skill" ? info.name : node.name;
    const bound = autoBind(withNode(flow, syncSkill({ ...node, name: renamed, skill: info.name }, info)), node.id);
    onChange({ flow: bound.flow, nodeId: node.id, message: "Now uses " + info.name + (bound.notes.length === 0 ? "" : " · bound " + bound.notes.join(", ")) });
  };
  const installed = node.skill === null || skills.some((skill) => skill.name === node.skill);
  const editSkill =
    node.skill !== null && installed ? (
      <button type="button" className={SMALL} onClick={onOpenSkill}>
        Edit skill
      </button>
    ) : null;
  return (
    <>
      <Section title="Step">
        <TextField label="Name" value={node.name} onCommit={(name) => save({ ...node, name }, "Renamed to " + name)} />
        <label className="block space-y-1">
          <span className="block text-xs text-muted-foreground">Skill</span>
          <select className={FIELD} value={node.skill ?? ""} onChange={(event) => pickSkill(event.target.value)}>
            <option value="">Ad hoc (no skill)</option>
            {installed ? null : <option value={node.skill ?? ""}>{node.skill} (not installed)</option>}
            {skills.map((skill) => (
              <option key={skill.name} value={skill.name}>
                {skill.name}
              </option>
            ))}
          </select>
        </label>
        <TextField label="Instruction" value={node.instruction} required={false} multiline placeholder="What the agent should do in this step" onCommit={(instruction) => save({ ...node, instruction }, "Updated the instruction")} />
      </Section>
      <Section title="Inputs" action={editSkill}>
        {node.inputs.length === 0 ? <p className="text-xs text-muted-foreground">This skill declares no inputs.</p> : null}
        {node.inputs.map((input) => (
          <BindSelect
            key={input.name}
            label={input.name + (input.optional ? " (optional)" : "") + " · " + formatType(input.type)}
            value={input.bind}
            options={bindOptions(flow, node.id, input.type)}
            onChange={(bind) => save({ ...node, inputs: node.inputs.map((item) => (item === input ? { ...item, bind } : item)) }, bind === null ? "Unbound " + input.name : "Bound " + input.name)}
          />
        ))}
      </Section>
      <Section title="Outputs">
        {node.outputs.length === 0 ? <p className="text-xs text-muted-foreground">This skill declares no outputs.</p> : null}
        {node.outputs.map((output) =>
          output.type.kind === "file" ? (
            <TextField
              key={output.name}
              label={output.name + " · writes"}
              value={output.path ?? ""}
              required={false}
              placeholder={output.type.path ?? "file path"}
              onCommit={(raw) => {
                const path = raw.trim() === "" || raw.trim() === (output.type.kind === "file" ? output.type.path : null) ? null : raw.trim();
                save({ ...node, outputs: node.outputs.map((item) => (item === output ? { ...item, path } : item)) }, path === null ? output.name + " writes its default file" : output.name + " now writes " + path);
              }}
            />
          ) : (
            <p key={output.name} className="text-sm">
              {output.name} <span className="text-xs text-muted-foreground">· {formatType(output.type)}</span>
            </p>
          ),
        )}
      </Section>
    </>
  );
}

function InputPanel({ flow, node, onChange }: { flow: Flow; node: InputNode; onChange: Commit }) {
  const save = (next: Flow, message: string) => onChange({ flow: syncForksOf(next, node.id), nodeId: node.id, message });
  const setFields = (fields: InputNode["fields"], base: Flow = flow) => withNode(base, { ...node, fields });
  const taken = new Set(node.fields.map((field) => field.name));
  const fresh = () => {
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? "value" : "value" + String(n);
      if (!taken.has(name)) return name;
    }
  };
  return (
    <>
      <Section title="Input">
        <TextField label="Name" value={node.name} onCommit={(name) => save(withNode(flow, { ...node, name }), "Renamed to " + name)} />
      </Section>
      <Section title="Fields the run asks for">
        {node.fields.map((field, index) => (
          <div key={String(index) + field.name} className="space-y-2 rounded-md border border-border p-2">
            <TextField
              label="Field"
              value={field.name}
              onCommit={(name) => {
                if (taken.has(name)) return;
                save(renameBindings(setFields(node.fields.map((item, at) => (at === index ? { ...item, name } : item))), node.id, field.name, name), "Renamed " + field.name + " to " + name);
              }}
            />
            <label className="block space-y-1">
              <span className="block text-xs text-muted-foreground">Type</span>
              <select
                className={FIELD}
                value={field.type}
                onChange={(event) => {
                  const type = INPUT_FIELD_TYPES.find((item) => item === event.target.value) ?? "text";
                  save(setFields(node.fields.map((item, at) => (at === index ? { ...item, type, options: type === "choice" && item.options.length === 0 ? ["quick", "deep"] : item.options } : item))), field.name + " is now " + type);
                }}
              >
                {INPUT_FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            {field.type === "choice" ? (
              <TextField
                label="Options, comma separated"
                value={field.options.join(", ")}
                onCommit={(raw) => {
                  const options = [...new Set(raw.split(",").map((item) => item.trim()).filter((item) => item !== ""))].slice(0, MAX_CHOICES);
                  save(setFields(node.fields.map((item, at) => (at === index ? { ...item, options } : item))), "Updated the options of " + field.name);
                }}
              />
            ) : null}
            <TextField label="Prompt" value={field.prompt} required={false} placeholder="What the run asks you" onCommit={(prompt) => save(setFields(node.fields.map((item, at) => (at === index ? { ...item, prompt } : item))), "Updated the prompt")} />
            <button type="button" className={SMALL} onClick={() => save(setFields(node.fields.filter((_, at) => at !== index)), "Removed field " + field.name)}>
              Remove field
            </button>
          </div>
        ))}
        <button type="button" className={SMALL} disabled={node.fields.length >= 20} onClick={() => save(setFields([...node.fields, { name: fresh(), type: "text", options: [], prompt: "" }]), "Added a field")}>
          + Add field
        </button>
      </Section>
    </>
  );
}

function GatePanel({ flow, node, onChange }: { flow: Flow; node: GateNode; onChange: Commit }) {
  const save = (next: Flow, message: string) => onChange({ flow: next, nodeId: node.id, message });
  const set = (gate: GateNode, message: string) => save(withNode(flow, gate), message);
  const material = bindOptions(flow, node.id, null).filter((option) => option.type.kind === "file" && !node.material.some((item) => item.nodeId === option.node.id && item.port === option.port));
  return (
    <>
      <Section title="Gate">
        <TextField label="Question" value={node.question} onCommit={(question) => set({ ...node, question }, "Updated the question")} />
        <label className="block space-y-1">
          <span className="block text-xs text-muted-foreground">Who decides</span>
          <select className={FIELD} value={node.owner} onChange={(event) => set({ ...node, owner: GATE_OWNERS.find((owner) => owner === event.target.value) ?? "owner" }, "Changed who decides")}>
            {GATE_OWNERS.map((owner) => (
              <option key={owner} value={owner}>
                {OWNER_LABEL[owner]}
              </option>
            ))}
          </select>
        </label>
      </Section>
      <Section title="Options">
        {node.options.map((option, index) => (
          <div key={String(index) + option} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label={"Option " + String(index + 1)}
                value={option}
                onCommit={(label) => !node.options.includes(label) && set({ ...node, options: node.options.map((item, at) => (at === index ? label : item)) }, "Renamed option to " + label)}
              />
            </div>
            <label className="flex h-8 items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={node.ends.includes(index)}
                onChange={(event) => set({ ...node, ends: event.target.checked ? [...node.ends, index] : node.ends.filter((end) => end !== index) }, event.target.checked ? '"' + option + '" finishes the run' : '"' + option + '" no longer finishes the run')}
              />
              ends
            </label>
            <button type="button" className={SMALL + " h-8"} aria-label={"Remove option " + option} disabled={node.options.length <= 1} onClick={() => save(removeGateOption(flow, node.id, index), "Removed option " + option)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className={SMALL}
          disabled={node.options.length >= 12}
          onClick={() => {
            let label = "option";
            for (let n = 2; node.options.includes(label); n += 1) label = "option " + String(n);
            set({ ...node, options: [...node.options, label] }, "Added an option");
          }}
        >
          + Add option
        </button>
      </Section>
      <Section title="Files to show">
        {node.material.length === 0 ? <p className="text-xs text-muted-foreground">Nothing is shown with the question.</p> : null}
        <ul className="space-y-1">
          {node.material.map((item) => {
            const source = flow.nodes.find((candidate) => candidate.id === item.nodeId);
            return (
              <li key={bindingKey(item)} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{(source === undefined ? item.nodeId : nodeTitle(source)) + " › " + item.port}</span>
                <button type="button" className={SMALL} aria-label={"Stop showing " + item.port} onClick={() => set({ ...node, material: node.material.filter((other) => other !== item) }, "Stopped showing " + item.port)}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
        {material.length === 0 ? null : (
          <select
            aria-label="Show a file"
            className={FIELD}
            value=""
            onChange={(event) => {
              const binding = parseBinding(event.target.value);
              if (binding !== null) set({ ...node, material: [...node.material, binding] }, "Shows " + binding.port);
            }}
          >
            <option value="">+ Show a file…</option>
            {material.map((option) => (
              <option key={bindingKey({ nodeId: option.node.id, port: option.port })} value={bindingKey({ nodeId: option.node.id, port: option.port })}>
                {sourceLabel(option)}
              </option>
            ))}
          </select>
        )}
      </Section>
    </>
  );
}

function ForkPanel({ flow, node, onChange }: { flow: Flow; node: ForkNode; onChange: Commit }) {
  const save = (next: Flow, message: string) => onChange({ flow: next, nodeId: node.id, message });
  const set = (fork: ForkNode, message: string) => save(withNode(flow, fork), message);
  const synced = forkValues(flow, node) !== null;
  const choices = bindOptions(flow, node.id, null).filter((option) => option.type.kind === "choice");
  const choiceField = node.choice?.port ?? "";
  return (
    <>
      <Section title="Fork">
        <TextField label="Name" value={node.name} onCommit={(name) => set({ ...node, name }, "Renamed to " + name)} />
        <BindSelect label="Choose the path by" value={node.choice} options={choices} onChange={(choice) => save(syncForkPaths(withNode(flow, { ...node, choice }), node.id), choice === null ? "The fork no longer follows a choice" : "Paths follow " + choice.port)} />
      </Section>
      <Section title="Paths">
        {synced ? <p className="text-xs text-muted-foreground">Paths follow the values of {choiceField}. Edit the values on the Input.</p> : null}
        {node.paths.map((path, index) => (
          <div key={String(index) + path.label} className="space-y-1 rounded-md border border-border p-2">
            {synced ? (
              <p className="text-sm font-medium">{path.label}</p>
            ) : (
              <TextField
                label="Path"
                value={path.label}
                onCommit={(label) => !node.paths.some((other) => other.label === label) && set({ ...node, paths: node.paths.map((item, at) => (at === index ? { ...item, label } : item)) }, "Renamed path to " + label)}
              />
            )}
            <TextField label="Note" value={path.note} required={false} placeholder="e.g. skip" onCommit={(note) => set({ ...node, paths: node.paths.map((item, at) => (at === index ? { ...item, note } : item)) }, "Updated the note")} />
            {synced ? null : (
              <button type="button" className={SMALL} disabled={node.paths.length <= 1} onClick={() => save(removePath(flow, node.id, index), "Removed path " + path.label)}>
                Remove path
              </button>
            )}
          </div>
        ))}
        {synced ? null : (
          <button
            type="button"
            className={SMALL}
            disabled={node.paths.length >= MAX_CHOICES}
            onClick={() => {
              let label = "Path";
              for (let n = 2; node.paths.some((path) => path.label === label); n += 1) label = "Path " + String(n);
              const shifted = flow.wires.map((wire) => (wire.from === node.id && wire.port >= node.paths.length ? { ...wire, port: wire.port + 1 } : wire));
              save(withNode({ ...flow, wires: shifted }, { ...node, paths: [...node.paths, { label, note: "" }] }), "Added a path");
            }}
          >
            + Add path
          </button>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={node.otherwise !== null}
            onChange={(event) => {
              if (event.target.checked) set({ ...node, otherwise: { label: "Otherwise", note: "" } }, "Added an otherwise path");
              else {
                const port = node.paths.length;
                save(withNode({ ...flow, wires: flow.wires.filter((wire) => !(wire.from === node.id && wire.port === port)) }, { ...node, otherwise: null }), "Removed the otherwise path");
              }
            }}
          />
          Otherwise path for any other value
        </label>
      </Section>
    </>
  );
}

function OutputPanel({ flow, node, onChange }: { flow: Flow; node: OutputNode; onChange: Commit }) {
  const set = (output: OutputNode, message: string) => onChange({ flow: withNode(flow, output), nodeId: node.id, message });
  const files = bindOptions(flow, node.id, null).filter((option) => option.type.kind === "file");
  return (
    <Section title="Output">
      <TextField label="Label" value={node.label} onCommit={(label) => set({ ...node, label }, "Renamed to " + label)} />
      <BindSelect label="Delivers" value={node.source} options={files} onChange={(source) => set({ ...node, source }, source === null ? "Cleared the delivered file" : "Delivers " + source.port)} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={node.deliverable} onChange={(event) => set({ ...node, deliverable: event.target.checked }, event.target.checked ? "Marked as a deliverable" : "No longer a deliverable")} />
        Deliverable of the run
      </label>
    </Section>
  );
}

function WirePanel({ flow, wire, onChange }: { flow: Flow; wire: Wire; onChange: Commit }) {
  const from = flow.nodes.find((node) => node.id === wire.from);
  const to = flow.nodes.find((node) => node.id === wire.to);
  const exit = from === undefined ? "" : (exitLabels(from)[wire.port] ?? "");
  return (
    <Section title="Wire">
      <p className="text-sm">
        {from === undefined ? wire.from : nodeTitle(from)}
        {from !== undefined && (from.kind === "gate" || from.kind === "fork") ? " › " + exit : ""} → {to === undefined ? wire.to : nodeTitle(to)}
      </p>
      <button type="button" className="h-8 rounded-md border border-border px-3 text-sm text-destructive hover:bg-accent" onClick={() => onChange({ flow: removeWire(flow, wire.id), nodeId: null, message: "Removed the wire" })}>
        Delete wire
      </button>
    </Section>
  );
}

export function Inspector({
  flow,
  selection,
  skills,
  problems,
  onChange,
  onOpenSkill,
}: {
  flow: Flow;
  selection: Selection;
  skills: readonly SkillInfo[];
  problems: readonly Problem[];
  onChange: Commit;
  onOpenSkill: () => void;
}) {
  if (selection?.kind === "wire") {
    const wire = flow.wires.find((item) => item.id === selection.id);
    return wire === undefined ? null : <WirePanel flow={flow} wire={wire} onChange={onChange} />;
  }
  const node = selection?.kind === "node" ? flow.nodes.find((item) => item.id === selection.id) : undefined;
  if (node === undefined) return <p className="p-3 text-sm text-muted-foreground">Select a block or a wire to edit it. Drag blocks from the palette or use + to add one.</p>;
  const mine = problems.filter((problem) => problem.nodeId === node.id);
  return (
    <div key={node.id}>
      <div className="flex items-center gap-2 px-3 pt-3">
        <span className="rounded bg-muted px-1 text-xs text-muted-foreground">{KIND_NAME[node.kind]}</span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{nodeTitle(node)}</h3>
        <button type="button" className={SMALL + " !text-destructive"} onClick={() => onChange({ flow: deleteNode(flow, node.id), nodeId: null, message: "Deleted " + nodeTitle(node) })}>
          Delete
        </button>
      </div>
      {mine.length === 0 ? null : (
        <ul className="space-y-2 px-3 pt-3">
          {mine.map((problem, index) => (
            <ProblemItem key={String(index) + problem.message} flow={flow} problem={problem} skills={skills} onChange={onChange} />
          ))}
        </ul>
      )}
      {node.kind === "skill" ? <SkillStepPanel flow={flow} node={node} skills={skills} onChange={onChange} onOpenSkill={onOpenSkill} /> : null}
      {node.kind === "input" ? <InputPanel flow={flow} node={node} onChange={onChange} /> : null}
      {node.kind === "gate" ? <GatePanel flow={flow} node={node} onChange={onChange} /> : null}
      {node.kind === "fork" ? <ForkPanel flow={flow} node={node} onChange={onChange} /> : null}
      {node.kind === "output" ? <OutputPanel flow={flow} node={node} onChange={onChange} /> : null}
    </div>
  );
}
