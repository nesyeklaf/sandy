import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import {
  assignmentsPrompt,
  assignmentsReplySchema,
  askJson,
  flowPrompt,
  flowReplySchema,
} from "./ai.ts";
import { readIo } from "./skill-io.ts";
import { newSkillSource } from "./skill-file.ts";
import { formatProblem, parseSkill } from "@sandy/skill-dialect";
import { check, hasErrors, type Problem } from "./check.ts";
import { CHANGED_EVENT, FLOW_PROVIDER_ID, MAX_USE_CASES, rpcContract, skillInfo, useCaseSchema, type SkillFlowError, type SkillRow } from "./contract.ts";
import { flowToSkill, skillName, skillToFlow, type Positions } from "./skill-flow.ts";
import { flowRunText, flowSkillNames, flowStepLines, slug as skillSlug, storedFlowSchema, upgradeFlow, type Flow, type FlowStep } from "./graph.ts";
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
const SKILLS_FRESH_MS = 5000;
const POSITIONS_KEY = "positions";

const storedUseCases = z.array(useCaseSchema);
const storedAssignments = z.record(z.string(), z.string());
const storedFlows = z.array(storedFlowSchema);
const storedPositions = z.record(z.string(), z.record(z.string(), z.object({ x: z.number(), y: z.number() })));
const skillMetadata = z
  .object({ inputs: z.string().optional().catch(undefined), outputs: z.string().optional().catch(undefined), dialect: z.string().optional().catch(undefined) })
  .catch({});
const skillAreasInput = z.object({ area: z.string().optional() });
const skillFlowsInput = z.object({ flow: z.string().optional(), area: z.string().optional() });
const flowTrackInput = z.object({ flow: z.string().min(1) });

function problemText(problem: Problem): string {
  const fixes = problem.fixes.length === 0 ? "" : " (fix in the editor: " + problem.fixes.map((fix) => fix.label).join(", ") + ")";
  return "- " + problem.message + fixes;
}

function positionsOf(flow: Flow): Positions {
  return Object.fromEntries(flow.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
}

function freeName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = base.slice(0, 60) + "-" + String(n);
  return name;
}

type CachedSkill = { revision: string; generated: string; useCaseId: string };
type SkillFile = { revision: string; content: string; filePath: string; writable: boolean };
type ListedSkill = Awaited<ReturnType<SandyPluginApi["sdk"]["skills"]["list"]>>["skills"][number];

const READ_BATCH = 8;

function slug(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 30) || "area";
  let id = base;
  for (let n = 2; taken.has(id) || id === FALLBACK_ID; n += 1) id = base + "-" + n;
  return id;
}

type ListedSkills = Awaited<ReturnType<SandyPluginApi["sdk"]["skills"]["list"]>>;

export default async function plugin(sandy: SandyPluginApi) {
  const listedByProject = new Map<string, { listed: ListedSkills; at: number }>();
  const listInFlight = new Map<string, Promise<ListedSkills>>();
  let listGeneration = 0;

  function invalidateListed() {
    listGeneration += 1;
    listedByProject.clear();
    listInFlight.clear();
  }

  function fetchListed(projectId: string): Promise<ListedSkills> {
    const running = listInFlight.get(projectId);
    if (running !== undefined) return running;
    const generation = listGeneration;
    const request = sandy.sdk.skills.list({ projectId, environmentId: null }).then(
      (listed) => {
        if (generation === listGeneration) {
          listedByProject.set(projectId, { listed, at: Date.now() });
          listInFlight.delete(projectId);
        }
        return listed;
      },
      (cause: unknown) => {
        if (generation === listGeneration) listInFlight.delete(projectId);
        throw cause;
      },
    );
    listInFlight.set(projectId, request);
    return request;
  }

  function refreshListed(projectId: string, previous: ListedSkills) {
    fetchListed(projectId).then(
      (listed) => {
        if (JSON.stringify(listed) !== JSON.stringify(previous)) changed();
      },
      () => undefined,
    );
  }

  async function listedSkills(projectId: string, staleOk: boolean): Promise<ListedSkills> {
    const cached = listedByProject.get(projectId);
    if (cached === undefined) return fetchListed(projectId);
    const age = Date.now() - cached.at;
    if (age <= SKILLS_FRESH_MS) return cached.listed;
    if (!staleOk) return fetchListed(projectId);
    if (!listInFlight.has(projectId)) refreshListed(projectId, cached.listed);
    return cached.listed;
  }

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

  const skillCache = new Map<string, CachedSkill>();
  const fileCache = new Map<string, SkillFile>();

  async function skillFile(projectId: string, skill: Pick<ListedSkill, "id" | "revision">): Promise<SkillFile> {
    const cached = fileCache.get(skill.id);
    if (cached !== undefined && skill.revision !== null && cached.revision === skill.revision) return cached;
    const file = await sandy.sdk.skills.experimental_read({ projectId, environmentId: null, skillId: skill.id });
    const read = { revision: file.revision, content: file.content, filePath: file.filePath, writable: file.writable };
    fileCache.set(skill.id, read);
    return read;
  }

  async function skillFiles(projectId: string, skills: readonly ListedSkill[]): Promise<Map<string, SkillFile | Error>> {
    const out = new Map<string, SkillFile | Error>();
    for (let index = 0; index < skills.length; index += READ_BATCH) {
      const batch = skills.slice(index, index + READ_BATCH);
      const results = await Promise.allSettled(batch.map((skill) => skillFile(projectId, skill)));
      batch.forEach((skill, at) => {
        const result = results[at];
        if (result === undefined) return;
        out.set(skill.id, result.status === "fulfilled" ? result.value : result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      });
    }
    return out;
  }

  async function readPositions(): Promise<Record<string, Positions>> {
    const parsed = storedPositions.safeParse(await sandy.storage.kv.get(POSITIONS_KEY));
    return parsed.success ? parsed.data : {};
  }

  async function skillFlows(projectId: string, rows: SkillRow[], files: ReadonlyMap<string, SkillFile | Error>): Promise<{ flows: Flow[]; errors: SkillFlowError[] }> {
    const positions = await readPositions();
    const infos = rows.map(skillInfo);
    const flows: Flow[] = [];
    const errors: SkillFlowError[] = [];
    for (const row of rows) {
      if (!row.dialect) continue;
      const file = files.get(row.id) ?? (await skillFile(projectId, { id: row.id, revision: null }).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))));
      if (file instanceof Error) {
        errors.push({ skillId: row.id, name: row.name, problems: [file.message] });
        continue;
      }
      const result = skillToFlow(file.content, infos, { useCaseId: row.useCaseId, positions: positions[row.name] });
      if (!result.ok) {
        errors.push({ skillId: row.id, name: row.name, problems: result.problems.map(formatProblem) });
        continue;
      }
      const flow: Flow = {
        ...result.flow,
        id: row.name,
        origin: { skillId: row.id, revision: file.revision, filePath: file.filePath, writable: file.writable && row.writable },
      };
      skillCache.set(row.id, { revision: file.revision, generated: flowToSkill(flow), useCaseId: row.useCaseId });
      flows.push(flow);
    }
    return { flows, errors };
  }

  async function allFlows(projectId: string | null, staleOk = false): Promise<{ flows: Flow[]; errors: SkillFlowError[]; rows: SkillRow[] }> {
    const legacy = await readFlows();
    const selected = await resolveProjectId(projectId);
    if (selected === null) return { flows: legacy, errors: [], rows: [] };
    const { rows, files } = await skillRows(selected, await readUseCases(), await readAssignments(), staleOk);
    const fromSkills = await skillFlows(selected, rows, files);
    const names = new Set(fromSkills.flows.map((flow) => flow.id));
    return { flows: [...fromSkills.flows, ...legacy.filter((flow) => !names.has(flow.id))], errors: fromSkills.errors, rows };
  }

  async function listProjects() {
    return (await sandy.sdk.projects.list()).map((project) => ({ id: project.id, name: project.name }));
  }

  async function resolveProjectId(projectId: string | null): Promise<string | null> {
    const projects = await listProjects();
    return (projects.find((project) => project.id === projectId) ?? projects[0])?.id ?? null;
  }

  async function skillRows(
    projectId: string,
    useCases: UseCase[],
    assignments: Record<string, string>,
    staleOk = false,
  ): Promise<{ rows: SkillRow[]; files: Map<string, SkillFile | Error> }> {
    const listed = await listedSkills(projectId, staleOk);
    const unique = listed.skills.filter((skill, index) => listed.skills.findIndex((other) => other.name === skill.name) === index);
    const files = await skillFiles(projectId, unique);
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
      const metadata = skillMetadata.parse(skill.metadata);
      const file = files.get(skill.id);
      const io = readIo(file === undefined || file instanceof Error ? "" : file.content, metadata);
      rows.push({
        id: skill.id,
        name: skill.name,
        writable: skill.writable,
        description: skill.description,
        scope: skill.scope,
        provider: skill.provider,
        useCaseId,
        manual,
        sources: [...(sourcesByName.get(skill.name) ?? [])].sort(),
        inputs: io.inputs,
        outputs: io.outputs,
        ioErrors: io.errors,
        dialect: metadata.dialect !== undefined,
      });
    }
    return { rows: rows.sort((a, b) => a.name.localeCompare(b.name)), files };
  }

  function changed() {
    sandy.realtime.publish(CHANGED_EVENT, {});
  }

  function areaLabels(useCases: UseCase[]): Map<string, string> {
    return new Map([...useCases.map((useCase) => [useCase.id, useCase.label] as const), [FALLBACK_ID, FALLBACK_LABEL]]);
  }

  sandy.rpc.register(rpcContract, {
    async state({ projectId }) {
      const projects = await listProjects();
      const selected = (projects.find((project) => project.id === projectId) ?? projects[0])?.id ?? null;
      const all = await allFlows(selected, true);
      return {
        projects,
        projectId: selected,
        useCases: await readUseCases(),
        fallbackId: FALLBACK_ID,
        fallbackLabel: FALLBACK_LABEL,
        skills: all.rows,
        flows: all.flows,
        skillFlowErrors: all.errors,
      };
    },
    async overview({ projectId }) {
      return {
        useCases: await readUseCases(),
        fallbackId: FALLBACK_ID,
        fallbackLabel: FALLBACK_LABEL,
        flows: (await allFlows(projectId, true)).flows,
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
    async saveFlows({ projectId, flows }) {
      const useCases = await readUseCases();
      const known = new Set([FALLBACK_ID, ...useCases.map((useCase) => useCase.id)]);
      const ids = new Set(flows.map((flow) => flow.id));
      if (ids.size !== flows.length || flows.some((flow) => !known.has(flow.useCaseId))) return { ok: false, revisions: {}, conflicts: [] };
      await sandy.storage.kv.set(
        FLOWS_KEY,
        flows.filter((flow) => flow.origin === undefined),
      );
      const revisions: Record<string, string> = {};
      const conflicts: string[] = [];
      if (flows.some((flow) => flow.origin !== undefined)) {
        const selected = await resolveProjectId(projectId);
        const positions = await readPositions();
        const assignments = await readAssignments();
        for (const flow of flows) {
          const origin = flow.origin;
          if (origin === undefined) continue;
          positions[flow.id] = positionsOf(flow);
          const cached = skillCache.get(origin.skillId);
          if (cached !== undefined && cached.useCaseId !== flow.useCaseId) {
            assignments[flow.id] = flow.useCaseId;
            skillCache.set(origin.skillId, { ...cached, useCaseId: flow.useCaseId });
          }
          const content = flowToSkill(flow);
          if (selected === null || !origin.writable || (cached !== undefined && cached.revision === origin.revision && cached.generated === content)) continue;
          const result = await sandy.sdk.skills.experimental_write({ projectId: selected, environmentId: null, skillId: origin.skillId, content, revision: origin.revision });
          if (result.outcome === "conflict") {
            conflicts.push(flow.id);
            continue;
          }
          revisions[origin.skillId] = result.revision;
          skillCache.set(origin.skillId, { revision: result.revision, generated: content, useCaseId: flow.useCaseId });
        }
        await sandy.storage.kv.set(POSITIONS_KEY, positions);
        await sandy.storage.kv.set(ASSIGNMENTS_KEY, assignments);
      }
      if (Object.keys(revisions).length > 0) invalidateListed();
      changed();
      return { ok: conflicts.length === 0, revisions, conflicts };
    },
    async createFlowSkill({ projectId, flow, scope, legacyId }) {
      const selected = await resolveProjectId(projectId);
      if (selected === null) throw new Error("No project available.");
      const listed = await sandy.sdk.skills.list({ projectId: selected, environmentId: null });
      const name = freeName(skillName({ id: "", name: flow.name }), new Set(listed.skills.map((skill) => skill.name)));
      const named: Flow = { ...flow, id: name, origin: undefined, frontmatter: undefined };
      const result = await sandy.sdk.skills.experimental_create({ projectId: selected, environmentId: null, scope, name, content: flowToSkill(named) });
      if (result.outcome === "conflict") return { outcome: "conflict" as const, flowId: name };
      invalidateListed();
      const positions = await readPositions();
      positions[name] = positionsOf(flow);
      await sandy.storage.kv.set(POSITIONS_KEY, positions);
      const assignments = await readAssignments();
      assignments[name] = flow.useCaseId;
      await sandy.storage.kv.set(ASSIGNMENTS_KEY, assignments);
      if (legacyId !== null) await sandy.storage.kv.set(FLOWS_KEY, (await readFlows()).filter((item) => item.id !== legacyId));
      changed();
      return { outcome: "written" as const, flowId: name, filePath: result.filePath };
    },
    async createSkill({ projectId, scope, name, description, useCaseId }) {
      const selected = await resolveProjectId(projectId);
      if (selected === null) throw new Error("No project available.");
      const folder = skillSlug(name, "skill");
      const result = await sandy.sdk.skills.experimental_create({ projectId: selected, environmentId: null, scope, name: folder, content: newSkillSource(folder, description.trim()) });
      if (result.outcome === "conflict") return { outcome: "conflict" as const, name: folder };
      invalidateListed();
      if (useCaseId !== null) {
        const assignments = await readAssignments();
        assignments[folder] = useCaseId;
        await sandy.storage.kv.set(ASSIGNMENTS_KEY, assignments);
      }
      changed();
      return { outcome: "written" as const, name: folder, filePath: result.filePath };
    },
    async deleteFlowSkill({ projectId, skillId }) {
      const selected = await resolveProjectId(projectId);
      if (selected === null) return { ok: false };
      await sandy.sdk.skills.remove({ projectId: selected, environmentId: null, skillId });
      skillCache.delete(skillId);
      invalidateListed();
      changed();
      return { ok: true };
    },
    async readSkill({ projectId, skillId, path }) {
      const file = await sandy.sdk.skills.getContent({ projectId, environmentId: null, skillId, path });
      return { content: file.content, revision: file.revision, filePath: file.filePath, writable: file.writable };
    },
    async listSkillFiles({ projectId, skillId }) {
      const listed = await sandy.sdk.skills.listFiles({ projectId, environmentId: null, skillId });
      return { files: listed.files, truncated: listed.truncated };
    },
    async writeSkill({ projectId, skillId, path, content, revision }) {
      const result = await sandy.sdk.skills.experimental_write({ projectId, environmentId: null, skillId, path, content, revision });
      if (result.outcome === "written") {
        invalidateListed();
        changed();
      }
      return result;
    },
    async recommendAssignments({ projectId }) {
      const selected = await resolveProjectId(projectId);
      if (selected === null) throw new Error("No project available.");
      const useCases = await readUseCases();
      const rows = (await skillRows(selected, useCases, await readAssignments())).rows.filter((row) => !row.manual);
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
      const { rows } = await skillRows(selected, useCases, await readAssignments());
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
      const { rows } = await skillRows(ctx.projectId, useCases, await readAssignments());
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
    async execute(params, ctx) {
      const { flow, area } = skillFlowsInput.parse(params);
      const labels = areaLabels(await readUseCases());
      const wantedFlow = flow?.trim().toLowerCase();
      const wantedArea = area?.trim().toLowerCase();
      const flows = (await allFlows(ctx.projectId)).flows.filter((item) => {
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

  sandy.agents.registerTool({
    name: "flow_track",
    description:
      "Find how to run one of the user's saved skill flows (name or id) as a track. A flow saved as a skill returns the stage_start({skill, note}) call to make. A flow not yet saved as a skill returns its track machine as JSON for stage_start({machine, note}). Returns the problems that block the run as an error.",
    presentation: { label: { pending: "Compiling flow", completed: "Compiled flow" } },
    parameters: { type: "object", properties: { flow: { type: "string" } }, required: ["flow"], additionalProperties: false },
    async execute(params, ctx) {
      const wanted = flowTrackInput.parse(params).flow.trim().toLowerCase();
      const all = await allFlows(ctx.projectId);
      const broken = all.errors.find((item) => item.name.toLowerCase() === wanted);
      if (broken !== undefined)
        return { content: [{ type: "text", text: 'The skill "' + broken.name + '" does not parse as a flow:\n' + broken.problems.map((line) => "- " + line).join("\n") }], isError: true };
      const flow = all.flows.find((item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
      if (flow === undefined) return { content: [{ type: "text", text: "No flow named " + JSON.stringify(wanted) + ". Call skill_flows to list the saved flows." }], isError: true };
      const refuse = (lines: string[]) => ({
        content: [{ type: "text" as const, text: 'The flow "' + flow.name + '" cannot run as a track yet. Fix these problems in the flow editor first:\n' + lines.join("\n") }],
        isError: true,
      });
      const problems = check(flow, all.rows.map(skillInfo));
      if (hasErrors(problems)) return refuse(problems.filter((problem) => problem.severity === "error").map(problemText));
      if (flow.origin !== undefined)
        return "The flow " + JSON.stringify(flow.name) + " is the skill " + JSON.stringify(flow.id) + ". Call stage_start({skill: " + JSON.stringify(flow.id) + ', note: "Flow ' + flow.name + '"}) to run it.';
      const parsed = parseSkill(flowToSkill(flow), "SKILL.md");
      if (!parsed.ok) return refuse(parsed.problems.map((problem) => "- " + formatProblem(problem)));
      return JSON.stringify(parsed.machine, null, 2);
    },
  });

  sandy.ui.registerMentionProvider({
    id: FLOW_PROVIDER_ID,
    label: "Flows",
    triggers: ["~"],
    async search(ctx) {
      const wanted = ctx.query.trim().toLowerCase();
      return (await allFlows(ctx.projectId)).flows
        .filter((flow) => wanted === "" || flow.name.toLowerCase().includes(wanted) || flow.id.toLowerCase().includes(wanted))
        .map((flow) => ({
          id: flow.id,
          title: flow.name,
          subtitle: flowSkillNames(flow).join(" > "),
          icon: "GitBranch",
        }));
    },
    async resolve(itemId) {
      const flow = (await allFlows(null)).flows.find((item) => item.id === itemId);
      if (flow === undefined) throw new Error("The flow no longer exists: " + itemId);
      return { context: flowRunText(flow) };
    },
  });

  sandy.agents.configure(() => ({
    tools: ["skill_areas", "skill_flows", "flow_track"],
    skills: [],
    instructions:
      "The user sorts skills into use-case areas and flows. Call skill_areas to find the right skill for a task and skill_flows when the user names a flow or asks for a workflow. To run a flow, call flow_track for it and follow what it returns: stage_start with the flow's skill, or with the returned machine for a flow not yet saved as a skill.",
  }));
}
