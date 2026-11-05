import {
  createContext,
  useContext,
  useMemo,
  type Context,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PluginSidebarThread, useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import type { useSidebarThreads } from "./sandy-sdk";
import type { SidebarProvider } from "./ProviderGlyph";
import { DEFAULT_SIDEBAR_SETTINGS, type SidebarSettingsValues } from "./sidebar-settings";
import type { ConfiguredSnoozePreset } from "./lifecycle";
import type { LifecycleApi } from "./useLifecycle";
import type { ShelfExpansionState } from "./ThreadInboxView";
import { ListAnimationContext, type ListAnimationController } from "./useListMotion";
import { ProjectColorsProvider } from "./ProjectColors";
import { WorkingSinceContext } from "./useWorkingSince";
import { CleanSettledHost } from "./CleanSettledHost";
import { AnswerHoldHost } from "./AnswerHoldHost";
import { SelectionHost } from "./SelectionHost";
import type { RowFields } from "./row-fields";
import type { WorkingSince } from "./working-since";
import { ChildThreadDisplayContext, type ChildThreadDisplay } from "./ChildThreadDisplay";
import { OpenPortsProvider } from "./OpenPorts";
import { LastMessagesProvider } from "./useLastMessages";
import type { ActiveSortMode } from "./inbox-layout";
import type { useRenamingShelfLocks } from "./useRenamingShelfLocks";
import type { UpdateSidebarSettings } from "./useSidebarSettings";
import { useLatestCallback } from "./lib/stable-identity";
import { ActiveThreadContext, useActiveThreadWithin, type ActiveThreadStore } from "./useActiveThread";

interface InboxContextInputs {
  providerById: ReadonlyMap<string, SidebarProvider>;
  projectNameById: ReadonlyMap<string, string>;
  projectIconRevision: number;
  projects: ReturnType<typeof useSidebarThreads>["projects"];
  sidebarSettings: SidebarSettingsValues | null;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  lifecycle: LifecycleApi;
  childrenByParentId: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  rowFields: RowFields;
  now: number;
  navigate: ReturnType<typeof useSandyNavigate>;
  onNavigate: () => void;
  parkThread: (thread: PluginSidebarThread) => void;
  settleThread: (thread: PluginSidebarThread) => void;
  snoozeThread: (thread: PluginSidebarThread, until: number, deferredInteractionId?: string) => void;
  toggleChildExpansion: (threadId: string) => void;
  setRenamingShelfLocks: ReturnType<typeof useRenamingShelfLocks>[1];
  setScope: Dispatch<SetStateAction<string[]>>;
  setExpandedShelves: Dispatch<SetStateAction<ShelfExpansionState>>;
  setActiveSortMode: Dispatch<SetStateAction<ActiveSortMode>>;
  setSettledLimit: Dispatch<SetStateAction<number>>;
  setRowFields: Dispatch<SetStateAction<RowFields>>;
  toggleProjectCollapse: (projectId: string) => void;
  updateSidebarSettings: UpdateSidebarSettings;
}

/** Shared inbox values have separate identities for data, handlers, and activity. */
export function useInboxContextValues({
  providerById,
  projectNameById,
  projectIconRevision,
  projects,
  sidebarSettings,
  snoozePresets,
  lifecycle,
  childrenByParentId,
  rowFields,
  now,
  navigate,
  onNavigate,
  parkThread,
  settleThread,
  snoozeThread,
  toggleChildExpansion,
  setRenamingShelfLocks,
  setScope,
  setExpandedShelves,
  setActiveSortMode,
  setSettledLimit,
  setRowFields,
  toggleProjectCollapse,
  updateSidebarSettings,
}: InboxContextInputs) {
  const environment = useMemo(
    () => ({
      providerById,
      projectNameById,
      projectIconRevision,
      projects,
      sidebarSettings,
      snoozePresets,
      lifecycle,
      childrenByParentId,
      rowFields,
    }),
    [
      providerById,
      projectNameById,
      projectIconRevision,
      projects,
      sidebarSettings,
      snoozePresets,
      lifecycle,
      childrenByParentId,
      rowFields,
    ],
  );
  const stableOnNavigate = useLatestCallback(onNavigate);
  const acknowledgeWake = useLatestCallback((threadId: string) => void lifecycle.acknowledgeWake(threadId));
  const openThread = useLatestCallback((threadId: string) => {
    navigate.toThread(threadId, { split: false });
    onNavigate();
  });
  const actions = useMemo(
    () => ({
      navigate,
      onNavigate: stableOnNavigate,
      parkThread,
      settleThread,
      snoozeThread,
      toggleChildExpansion,
      setRenamingShelfLocks,
      setScope,
      setExpandedShelves,
      setActiveSortMode,
      setSettledLimit,
      setRowFields,
      toggleProjectCollapse,
      updateSidebarSettings,
      acknowledgeWake,
      openThread,
    }),
    [
      navigate,
      stableOnNavigate,
      acknowledgeWake,
      openThread,
      parkThread,
      settleThread,
      snoozeThread,
      toggleChildExpansion,
      setRenamingShelfLocks,
      setScope,
      setExpandedShelves,
      setActiveSortMode,
      setSettledLimit,
      setRowFields,
      toggleProjectCollapse,
      updateSidebarSettings,
    ],
  );
  const activity = useMemo(() => ({ now }), [now]);
  return { environment, actions, activity };
}

type InboxValues = ReturnType<typeof useInboxContextValues>;
const InboxEnvironmentContext = createContext<InboxValues["environment"] | null>(null);
const InboxActionsContext = createContext<InboxValues["actions"] | null>(null);
const InboxActivityContext = createContext<InboxValues["activity"] | null>(null);

export function InboxProvider({
  value,
  activeThread,
  listAnimationController,
  workingSince,
  childDisplay,
  children,
}: {
  value: InboxValues;
  activeThread: ActiveThreadStore;
  listAnimationController: ListAnimationController;
  workingSince: WorkingSince;
  childDisplay: ChildThreadDisplay;
  children: ReactNode;
}) {
  const { sidebarSettings, projects } = value.environment;
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  return (
    <ListAnimationContext.Provider value={listAnimationController}>
      <ProjectColorsProvider
        enabled={sidebarSettings?.projectColorsEnabled === true}
        display={sidebarSettings?.projectColorDisplay ?? DEFAULT_SIDEBAR_SETTINGS.projectColorDisplay}
        projectIds={projectIds}
      >
        <WorkingSinceContext.Provider value={workingSince}>
          <ChildThreadDisplayContext.Provider value={childDisplay}>
            <OpenPortsProvider>
              <LastMessagesProvider enabled={value.environment.rowFields.lastMessage}>
                <InboxEnvironmentContext.Provider value={value.environment}>
                  <InboxActionsContext.Provider value={value.actions}>
                    <InboxActivityContext.Provider value={value.activity}>
                      <ActiveThreadContext.Provider value={activeThread}>
                        <CleanSettledHost onNavigate={value.actions.onNavigate}>
                          <AnswerHoldHost>
                            <SelectionHost>{children}</SelectionHost>
                          </AnswerHoldHost>
                        </CleanSettledHost>
                      </ActiveThreadContext.Provider>
                    </InboxActivityContext.Provider>
                  </InboxActionsContext.Provider>
                </InboxEnvironmentContext.Provider>
              </LastMessagesProvider>
            </OpenPortsProvider>
          </ChildThreadDisplayContext.Provider>
        </WorkingSinceContext.Provider>
      </ProjectColorsProvider>
    </ListAnimationContext.Provider>
  );
}

function requireInboxContext<T>(value: T | null): T {
  if (value === null) throw new Error("Inbox consumers must be inside InboxProvider");
  return value;
}

function useRequiredContext<T>(context: Context<T | null>): T {
  return requireInboxContext(useContext(context));
}

export function useInboxEnvironment() {
  return useRequiredContext(InboxEnvironmentContext);
}

export function useInboxActions() {
  return useRequiredContext(InboxActionsContext);
}

export function useInboxActivity() {
  return useRequiredContext(InboxActivityContext);
}

type ExplicitChildListInputs = {
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  onOpenThread: (threadId: string) => void;
};

export type InboxChildListInputs = {
  now?: number;
  activeThreadId?: string | null;
} & (({ variant: "header" } & ExplicitChildListInputs) | ({ variant: "sidebar" } & Partial<ExplicitChildListInputs>));

/** Header popovers and standalone lists keep their explicit inputs. */
export function useInboxChildList<T extends InboxChildListInputs & { threads: readonly PluginSidebarThread[] }>(
  props: T,
) {
  const environment = useContext(InboxEnvironmentContext);
  const actions = useContext(InboxActionsContext);
  const activity = useContext(InboxActivityContext);
  const sidebar = props.variant === "sidebar";
  const childrenByParent = props.childrenByParent ?? requireInboxContext(environment).childrenByParentId;
  const onOpenThread = props.onOpenThread ?? requireInboxContext(actions).openThread;
  const activeWithin = useActiveThreadWithin(props.threads, childrenByParent);
  return {
    ...props,
    childrenByParent,
    onOpenThread,
    now: props.now ?? (sidebar ? activity?.now : undefined),
    activeThreadId: props.activeThreadId !== undefined ? props.activeThreadId : sidebar ? activeWithin : undefined,
  };
}
