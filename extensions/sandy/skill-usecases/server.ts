import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import {
  assignmentsPrompt,
  assignmentsReplySchema,
  askJson,
  flowPrompt,
  flowReplySchema,
} from "./ai.ts";
import { CHANGED_EVENT, FLOW_PROVIDER_ID, MAX_USE_CASES, rpcContract, useCaseSchema, type SkillRow } from "./contract.ts";
import { flowRunText, flowSkillNames, flowStepLines, storedFlowSchema, upgradeFlow, type Flow, type FlowStep } from "./graph.ts";
import {
  DEFAULT_USE_CASES,
  FALLBACK_ID,
  FALLBACK_LABEL,
  resolveUseCase,
  sourceOf,
  type UseCase,
} from "./usecases.ts";

export { rpcContract };

const USE_CASES_KEY = "usecases";
const ASSIGNMENTS_KEY = "assignments";
const FLOWS_KEY = "flows";

const storedUseCases = z.array(useCaseSchema);
const storedAssignments = z.record(z.string(), z.string());
const storedFlows = z.array(storedFlowSchema);
const skillAreasInput = z.object({ area: z.string().optional() });
const skillFlowsInput = z.object({ flow: z.string().optional(), area: z.string().optional() });

function slug(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 30) || "area";
  let id = base;
  for (let n = 2; taken.has(id) || id === FALLBACK_ID; n += 1) id = base + "-" + n;
  return id;
}

export default async function plugin(sandy: SandyPluginApi) {
  async function readUseCases(): Promise<UseCase[]> {
    const parsed = storedUseCases.safeParse(await sandy.storage.kv.get(USE_CASES_KEY));
    return parsed.success ? parsed.data : DEFAULT_USE_CASES;
  }

  async function readAssignments(): Promise<Record<string, string>> {
    const parsed = storedAssignments.safeParse(await sandy.storage.kv.get(ASSIGNMENTS_KEY));
    return parsed.success ? parsed.data : {};
  }

  async function readFlows(): Promise<Flow[]> {
    const parsed = storedFlows.safeParse(await sandy.storage.kv.get(FLOWS_KEY));
    if (!parsed.success) return [];
    const flows = parsed.data.map(upgradeFlow);
    if (parsed.data.some((stored) => !("version" in stored))) await sandy.storage.kv.set(FLOWS_KEY, flows);
    return flows;
  }

  async function listProjects() {
    return (await sandy.sdk.projects.list()).map((project) => ({ id: project.id, name: project.name }));
  }

  async function resolveProjectId(projectId: string | null): Promise<string | null> {
    const projects = await listProjects();
    return (projects.find((project) => project.id === projectId) ?? projects[0])?.id ?? null;
  }

  async function skillRows(projectId: string, useCases: UseCase[], assignments: Record<string, string>): Promise<SkillRow[]> {
    const listed = await sandy.sdk.skills.list({ projectId, environmentId: null });
    const sourcesByName = new Map<string, Set<string>>();
    for (const skill of listed.skills) {
      const sources = sourcesByName.get(skill.name) ?? new Set<string>();
      sources.add(sourceOf(skill));
      for (const duplicate of skill.duplicates) sources.add(sourceOf(duplicate));
      sourcesByName.set(skill.name, sources);
    }
    const rows: SkillRow[] = [];
    const seen = new Set<string>();
    for (const skill of listed.skills) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      const { useCaseId, manual } = resolveUseCase(skill, useCases, assignments);
      rows.push({
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        provider: skill.provider,
        useCaseId,
        manual,
        sources: [...(sourcesByName.get(skill.name) ?? [])].sort(),
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  function changed() {
    sandy.realtime.publish(CHANGED_EVENT, {});
  }

  function areaLabels(useCases: UseCase[]): Map<string, string> {
    return new Map([...useCases.map((useCase) => [useCase.id, useCase.label] as const), [FALLBACK_ID, FALLBACK_LABEL]]);
  }

  sandy.rpc.register(rpcContract, {
    async state({ projectId }) {
      const selected = await resolveProjectId(projectId);
      const useCases = await readUseCases();
      const assignments = await readAssignments();
      return {
        projects: await listProjects(),
        projectId: selected,
        useCases,
        fallbackId: FALLBACK_ID,
        fallbackLabel: FALLBACK_LABEL,
        skills: selected === null ? [] : await skillRows(selected, useCases, assignments),
        flows: await readFlows(),
      };
    },
    async overview() {
      return {
        useCases: await readUseCases(),
        fallbackId: FALLBACK_ID,
        fallbackLabel: FALLBACK_LABEL,
        flows: await readFlows(),
      };
    },
    async assign({ skillName, useCaseId }) {
      const assignments = await readAssignments();
      if (useCaseId === null) delete assignments[skillName];
      else assignments[skillName] = useCaseId;
      await sandy.storage.kv.set(ASSIGNMENTS_KEY, assignments);
      changed();
      return { ok: true };
    },
    async saveUseCases({ useCases }) {
      const ids = new Set(useCases.map((useCase) => useCase.id));
      if (ids.size !== useCases.length || ids.has(FALLBACK_ID)) return { ok: false };
      const assignments = await readAssignments();
      const kept = Object.fromEntries(
        Object.entries(assignments).filter(([, id]) => id === FALLBACK_ID || ids.has(id)),
      );
      const flows = (await readFlows()).map((flow) =>
        flow.useCaseId === FALLBACK_ID || ids.has(flow.useCaseId) ? flow : { ...flow, useCaseId: FALLBACK_ID },
      );
      await sandy.storage.kv.set(USE_CASES_KEY, useCases);
      await sandy.storage.kv.set(ASSIGNMENTS_KEY, kept);
      await sandy.storage.kv.set(FLOWS_KEY, flows);
      changed();
      return { ok: true };
    },
    async resetUseCases() {
      await sandy.storage.kv.delete(USE_CASES_KEY);
      await sandy.storage.kv.delete(ASSIGNMENTS_KEY);
      const useCases = DEFAULT_USE_CASES;
      const ids = new Set(useCases.map((useCase) => useCase.id));
      const flows = (await readFlows()).map((flow) =>
        flow.useCaseId === FALLBACK_ID || ids.has(flow.useCaseId) ? flow : { ...flow, useCaseId: FALLBACK_ID },
      );
      await sandy.storage.kv.set(FLOWS_KEY, flows);
      changed();
      return { ok: true };
    },
    async saveFlows({ flows }) {
      const useCases = await readUseCases();
      const known = new Set([FALLBACK_ID, ...useCases.map((useCase) => useCase.id)]);
      const ids = new Set(flows.map((flow) => flow.id));
      if (ids.size !== flows.length || flows.some((flow) => !known.has(flow.useCaseId))) return { ok: false };
      await sandy.storage.kv.set(FLOWS_KEY, flows);
      changed();
      return { ok: true };
    },
    async recommendAssignments({ projectId }) {
      const selected = await resolveProjectId(projectId);
      if (selected === null) throw new Error("No project available.");
      const useCases = await readUseCases();
      const rows = (await skillRows(selected, useCases, await readAssignments())).filter((row) => !row.manual);
      if (rows.length === 0) return { proposals: [] };
      const reply = await askJson(
        sandy,
        selected,
        "Sort skills into areas",
        assignmentsPrompt(rows, useCases, FALLBACK_ID),
        assignmentsReplySchema,
      );
      const byName = new Map(rows.map((row) => [row.name, row] as const));
      const byKey = new Map<string, UseCase>();
      for (const useCase of useCases) {
        byKey.set(useCase.id.toLowerCase(), useCase);
        byKey.set(useCase.label.toLowerCase(), useCase);
      }
      const proposals = [];
      for (const item of reply.assignments) {
        const row = byName.get(item.skill);
        const label = item.area.trim();
        if (row === undefined || label === "") continue;
        const key = label.toLowerCase();
        const match = byKey.get(key);
        let areaId: string | null = null;
        let newAreaLabel: string | null = null;
        let areaLabel = label.slice(0, 60);
        if (match !== undefined) {
          areaId = match.id;
          areaLabel = match.label;
        } else if (key === FALLBACK_ID || key === FALLBACK_LABEL.toLowerCase()) {
          areaId = FALLBACK_ID;
          areaLabel = FALLBACK_LABEL;
        } else {
          newAreaLabel = areaLabel;
        }
        if (areaId === row.useCaseId) continue;
        proposals.push({ skillName: row.name, areaId, newAreaLabel, areaLabel, reason: item.reason.slice(0, 120) });
      }
      return { proposals };
    },
    async applyAssignments({ items }) {
      const useCases = await readUseCases();
      const assignments = await readAssignments();
      const created = new Map<string, string>();
      const known = new Set(useCases.map((useCase) => useCase.id));
      for (const item of items) {
        let target = item.areaId;
        if (target === null && item.newAreaLabel !== null) {
          const label = item.newAreaLabel.trim().slice(0, 60);
          const existing = useCases.find((useCase) => useCase.label.toLowerCase() === label.toLowerCase());
          const id = existing?.id ?? created.get(label.toLowerCase());
          if (id !== undefined) target = id;
          else if (label !== "" && useCases.length < MAX_USE_CASES) {
            const fresh = slug(label, known);
            known.add(fresh);
            useCases.push({ id: fresh, label, keywords: [] });
            created.set(label.toLowerCase(), fresh);
            target = fresh;
          }
        }
        if (target !== null && (target === FALLBACK_ID || known.has(target))) assignments[item.skillName] = target;
      }
      await sandy.storage.kv.set(USE_CASES_KEY, useCases);
      await sandy.storage.kv.set(ASSIGNMENTS_KEY, assignments);
      changed();
      return { ok: true };
    },
    async recommendFlow({ projectId, useCaseId, goal, current }) {
      const selected = await resolveProjectId(projectId);
      if (selected === null) throw new Error("No project available.");
      const useCases = await readUseCases();
      const labels = areaLabels(useCases);
      const rows = await skillRows(selected, useCases, await readAssignments());
      const reply = await askJson(
        sandy,
        selected,
        "Recommend a skill flow",
        flowPrompt({
          area: labels.get(useCaseId) ?? useCaseId,
          areaId: useCaseId,
          areaLabels: labels,
          goal,
          skills: rows,
          current,
        }),
        flowReplySchema,
      );
      const names = new Set(rows.map((row) => row.name));
      const used = new Set<string>();
      const steps: FlowStep[] = [];
      for (const step of reply.steps) {
        if (!names.has(step.skill) || used.has(step.skill)) continue;
        used.add(step.skill);
        steps.push({ skill: step.skill, note: step.note.slice(0, 300) });
      }
      if (steps.length === 0) throw new Error("The AI did not name any known skill. Try again with a clearer goal.");
      return {
        rationale: reply.rationale,
        proposal: { name: reply.name.slice(0, 80), description: reply.description.slice(0, 400), steps },
      };
    },
  });

  sandy.agents.registerTool({
    name: "skill_areas",
    description:
      "List the user's skills grouped by use-case area (for example 'Debug and test'). Pass area to list one area only. Use it to find which skill fits a task.",
    parameters: { type: "object", properties: { area: { type: "string" } }, additionalProperties: false },
    async execute(params, ctx) {
      const { area } = skillAreasInput.parse(params);
      const useCases = await readUseCases();
      const labels = areaLabels(useCases);
      const rows = await skillRows(ctx.projectId, useCases, await readAssignments());
      const wanted = area?.trim().toLowerCase();
      const sections: string[] = [];
      for (const [id, label] of labels) {
        if (wanted !== undefined && wanted !== "" && id.toLowerCase() !== wanted && label.toLowerCase() !== wanted) continue;
        const inArea = rows.filter((row) => row.useCaseId === id);
        if (inArea.length === 0) continue;
        const lines = inArea.map((row) => "- " + row.name + ": " + (row.description ?? "").replace(/\s+/gu, " ").slice(0, 100));
        sections.push(label + " (" + id + ")\n" + lines.join("\n"));
      }
      return sections.length === 0 ? "No skills found." : sections.join("\n\n");
    },
  });

  sandy.agents.registerTool({
    name: "skill_flows",
    description:
      "List the user's saved skill flows: ordered sequences of skills for a use case. Pass flow (name or id) to get one flow, or area to filter by use-case area. Follow the steps in order when the user asks to run a flow.",
    parameters: {
      type: "object",
      properties: { flow: { type: "string" }, area: { type: "string" } },
      additionalProperties: false,
    },
    async execute(params) {
      const { flow, area } = skillFlowsInput.parse(params);
      const labels = areaLabels(await readUseCases());
      const wantedFlow = flow?.trim().toLowerCase();
      const wantedArea = area?.trim().toLowerCase();
      const flows = (await readFlows()).filter((item) => {
        if (wantedFlow !== undefined && wantedFlow !== "" && item.id.toLowerCase() !== wantedFlow && item.name.toLowerCase() !== wantedFlow) return false;
        const label = (labels.get(item.useCaseId) ?? "").toLowerCase();
        return wantedArea === undefined || wantedArea === "" || item.useCaseId.toLowerCase() === wantedArea || label === wantedArea;
      });
      if (flows.length === 0) return "No flows found.";
      return flows
        .map((item) => {
          return [item.name + " (" + (labels.get(item.useCaseId) ?? item.useCaseId) + ", id " + item.id + ")", item.description, ...flowStepLines(item, "")]
            .filter((line) => line !== "")
            .join("\n");
        })
        .join("\n\n");
    },
  });

  sandy.ui.registerMentionProvider({
    id: FLOW_PROVIDER_ID,
    label: "Flows",
    triggers: ["~"],
    async search(ctx) {
      const wanted = ctx.query.trim().toLowerCase();
      return (await readFlows())
        .filter((flow) => wanted === "" || flow.name.toLowerCase().includes(wanted) || flow.id.toLowerCase().includes(wanted))
        .map((flow) => ({
          id: flow.id,
          title: flow.name,
          subtitle: flowSkillNames(flow).join(" > "),
          icon: "GitBranch",
        }));
    },
    async resolve(itemId) {
      const flow = (await readFlows()).find((item) => item.id === itemId);
      if (flow === undefined) throw new Error("The flow no longer exists: " + itemId);
      return { context: flowRunText(flow) };
    },
  });

  sandy.agents.configure(() => ({
    tools: ["skill_areas", "skill_flows"],
    skills: [],
    instructions:
      "The user sorts skills into use-case areas and ordered flows. Call skill_areas to find the right skill for a task and skill_flows when the user names a flow or asks for a workflow.",
  }));
}
