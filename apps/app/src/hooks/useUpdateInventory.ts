import { useMemo } from "react";
import type { Host } from "@sandy/domain";
import {
  usePluginList,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import { pluginHasUpdateSurfaces } from "@/components/plugin/management/PluginUpdatesCard";
import { pluginsNeedingAttention } from "@/hooks/usePluginAttention";
import { selectPrimaryHost, useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { hostCanRetryUpdate } from "@/lib/host-update-status";

export interface UpdateInventoryMachine {
  host: Host;
  isPrimary: boolean;
  canRetryDaemonUpdate: boolean;
}

export type UpdateInventoryPlugin =
  | { kind: "update"; plugin: PluginListItem; version: string }
  | {
      kind: "blocked";
      plugin: PluginListItem;
      version: string;
      reasons: string[];
    };

export interface UpdateInventoryPlugins {
  trackedCount: number;
  items: UpdateInventoryPlugin[];
}

export interface UpdateInventory {
  isLoading: boolean;
  machines: UpdateInventoryMachine[];
  plugins: UpdateInventoryPlugins | null;
  pluginAttentionCount: number;
  actionableCount: number;
  hasAttention: boolean;
}

interface UseUpdateInventoryOptions {
  enabled?: boolean;
}

export function buildUpdateInventoryPlugins(
  plugins: readonly PluginListItem[],
): UpdateInventoryPlugins {
  const tracked = plugins.filter(
    (plugin) =>
      pluginHasUpdateSurfaces(plugin) &&
      plugin.updateState.outcome !== "pinned",
  );
  const items = tracked.flatMap((plugin): UpdateInventoryPlugin[] => {
    const { availableLabel, blockedLabel, blockedReasons } = plugin.updateState;
    if (availableLabel !== null) {
      return [{ kind: "update", plugin, version: availableLabel }];
    }
    if (blockedLabel !== null) {
      return [
        {
          kind: "blocked",
          plugin,
          version: blockedLabel,
          reasons: blockedReasons,
        },
      ];
    }
    return [];
  });
  items.sort((a, b) =>
    (a.plugin.name ?? a.plugin.id).localeCompare(b.plugin.name ?? b.plugin.id),
  );
  return { trackedCount: tracked.length, items };
}

export function updateInventoryHosts(hosts: readonly Host[]): Host[] {
  return hosts.filter((host) => host.type !== "ephemeral");
}

export function useUpdateInventory(
  options?: UseUpdateInventoryOptions,
): UpdateInventory {
  const enabled = options?.enabled ?? true;
  const systemConfigQuery = useSystemConfig({ enabled });
  const hostsQuery = useHosts({ enabled });
  const installedPlugins = usePluginList({ enabled }).data?.plugins;
  const pluginAttentionCount = pluginsNeedingAttention(
    installedPlugins ?? [],
  ).length;
  const pluginUpdatesEnabled =
    systemConfigQuery.data?.experiments.pluginUpdates === true;
  const plugins = useMemo(
    () =>
      pluginUpdatesEnabled
        ? buildUpdateInventoryPlugins(installedPlugins ?? [])
        : null,
    [installedPlugins, pluginUpdatesEnabled],
  );

  const hosts = useMemo(() => hostsQuery.data ?? [], [hostsQuery.data]);
  const updateHosts = updateInventoryHosts(hosts);
  const primaryHostId =
    selectPrimaryHost(hosts, systemConfigQuery.data?.primaryHostId ?? null)
      ?.id ?? null;

  const machines: UpdateInventoryMachine[] = updateHosts.map((host) => {
    return {
      host,
      isPrimary: host.id === primaryHostId,
      canRetryDaemonUpdate: hostCanRetryUpdate(host),
    };
  });

  const actionableCount =
    machines.reduce(
      (count, machine) => count + (machine.canRetryDaemonUpdate ? 1 : 0),
      0,
    ) +
    (plugins?.items.filter((item) => item.kind === "update").length ?? 0) +
    pluginAttentionCount;

  return {
    isLoading: hostsQuery.isPending,
    machines,
    plugins,
    pluginAttentionCount,
    actionableCount,
    hasAttention: actionableCount > 0,
  };
}
