import { useEffect } from "react";
import type {
  ExperimentalComposerMenuContribution,
  ExperimentalComposerMenuItem,
  PluginComposerApi,
} from "@sandy-sdk/plugin-sdk";
import { appToast } from "@/components/ui/app-toast";
import { useComposer } from "@/lib/plugin-sdk-hooks";
import { PluginSlotMount } from "./PluginSlotMount";

export interface ComposerMenuComposers {
  register(key: string, composer: PluginComposerApi): () => void;
  get(key: string): PluginComposerApi | undefined;
}

export function createComposerMenuComposers(): ComposerMenuComposers {
  const composers = new Map<string, PluginComposerApi>();
  return {
    register(key, composer) {
      composers.set(key, composer);
      return () => {
        if (composers.get(key) === composer) composers.delete(key);
      };
    },
    get: (key) => composers.get(key),
  };
}

export function runComposerMenuItem(
  composers: ComposerMenuComposers,
  contribution: ExperimentalComposerMenuContribution,
  item: ExperimentalComposerMenuItem,
): void {
  const composer = composers.get(contribution.key);
  if (composer === undefined || item.run === undefined) return;
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[plugin:${contribution.pluginId}] composer menu item "${item.id}" failed: ${message}`,
      error,
    );
    appToast.error("Plugin action failed", { description: message });
  };
  try {
    const result = item.run({ composer });
    if (result instanceof Promise) result.catch(fail);
  } catch (error) {
    fail(error);
  }
}

export function PluginComposerMenuBindings({
  menus,
  composers,
}: {
  menus: readonly ExperimentalComposerMenuContribution[];
  composers: ComposerMenuComposers;
}) {
  return menus.map((contribution) => (
    <PluginSlotMount
      key={contribution.key}
      pluginId={contribution.pluginId}
      slotKind="composerMenu"
      slotId={`${contribution.customizationId}/${contribution.menu.id}`}
      crashFallback={null}
    >
      <PluginComposerMenuBinding
        contributionKey={contribution.key}
        composers={composers}
      />
    </PluginSlotMount>
  ));
}

function PluginComposerMenuBinding({
  contributionKey,
  composers,
}: {
  contributionKey: string;
  composers: ComposerMenuComposers;
}) {
  const composer = useComposer();
  useEffect(
    () => composers.register(contributionKey, composer),
    [composer, composers, contributionKey],
  );
  return null;
}
