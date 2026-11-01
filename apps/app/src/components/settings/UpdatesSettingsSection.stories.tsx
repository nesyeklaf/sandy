import type { Host } from "@sandy/domain";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@sandy/host-daemon-contract";
import {
  buildUpdateInventoryPlugins,
  type UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import { makePluginListItem } from "@/test/fixtures/plugins";
import { makeHost } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  MachineUpdateRow,
  MachineUpdatesSection,
  PluginUpdatesSection,
} from "./UpdatesSettingsSection";

export default {
  title: "settings/Updates",
};

const noop = () => {};
const NO_JOBS: ReadonlySet<string> = new Set();
const STORY_NOW = 1_800_000_000_000;

function machineOf({
  host,
  isPrimary = false,
  canRetryDaemonUpdate = false,
}: {
  host: Host;
  isPrimary?: boolean;
  canRetryDaemonUpdate?: boolean;
}): UpdateInventoryMachine {
  return { host, isPrimary, canRetryDaemonUpdate };
}

function StoryMachineRow({
  machine,
  tags = [],
}: {
  machine: UpdateInventoryMachine;
  tags?: readonly string[];
}) {
  return (
    <div className="w-full overflow-hidden rounded-lg border border-border bg-card">
      <MachineUpdateRow
        machine={machine}
        now={STORY_NOW}
        tags={tags}
        retryUpdatePending={false}
        onRetryDaemonUpdate={noop}
      />
    </div>
  );
}

function StoryMachines({
  machines,
  serverHostId = null,
  localDaemonHostId = null,
}: {
  machines: readonly UpdateInventoryMachine[];
  serverHostId?: string | null;
  localDaemonHostId?: string | null;
}) {
  return (
    <MachineUpdatesSection
      machines={machines}
      now={STORY_NOW}
      localDaemonHostId={localDaemonHostId}
      serverHostId={serverHostId}
      retryPendingHostId={null}
      onRetryDaemonUpdate={noop}
      onRetryAllDaemonUpdates={noop}
    />
  );
}

export function RowVariations() {
  const server = machineOf({
    host: makeHost({ id: "state-server", name: "workstation" }),
    isPrimary: true,
  });
  const daemonUpdating = machineOf({
    host: makeHost({
      id: "state-daemon-updating",
      name: "studio-mac",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      updatedAt: STORY_NOW - 30_000,
    }),
    canRetryDaemonUpdate: true,
  });
  const daemonStalled = machineOf({
    host: makeHost({
      id: "state-daemon-stalled",
      name: "ci-runner-3",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      updatedAt: STORY_NOW - 6 * 60_000,
    }),
    canRetryDaemonUpdate: true,
  });
  const daemonOffline = machineOf({
    host: makeHost({
      id: "state-daemon-offline",
      name: "old-laptop",
      status: "disconnected",
    }),
  });

  return (
    <StoryCard className="max-w-5xl" labelWidth="240px">
      <h2 className="px-4 py-3 text-sm font-semibold">Machine rows</h2>
      <StoryRow label="Current" hint="Tagged as the server machine.">
        <StoryMachineRow machine={server} tags={["Server"]} />
      </StoryRow>

      <StoryRow
        label="Machine updating sandy"
        hint="The enrolled daemon is applying its required update automatically."
      >
        <StoryMachineRow machine={daemonUpdating} />
      </StoryRow>

      <StoryRow
        label="Machine update stalled"
        hint="The daemon update did not finish and can be retried."
      >
        <StoryMachineRow machine={daemonStalled} />
      </StoryRow>

      <StoryRow
        label="Machine offline"
        hint="Shown only after Show all; sandy cannot currently reach this machine."
      >
        <StoryMachineRow machine={daemonOffline} />
      </StoryRow>
    </StoryCard>
  );
}

export function SectionVariations() {
  const current = machineOf({
    host: makeHost({ id: "section-current", name: "workstation" }),
    isPrimary: true,
  });
  const studioMac = machineOf({
    host: makeHost({ id: "section-studio", name: "studio-mac" }),
  });
  const offline = machineOf({
    host: makeHost({
      id: "section-offline",
      name: "old-laptop",
      status: "disconnected",
    }),
  });
  const stalled = machineOf({
    host: makeHost({
      id: "section-stalled",
      name: "ci-runner-3",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      updatedAt: STORY_NOW - 6 * 60_000,
    }),
    canRetryDaemonUpdate: true,
  });
  return (
    <StoryCard className="max-w-6xl" labelWidth="240px">
      <StoryRow label="Everything current" hint="One quiet line for the fleet.">
        <div className="w-full space-y-6">
          <StoryMachines machines={[current, offline]} />
        </div>
      </StoryRow>
      <StoryRow
        label="Multiple machines"
        hint="A stalled daemon needs attention; quiet machines fold into the footer."
      >
        <div className="w-full space-y-6">
          <StoryMachines
            machines={[current, studioMac, stalled, offline]}
            serverHostId={current.host.id}
            localDaemonHostId={studioMac.host.id}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}

const STORY_PLUGINS = buildUpdateInventoryPlugins([
  makePluginListItem({
    id: "github-pr-status",
    name: "GitHub PR Status",
    icon: "GitPullRequest",
    source: "git:github.com/acme/github-pr-status@^1.2.0",
    version: "1.2.0",
    updateState: {
      outcome: "update-available",
      availableVersion: "1.4.1",
      availableLabel: "1.4.1",
    },
  }),
  makePluginListItem({
    id: "linear",
    name: "Linear",
    icon: "Zap",
    source: "git:github.com/acme/linear@^0.8.0",
    version: "0.8.2",
    updateState: {
      outcome: "update-available",
      availableVersion: "0.9.0",
      availableLabel: "0.9.0",
      lastFailure: {
        version: "0.9.0",
        label: "0.9.0",
        at: STORY_NOW,
        detail: "activation failed: settings schema rejected stored values",
      },
    },
  }),
  makePluginListItem({
    id: "notes",
    name: "Notes",
    icon: "File",
    source: "git:github.com/acme/notes@^2.0.0",
    version: "2.3.0",
    updateState: {
      outcome: "incompatible",
      blockedVersion: "3.0.0",
      blockedLabel: "3.0.0",
      blockedReasons: ["engines.sandy requires >=0.40.0 (running 0.38.0)"],
    },
  }),
  makePluginListItem({
    id: "pinned",
    name: "Pinned",
    source: "git:github.com/acme/pinned@v1.0.0",
    updateState: { outcome: "pinned" },
  }),
]);

export function PluginSectionVariations() {
  return (
    <StoryCard className="max-w-5xl" labelWidth="240px">
      <h2 className="px-4 py-3 text-sm font-semibold">Plugins</h2>
      <StoryRow
        label="Updates"
        hint="Update, a failed update with Retry, and an engines-blocked candidate."
      >
        <div className="w-full">
          <PluginUpdatesSection
            plugins={STORY_PLUGINS}
            updatingPluginIds={NO_JOBS}
            checking={false}
            onStartUpdates={noop}
          />
        </div>
      </StoryRow>
      <StoryRow
        label="Updating"
        hint="Update all gives way to progress while the queue drains."
      >
        <div className="w-full">
          <PluginUpdatesSection
            plugins={STORY_PLUGINS}
            updatingPluginIds={new Set(["github-pr-status", "linear"])}
            checking={false}
            onStartUpdates={noop}
          />
        </div>
      </StoryRow>
      <StoryRow label="Quiet" hint="Every tracking plugin is current.">
        <div className="w-full">
          <PluginUpdatesSection
            plugins={{ trackedCount: 6, items: [] }}
            updatingPluginIds={NO_JOBS}
            checking={false}
            onStartUpdates={noop}
          />
        </div>
      </StoryRow>
      <StoryRow label="Checking" hint="The page-load check is running.">
        <div className="w-full">
          <PluginUpdatesSection
            plugins={{ trackedCount: 6, items: [] }}
            updatingPluginIds={NO_JOBS}
            checking
            onStartUpdates={noop}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}
