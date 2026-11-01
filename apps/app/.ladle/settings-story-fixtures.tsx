import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID, type Host, type ProviderInfo } from "@sandy/domain";
import type {
  SidebarBootstrapResponse,
  SystemAiServicesResponse,
} from "@sandy/server-contract";
import type { ProviderCliStatusResponse } from "@sandy/host-daemon-contract";
import {
  hostProviderCliStatusQueryKey,
  hostsQueryKey,
  machineEnvironmentQueryKey,
  pluginListQueryKey,
  pluginMarketplacesQueryKey,
  serverMoveStatusQueryKey,
  sidebarNavigationQueryKey,
  systemAiServicesQueryKey,
  systemConfigQueryKey,
  systemProvidersQueryKey,
} from "../src/hooks/queries/query-keys";
import type { UpdateInventoryMachine } from "../src/hooks/useUpdateInventory";
import { createAppQueryClient } from "../src/lib/query-client";
import { makeSystemConfig } from "../src/test/fixtures/system-config";
import { systemMachineProvidersQueryKey } from "../src/hooks/queries/query-keys";
import {
  MANUAL_MACHINE_PROVIDER,
  MODAL_MACHINE_PROVIDER,
} from "./machine-story-fixtures";
import { makeProviderInfo } from "@sandy/test-helpers/domain-fixtures";
import {
  MachineUpdatesSection,
  PluginUpdatesSection,
} from "../src/components/settings/UpdatesSettingsSection";
import {
  HOST_IDS,
  HOST_NAMES,
  PROJECT_IDS,
  PROJECT_NAMES,
  STORY_PROJECT_SOURCES,
  makeHost,
  makeProject,
  makeThreadListEntry,
  makeProviderCliStatus,
} from "./story-fixtures";
import codexLogoUrl from "../../../plugins/provider-codex/icons/codex.svg";
import claudeCodeLogoUrl from "../../../plugins/provider-claude-code/icons/claude-code.svg";
import cursorLogoUrl from "../../../plugins/provider-acp/icons/cursor.svg";

const STORY_GIT_HEALTH = {
  status: "logged in" as const,
  statusMessage: "gh is authenticated",
};

const STORY_GLOBAL_VARIABLES = [
  { name: "ANTHROPIC_API_KEY", value: null, secret: true as const, note: null },
  {
    name: "DATABASE_URL",
    value: null,
    secret: true as const,
    note: "Points at the staging replica, not production.",
  },
  { name: "SENTRY_DSN", value: null, secret: true as const, note: null },
];

const STORY_AI_SERVICES: SystemAiServicesResponse = {
  selections: {
    "thread-title": { mode: "automatic" },
    "commit-message": { mode: "automatic" },
    voice: { mode: "automatic" },
  },
  services: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      pluginId: "provider-claude-code",
      tasks: ["thread-title", "commit-message", "voice"],
      automaticRank: 0,
      status: { ready: true },
    },
    {
      id: "codex",
      displayName: "Codex",
      pluginId: "provider-codex",
      tasks: ["thread-title", "commit-message"],
      automaticRank: 1,
      status: { ready: false, message: "Run `codex login` to sign in" },
    },
  ],
};

const SETTINGS_STORY_NOW = Date.parse("2026-08-19T08:00:00.000Z");

const SETTINGS_STORY_PRIMARY_HOST = makeHost({
  createdAt: SETTINGS_STORY_NOW - 45 * 24 * 60 * 60_000,
  lastSeenAt: SETTINGS_STORY_NOW,
});

const SETTINGS_STORY_HOSTS = [
  SETTINGS_STORY_PRIMARY_HOST,
  makeHost({
    id: HOST_IDS.remote,
    name: HOST_NAMES.remote,
    maxPermissionMode: "auto",
    createdAt: SETTINGS_STORY_NOW - 18 * 24 * 60 * 60_000,
    lastSeenAt: SETTINGS_STORY_NOW - 3 * 60_000,
  }),
];

const localProviderStatus = {
  codex: makeProviderCliStatus("codex", {
    currentVersion: "0.145.0",
  }),
  "claude-code": makeProviderCliStatus("claude-code", {
    currentVersion: "2.1.0",
  }),
  "acp-cursor": makeProviderCliStatus("acp-cursor", {
    currentVersion: "0.49.0",
  }),
} satisfies ProviderCliStatusResponse;

const remoteProviderStatus = {
  codex: makeProviderCliStatus("codex", {
    currentVersion: "0.145.0",
  }),
  "claude-code": makeProviderCliStatus("claude-code", {
    currentVersion: "2.1.0",
  }),
  "acp-cursor": makeProviderCliStatus("acp-cursor", {
    installed: false,
    executablePath: null,
    currentVersion: null,
  }),
} satisfies ProviderCliStatusResponse;

const project = makeProject({
  id: PROJECT_IDS.sandy,
  gitRemoteUrl: "git@github.com:nesyeklaf/sandy.git",
  sources: [...STORY_PROJECT_SOURCES],
});
const pierreProject = makeProject({
  id: PROJECT_IDS.pierre,
  name: PROJECT_NAMES.pierre,
  gitRemoteUrl: "https://github.com/get-bb/pierre.git",
  sources: [
    {
      id: "src_pierre_remote",
      projectId: PROJECT_IDS.pierre,
      type: "local_path",
      hostId: HOST_IDS.remote,
      path: "/home/michael/pierre",
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    },
  ],
});
const ingestProject = makeProject({
  id: PROJECT_IDS.ingest,
  name: PROJECT_NAMES.ingest,
  gitRemoteUrl: null,
  sources: [],
});
const personalProject = makeProject({
  id: PERSONAL_PROJECT_ID,
  kind: "personal",
  name: "Personal",
  sources: [],
});

const sidebarNavigation = {
  sections: [],
  projects: [
    {
      ...project,
      defaultExecutionOptions: null,
      threads: [
        makeThreadListEntry({ id: "thr_sandy_1", projectId: PROJECT_IDS.sandy }),
        makeThreadListEntry({ id: "thr_sandy_2", projectId: PROJECT_IDS.sandy }),
        makeThreadListEntry({ id: "thr_sandy_3", projectId: PROJECT_IDS.sandy }),
      ],
    },
    {
      ...pierreProject,
      defaultExecutionOptions: null,
      threads: [
        makeThreadListEntry({
          id: "thr_pierre_1",
          projectId: PROJECT_IDS.pierre,
        }),
      ],
    },
    { ...ingestProject, defaultExecutionOptions: null, threads: [] },
  ],
  personalProject: {
    ...personalProject,
    defaultExecutionOptions: null,
    threads: [],
  },
} satisfies SidebarBootstrapResponse;

const systemConfig = makeSystemConfig({
  primaryHostId: HOST_IDS.local,
  primaryHostPlatform: "darwin",
  voiceTranscriptionEnabled: true,
  dataDir: "/Users/michael/.sandy",
});

const systemProviders = [
  makeProviderInfo({
    id: "codex",
    displayName: "Codex",
    logoUrl: codexLogoUrl,
  }),
  makeProviderInfo({
    id: "claude-code",
    displayName: "Claude Code",
    logoUrl: claudeCodeLogoUrl,
  }),
  makeProviderInfo({
    id: "acp-cursor",
    displayName: "Cursor",
    logoUrl: cursorLogoUrl,
  }),
] satisfies ProviderInfo[];

const settingsUpdateMachine = {
  host: SETTINGS_STORY_PRIMARY_HOST,
  isPrimary: true,
  canRetryDaemonUpdate: false,
} satisfies UpdateInventoryMachine;

const noJobs: ReadonlySet<string> = new Set();
const noop = () => {};

export function SettingsUpdatesStory() {
  return (
    <div className="space-y-6">
      <MachineUpdatesSection
        machines={[settingsUpdateMachine]}
        now={0}
        localDaemonHostId={null}
        serverHostId={null}
        retryPendingHostId={null}
        onRetryDaemonUpdate={noop}
        onRetryAllDaemonUpdates={noop}
      />
      <PluginUpdatesSection
        plugins={{ trackedCount: 0, items: [] }}
        updatingPluginIds={noJobs}
        checking={false}
        onStartUpdates={noop}
      />
    </div>
  );
}

function createSettingsStoryQueryClient(hosts: Host[] = SETTINGS_STORY_HOSTS) {
  const queryClient = createAppQueryClient({
    showMutationErrorToasts: false,
    defaultOptions: {
      mutations: { retry: false },
      queries: {
        gcTime: Infinity,
        retry: false,
        staleTime: Infinity,
      },
    },
  });
  queryClient.setQueryData(hostsQueryKey(), hosts);
  queryClient.setQueryData(hostsQueryKey(true), hosts);
  queryClient.setQueryData(systemConfigQueryKey(), systemConfig);
  queryClient.setQueryData(systemProvidersQueryKey(), systemProviders);
  queryClient.setQueryData(sidebarNavigationQueryKey(), sidebarNavigation);
  queryClient.setQueryData(pluginMarketplacesQueryKey(), []);
  queryClient.setQueryData(systemAiServicesQueryKey(), STORY_AI_SERVICES);
  queryClient.setQueryData(machineEnvironmentQueryKey(null), {
    builtInGit: STORY_GIT_HEALTH,
    variables: STORY_GLOBAL_VARIABLES,
    inheritedVariables: [],
  });
  queryClient.setQueryData(machineEnvironmentQueryKey(PROJECT_IDS.sandy), {
    builtInGit: STORY_GIT_HEALTH,
    variables: [
      {
        name: "DATABASE_URL",
        value: null,
        secret: true,
        note: "Points at the sandy sandbox.",
      },
    ],
    inheritedVariables: STORY_GLOBAL_VARIABLES,
  });
  queryClient.setQueryData(
    hostProviderCliStatusQueryKey(HOST_IDS.local),
    localProviderStatus,
  );
  queryClient.setQueryData(
    hostProviderCliStatusQueryKey(HOST_IDS.remote),
    remoteProviderStatus,
  );
  queryClient.setQueryData(pluginListQueryKey(true), []);
  queryClient.setQueryData(serverMoveStatusQueryKey(), {
    move: null,
    lastMove: null,
  });
  queryClient.setQueryData(systemMachineProvidersQueryKey(), [
    MANUAL_MACHINE_PROVIDER,
    MODAL_MACHINE_PROVIDER,
  ]);
  return queryClient;
}

export function SettingsStoryFixtures({
  children,
  hosts = SETTINGS_STORY_HOSTS,
}: {
  children: ReactNode;
  hosts?: Host[];
}) {
  const [queryClient] = useState(() => createSettingsStoryQueryClient(hosts));
  useEffect(() => {
    queryClient.setQueryData(hostsQueryKey(), hosts);
    queryClient.setQueryData(hostsQueryKey(true), hosts);
  }, [hosts, queryClient]);
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
