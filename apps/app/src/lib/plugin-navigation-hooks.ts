import { useCallback, useContext, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import type {
  SandyNavigate,
  ExperimentalLiveFileTarget,
  PluginBrowserSandySdk,
} from "@sandy-sdk/plugin-sdk";
import { getMessageLinkPath } from "@sandy/client-core";
import { PERSONAL_PROJECT_ID } from "@sandy/domain";
import { usePluginId } from "@/components/plugin/plugin-context";
import { SandyHttpError, sdk } from "@/lib/sdk";
import { getPluginBoundSdk } from "@/lib/plugin-bound-sdk";
import {
  AUTOMATIONS_PLUGIN_ID,
  getPluginPanelRoutePath,
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
  AUTOMATION_EDIT_ROUTE_PATH,
} from "@/lib/route-paths";
import { RouteNavigationCallbackContext } from "@/components/ui/app-route-anchor";
import { useStore } from "jotai";
import { useIsCompactViewport } from "@sandy/shared-ui/hooks/use-compact-viewport";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { lookupCachedThread } from "@/lib/cached-thread";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import {
  normalizeExperimentalFileOpenOptions,
  normalizeExperimentalLiveFileTarget,
} from "@/lib/live-file-navigation";
import {
  createPluginPanelController,
  createRetiredOpenPanel,
} from "@/lib/plugin-panel-controller";
import { useCanOpenFileExternally } from "@/hooks/useCanOpenFileExternally";

export function isAutomationEditRoutePath(pathname: string): boolean {
  return (
    matchPath({ path: AUTOMATION_EDIT_ROUTE_PATH, end: true }, pathname) !==
    null
  );
}

export function useSdk(): PluginBrowserSandySdk {
  const pluginId = usePluginId();
  const queryClient = useQueryClient();
  return getPluginBoundSdk(sdk, pluginId, queryClient);
}

export function usePluginCanOpenFileExternally(
  target: ExperimentalLiveFileTarget,
): boolean {
  return useCanOpenFileExternally(normalizeExperimentalLiveFileTarget(target));
}

export function useSandyNavigate(): SandyNavigate {
  const pluginId = usePluginId();
  const onNavigate = useContext(RouteNavigationCallbackContext);
  const location = useLocation();
  const navigate = useNavigate();
  const appNavigation = useAppNavigationHost();
  const store = useStore();
  const queryClient = useQueryClient();
  const isCompact = useIsCompactViewport();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const toThread = useCallback<SandyNavigate["toThread"]>(
    (threadId, options) => {
      onNavigate?.();
      const messageSeq = options?.experimental_messageSeq;
      const open = (projectId: string) => {
        store.set(getThreadConversationCollapsedAtom(threadId), false);
        if (options?.split) {
          openThreadInSplit({
            store,
            navigate,
            projectId,
            threadId,
            isCompact,
            ...(messageSeq === undefined ? {} : { messageSeq }),
          });
          return;
        }
        void navigate(
          messageSeq === undefined
            ? getThreadRoutePath({ projectId, threadId })
            : getMessageLinkPath({ projectId, threadId, seq: messageSeq }),
        );
      };
      const cached = lookupCachedThread(queryClient, threadId);
      if (cached !== null) {
        open(cached.projectId);
        return;
      }
      void sdk.threads
        .get({ threadId })
        .then((thread) => open(thread.projectId))
        .catch(() =>
          navigate(
            messageSeq === undefined
              ? `/threads/${threadId}`
              : getMessageLinkPath({
                  projectId: PERSONAL_PROJECT_ID,
                  threadId,
                  seq: messageSeq,
                }),
          ),
        );
    },
    [isCompact, navigate, onNavigate, queryClient, store],
  );
  const toProject = useCallback(
    (projectId: string) => {
      onNavigate?.();
      void navigate(getProjectComposeRoutePath(projectId));
    },
    [navigate, onNavigate],
  );
  const toPluginPanel = useCallback(
    (path: string, options?: { subPath?: string; replace?: boolean }) => {
      const route = getPluginPanelRoutePath({
        pluginId,
        path,
        ...(options?.subPath !== undefined ? { subPath: options.subPath } : {}),
      });
      onNavigate?.();
      void navigate(route, options?.replace ? { replace: true } : undefined);
    },
    [navigate, onNavigate, pluginId],
  );
  const toCompose = useCallback<SandyNavigate["toCompose"]>(
    (options) => {
      const replacesAutomationEditRoute =
        pluginId === AUTOMATIONS_PLUGIN_ID &&
        isAutomationEditRoutePath(location.pathname);
      if (options?.projectId !== undefined) {
        setRootComposeProjectId(options.projectId);
      }
      const hostId = options?.hostId?.trim() ?? "";
      onNavigate?.();
      void navigate(getRootComposeRoutePath(), {
        ...(replacesAutomationEditRoute ? { replace: true } : {}),
        state: {
          focusPrompt: options?.focusPrompt ?? false,
          initialPrompt: options?.initialPrompt ?? "",
          ...(options?.placement !== undefined
            ? { placement: options.placement }
            : {}),
          ...(options?.environmentId !== undefined
            ? { reuseEnvironmentId: options.environmentId }
            : {}),
          ...(hostId.length > 0 ? { newEnvironmentHostId: hostId } : {}),
          ...(replacesAutomationEditRoute
            ? { replaceInitialPrompt: true }
            : {}),
        },
      });
    },
    [
      location.pathname,
      navigate,
      onNavigate,
      pluginId,
      setRootComposeProjectId,
    ],
  );
  const openThreadPanel = useMemo(
    () =>
      createRetiredOpenPanel(
        createPluginPanelController(pluginId, () => appNavigation.panel),
      ),
    [appNavigation.panel, pluginId],
  );
  const openUrl = useCallback<SandyNavigate["openUrl"]>(
    (url) => appNavigation.openUrl({ url }),
    [appNavigation],
  );
  const experimental_openFilePreview = useCallback<
    SandyNavigate["experimental_openFilePreview"]
  >(
    (options) => {
      const normalized = normalizeExperimentalFileOpenOptions(options);
      return normalized !== null && appNavigation.openFilePreview(normalized);
    },
    [appNavigation],
  );
  const experimental_openFileExternally = useCallback<
    SandyNavigate["experimental_openFileExternally"]
  >(
    (options) => {
      const normalized = normalizeExperimentalFileOpenOptions(options);
      return (
        normalized !== null && appNavigation.openFileExternally(normalized)
      );
    },
    [appNavigation],
  );
  const experimental_openTerminal = useCallback<
    SandyNavigate["experimental_openTerminal"]
  >(
    async ({ terminalId }) => {
      const session = await sdk.terminals
        .get({ terminalId })
        .catch((error: unknown) => {
          if (error instanceof SandyHttpError && error.status === 404) return null;
          throw error;
        });
      return session !== null && appNavigation.openTerminal(session);
    },
    [appNavigation],
  );
  return useMemo<SandyNavigate & { openThreadPanel: typeof openThreadPanel }>(
    () => ({
      toThread,
      toProject,
      toPluginPanel,
      toCompose,
      openThreadPanel,
      experimental_openFileExternally,
      experimental_openFilePreview,
      experimental_openTerminal,
      openUrl,
    }),
    [
      toThread,
      toProject,
      toPluginPanel,
      toCompose,
      openThreadPanel,
      experimental_openFileExternally,
      experimental_openFilePreview,
      experimental_openTerminal,
      openUrl,
    ],
  );
}
