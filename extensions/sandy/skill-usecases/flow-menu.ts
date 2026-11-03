import type { ExperimentalComposerMenuItem, PluginComposerApi } from "@sandy-sdk/plugin-sdk/app";
import { FLOW_PROVIDER_ID, type Flow, type SkillOverview } from "./contract.ts";

export function flowMenuItems(source: SkillOverview | null, query: string): ExperimentalComposerMenuItem[] {
  if (source === null) return [];
  const wanted = query.trim().toLowerCase();
  const row = (flow: Flow): ExperimentalComposerMenuItem => ({
    id: flow.id,
    label: flow.name,
    description: flow.steps.map((step) => step.skill).join(" > "),
    icon: "GitBranch",
    run: ({ composer }: { composer: PluginComposerApi }) => {
      composer.insert({ provider: FLOW_PROVIDER_ID, id: flow.id, label: flow.name });
    },
  });
  if (wanted !== "") {
    return source.flows
      .filter((flow) => flow.name.toLowerCase().includes(wanted) || flow.description.toLowerCase().includes(wanted))
      .map(row);
  }
  const areas = [...source.useCases, { id: source.fallbackId, label: source.fallbackLabel, keywords: [] }];
  const known = new Set(areas.map((area) => area.id));
  return areas.flatMap((area) => {
    const flows = source.flows.filter((flow) => flow.useCaseId === area.id || (area.id === source.fallbackId && !known.has(flow.useCaseId)));
    return flows.length === 0 ? [] : [{ id: area.id, label: area.label, description: String(flows.length), icon: "Folder", items: flows.map(row) }];
  });
}
