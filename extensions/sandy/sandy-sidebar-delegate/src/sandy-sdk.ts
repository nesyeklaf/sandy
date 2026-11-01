import { useMemo } from "react";
import {
  experimental_useRpcKeyedQuery,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
} from "@sandy-sdk/plugin-sdk/app";
import type {
  PluginRpcContract,
  PluginSidebarThread,
  PluginThreadActionsOptions,
  StandardSchemaV1,
} from "@sandy-sdk/plugin-sdk/app";
import { mergeDelegateChildren } from "./delegate-children";
import { useDelegateChildren } from "./useDelegateChildren";
import {
  GITHUB_PR_STATUS_PLUGIN_ID,
  MAX_PULL_REQUEST_KEYS,
  type EnvironmentPullRequest,
  type EnvironmentPullRequestRow,
} from "./github-pr-status";

export {
  experimental_useProviders as useProviders,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_ShortcutHint as ShortcutHint,
} from "@sandy-sdk/plugin-sdk/app";

/**
 * The host's sidebar threads plus the hidden delegate children and workers
 * nested under their parents (see delegate-children.ts). `delegateChildrenLoaded`
 * says whether the server's list has arrived, so callers do not treat a
 * parent's not-yet-loaded children as gone.
 */
export function useSidebarThreads() {
  const state = experimental_useSidebarThreads();
  const delegateChildren = useDelegateChildren();
  const merged = useMemo(
    () => mergeDelegateChildren(state.threads, delegateChildren.children),
    [state.threads, delegateChildren.children],
  );
  // Without delegate children the host's array passes through untouched.
  const threads = delegateChildren.children.length === 0 ? state.threads : merged;
  return useMemo(
    () => ({ ...state, threads, delegateChildrenLoaded: delegateChildren.loaded }),
    [state, threads, delegateChildren.loaded],
  );
}

export function useThreadActions(thread: PluginSidebarThread, options?: PluginThreadActionsOptions) {
  const environment = thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null;
  return experimental_useThreadActions({ ...thread, environment }, options);
}

// The browser bundle stays free of zod, so the GitHub PR Status contract uses
// hand-written Standard Schemas. sandy validates only the input against them;
// rows arrive as the plugin sent them.
function schema<T>(validate: (value: unknown) => value is T): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "sandy-sidebar",
      validate: (value) => (validate(value) ? { value } : { issues: [{ message: "Unexpected value" }] }),
    },
  };
}

const githubPrStatusContract = {
  pullRequests: {
    input: schema(
      (value): value is { keys: string[] } =>
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { keys?: unknown }).keys) &&
        (value as { keys: unknown[] }).keys.every((key) => typeof key === "string"),
    ),
    output: schema(
      (value): value is Record<string, EnvironmentPullRequestRow> => typeof value === "object" && value !== null,
    ),
  },
} satisfies PluginRpcContract;

/**
 * The PR for an environment's checked-out branch, from the bundled GitHub PR
 * Status plugin. A query error, no PR, an unavailable machine, and a disabled
 * plugin all show nothing.
 */
/**
 * The PRs of many environments in one keyed read, for shelf placement. Rows
 * that are absent or unavailable are left out, like in the single-id hook.
 */
function useEnvironmentPullRequests(environmentIds: readonly string[]): ReadonlyMap<string, EnvironmentPullRequest> {
  const keys = useMemo(() => [...new Set(environmentIds)].sort().slice(0, MAX_PULL_REQUEST_KEYS), [environmentIds]);
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusContract,
    method: "pullRequests",
    keys,
  });
  return useMemo(() => {
    const byEnvironment = new Map<string, EnvironmentPullRequest>();
    for (const key of keys) {
      const row = data?.[key];
      if (row?.outcome === "available") byEnvironment.set(key, row.pullRequest);
    }
    return byEnvironment;
  }, [data, keys]);
}

/** The PRs of every environment the given threads run in. */
export function useThreadPullRequestsByEnvironment(threads: readonly Pick<PluginSidebarThread, "environment">[]) {
  const environmentIds = useMemo(
    () => threads.flatMap((thread) => (thread.environment?.id ? [thread.environment.id] : [])),
    [threads],
  );
  return useEnvironmentPullRequests(environmentIds);
}

export function useEnvironmentPullRequest(environmentId: string | null): EnvironmentPullRequest | null {
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusContract,
    method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const row = environmentId ? data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row.pullRequest : null;
}
