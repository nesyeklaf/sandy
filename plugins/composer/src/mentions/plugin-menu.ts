import type {
  ExperimentalComposerMenuContribution,
  ExperimentalComposerMenuItem,
  ExperimentalComposerMenuTrigger,
} from "@sandy-sdk/plugin-sdk/app";
import type {
  PluginMenuGroup,
  PluginMenuSuggestion,
} from "./typeahead-suggestions";

export interface PluginMenuPath {
  contributionKey: string;
  ids: readonly string[];
}

export interface PluginMenuView {
  groups: readonly PluginMenuGroup[];
  breadcrumb: readonly string[];
}

const EMPTY_VIEW: PluginMenuView = { groups: [], breadcrumb: [] };

function suggestion(
  contribution: ExperimentalComposerMenuContribution,
  parents: readonly string[],
  item: ExperimentalComposerMenuItem,
): PluginMenuSuggestion {
  return {
    kind: "menu",
    key: JSON.stringify(["menu", contribution.key, ...parents, item.id]),
    contribution,
    item,
    path: parents,
  };
}

function safeItems(
  read: () => readonly ExperimentalComposerMenuItem[],
  contribution: ExperimentalComposerMenuContribution,
): readonly ExperimentalComposerMenuItem[] {
  try {
    return read();
  } catch (error) {
    console.error(
      `[plugin:${contribution.pluginId}] composer menu "${contribution.menu.id}" failed`,
      error,
    );
    return [];
  }
}

function matchesQuery(item: ExperimentalComposerMenuItem, query: string) {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || item.label.toLowerCase().includes(needle);
}

function walk(
  contribution: ExperimentalComposerMenuContribution,
  ids: readonly string[],
): { items: readonly ExperimentalComposerMenuItem[]; labels: string[] } | null {
  let items = safeItems(() => contribution.menu.items(""), contribution);
  const labels: string[] = [];
  for (const id of ids) {
    const parent = items.find((candidate) => candidate.id === id);
    if (parent?.items === undefined) return null;
    labels.push(parent.label);
    items = parent.items;
  }
  return { items, labels };
}

export function pluginMenuView(
  menus: readonly ExperimentalComposerMenuContribution[],
  trigger: string,
  query: string,
  path: PluginMenuPath | null,
): PluginMenuView {
  const forTrigger = menus.filter((menu) => menu.menu.trigger === trigger);
  if (forTrigger.length === 0) return EMPTY_VIEW;

  const pathContribution =
    path === null
      ? undefined
      : forTrigger.find((menu) => menu.key === path.contributionKey);
  if (path !== null && pathContribution !== undefined) {
    const resolved = walk(pathContribution, path.ids);
    if (resolved !== null) {
      const suggestions = resolved.items
        .filter((item) => matchesQuery(item, query))
        .map((item) => suggestion(pathContribution, path.ids, item));
      return {
        groups:
          suggestions.length === 0
            ? []
            : [
                {
                  key: pathContribution.key,
                  label: [pathContribution.menu.label, ...resolved.labels].join(
                    " › ",
                  ),
                  suggestions,
                },
              ],
        breadcrumb: [pathContribution.menu.label, ...resolved.labels],
      };
    }
  }

  const groups = forTrigger.flatMap((contribution): PluginMenuGroup[] => {
    const suggestions = safeItems(
      () => contribution.menu.items(query),
      contribution,
    ).map((item) => suggestion(contribution, [], item));
    return suggestions.length === 0
      ? []
      : [
          {
            key: contribution.key,
            label: contribution.menu.label,
            suggestions,
          },
        ];
  });
  return { groups, breadcrumb: [] };
}

export function pluginMenuMentionTriggers(
  menus: readonly ExperimentalComposerMenuContribution[],
): Exclude<ExperimentalComposerMenuTrigger, "/">[] {
  const triggers = new Set<Exclude<ExperimentalComposerMenuTrigger, "/">>();
  for (const { menu } of menus) {
    if (menu.trigger !== "/") triggers.add(menu.trigger);
  }
  return [...triggers];
}

export function childPath(suggestion: PluginMenuSuggestion): PluginMenuPath {
  return {
    contributionKey: suggestion.contribution.key,
    ids: [...suggestion.path, suggestion.item.id],
  };
}

export function parentPath(path: PluginMenuPath): PluginMenuPath | null {
  return path.ids.length <= 1
    ? null
    : { contributionKey: path.contributionKey, ids: path.ids.slice(0, -1) };
}
