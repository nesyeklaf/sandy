import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  RETRY_ACTION_ICON,
  UPDATE_ACTION_ICON,
  UPDATE_STATE_PRESENTATION,
  type UpdateState,
} from "@sandy/domain/update-state";
import { Button, type ButtonProps } from "@sandy/shared-ui/button";
import { Icon, type IconName } from "@sandy/shared-ui/icon";
import { cn } from "@sandy/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sandy/shared-ui/tooltip";
import {
  ResourceActionButton,
  ResourceListState,
} from "@sandy/shared-ui/resource-list";
import { appToast } from "@/components/ui/app-toast";
import { SettingsSection } from "@/components/ui/settings-section";
import { useRetryHostUpdate } from "@/hooks/mutations/host-mutations";
import {
  useUpdateInventory,
  type UpdateInventoryMachine,
  type UpdateInventoryPlugin,
  type UpdateInventoryPlugins,
} from "@/hooks/useUpdateInventory";
import { usePluginUpdateCheck } from "@/hooks/queries/plugin-catalog-queries";
import { Link } from "react-router-dom";
import { getPluginDetailRoutePath } from "@/lib/route-paths";
import {
  isActivePluginUpdateJob,
  startPluginUpdate,
  usePluginUpdateJobs,
} from "@/hooks/queries/plugin-update-job-queries";
import { applyPluginUpdateJob } from "@/hooks/cache-owners/plugin-cache-owner";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import {
  hostCanRetryUpdate,
  hostNeedsUpdate,
  hostUpdateIsStalled,
} from "@/lib/host-update-status";
import { useSystemConfig } from "@/hooks/queries/system-queries";

const BULK_RETRY_THRESHOLD = 1;

export function UpdateActionButton({
  label,
  tooltipLabel,
  icon,
  iconPosition = "start",
  visibleLabel,
  className,
  variant,
  loading = false,
  onClick,
}: {
  label: string;
  tooltipLabel?: string;
  icon: IconName;
  iconPosition?: "start" | "end";
  visibleLabel?: string;
  className?: string;
  variant?: ButtonProps["variant"];
  loading?: boolean;
  onClick?: () => void;
}) {
  if (visibleLabel === undefined) {
    return (
      <ResourceActionButton
        label={label}
        tooltipLabel={tooltipLabel}
        icon={icon}
        loading={loading}
        disabled={loading}
        className={cn(
          "size-7",
          variant === "default" &&
            "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
          className,
        )}
        onClick={() => onClick?.()}
      />
    );
  }
  const isQuiet = variant === undefined || variant === "ghost";
  return (
    <Button
      type="button"
      variant={variant ?? "ghost"}
      size="sm"
      aria-label={label}
      aria-busy={loading}
      className={cn(
        "h-7 gap-1.5 px-2.5 font-normal",
        isQuiet && "text-subtle-foreground hover:text-foreground",
        className,
      )}
      onClick={onClick}
    >
      {iconPosition === "end" ? visibleLabel : null}
      <Icon
        aria-hidden
        name={loading ? "Spinner" : icon}
        className={cn("size-3.5", loading && "animate-spin")}
      />
      {iconPosition === "start" ? visibleLabel : null}
    </Button>
  );
}

function RowVersions({
  current,
  latest,
}: {
  current: string | null;
  latest: string | null;
}) {
  if (current === null) {
    return null;
  }
  return (
    <span
      data-version-metadata
      className="min-w-0 shrink text-2xs text-muted-foreground"
    >
      {current}
      {latest !== null && latest !== current ? (
        <>
          <span className="px-1">→</span>
          <span className="font-semibold text-version-upgrade">{latest}</span>
        </>
      ) : null}
    </span>
  );
}

function stateTextClass(state: UpdateState): string {
  return UPDATE_STATE_PRESENTATION[state].tone === "error"
    ? "font-semibold text-destructive"
    : "font-semibold text-subtle-foreground";
}

function RowStateCaption({
  state,
  children,
}: {
  state: UpdateState;
  children: ReactNode;
}) {
  return (
    <span className={cn("min-w-0 text-2xs break-words", stateTextClass(state))}>
      {children}
    </span>
  );
}

function FailureIndicator({
  reason,
  openLabel,
  openTooltip,
  onOpen,
}: {
  reason: string;
  openLabel?: string;
  openTooltip?: string;
  onOpen?: () => void;
}) {
  const iconClassName =
    "flex size-6 shrink-0 items-center justify-center rounded-sm text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const icon = <Icon aria-hidden name="AlertTriangle" className="size-3.5" />;
  return (
    <span
      data-row-action
      className="-my-1 flex shrink-0 items-center self-center"
    >
      {onOpen === undefined ? null : <span className="sr-only">{reason}</span>}
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            {onOpen === undefined ? (
              <span
                role="img"
                aria-label={reason}
                tabIndex={0}
                className={iconClassName}
              >
                {icon}
              </span>
            ) : (
              <button
                type="button"
                aria-label={openLabel}
                className={cn(
                  iconClassName,
                  "cursor-pointer hover:bg-state-hover",
                )}
                onClick={onOpen}
              >
                {icon}
              </button>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {onOpen === undefined ? reason : openTooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

function RowStateControl({
  state,
  actionIcon,
  actionLabel,
  actionTooltip,
  buttonLeading,
  buttonLabel,
  loading = false,
  live = false,
  onClick,
}: {
  state: UpdateState;
  actionIcon?: IconName;
  actionLabel?: string;
  actionTooltip?: string;
  buttonLeading?: ReactNode;
  buttonLabel?: string;
  loading?: boolean;
  live?: boolean;
  onClick?: () => void;
}) {
  const presentation = UPDATE_STATE_PRESENTATION[state];
  const icon = actionIcon ?? (presentation.icon as IconName | null);
  const spin = loading || presentation.inFlight === true;
  const srLabel = presentation.label;
  const explainOnHover = presentation.inFlight !== true;

  if (onClick !== undefined && buttonLabel !== undefined) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={[srLabel, actionLabel].filter(Boolean).join(" · ")}
          aria-busy={loading}
          disabled={loading}
          className="h-6 shrink-0 gap-1.5 px-2 text-xs"
          onClick={onClick}
        >
          {loading ? (
            <Icon aria-hidden name="Loading" className="size-3 animate-spin" />
          ) : (
            buttonLeading
          )}
          {buttonLabel}
        </Button>
      </span>
    );
  }

  if (onClick !== undefined && icon !== null) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <UpdateActionButton
          label={[srLabel, actionLabel].filter(Boolean).join(" · ")}
          tooltipLabel={actionTooltip ?? actionLabel ?? presentation.label}
          icon={icon}
          loading={loading}
          onClick={onClick}
        />
      </span>
    );
  }

  if (icon === null) {
    return <span className="flex h-7 shrink-0 items-center" />;
  }

  const mark = (
    <span
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      data-update-state={state}
      className="flex size-7 shrink-0 items-center justify-center"
    >
      <Icon
        aria-hidden
        name={icon}
        className={cn(
          "size-4",
          spin && "animate-spin",
          presentation.tone === "muted" &&
            (state === "up-to-date" ? "text-input" : "text-subtle-foreground"),
          presentation.tone === "error" && "text-destructive",
        )}
      />
      <span className="sr-only">{srLabel}</span>
    </span>
  );

  if (!explainOnHover) {
    return <span className="flex min-w-0 items-center gap-1.5">{mark}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>{mark}</TooltipTrigger>
          <TooltipContent>{presentation.label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto flex h-5 shrink-0 items-center justify-end gap-1">
      {children}
    </span>
  );
}

type MachineDaemonState = "updating" | "stalled" | "ahead" | "offline";

function machineDaemonState(
  machine: UpdateInventoryMachine,
  now: number,
): MachineDaemonState | null {
  const { host } = machine;
  if (machine.canRetryDaemonUpdate) {
    return hostUpdateIsStalled(host, now) ? "stalled" : "updating";
  }
  if (hostNeedsUpdate(host) && !hostCanRetryUpdate(host)) {
    return "ahead";
  }
  return host.status === "connected" ? null : "offline";
}

function machineNeedsAttention(
  machine: UpdateInventoryMachine,
  now: number,
): boolean {
  const daemon = machineDaemonState(machine, now);
  return daemon !== null && daemon !== "offline";
}

interface MachineUpdateRowProps {
  machine: UpdateInventoryMachine;
  now: number;
  tags: readonly string[];
  retryUpdatePending: boolean;
  onRetryDaemonUpdate: (hostId: string) => void;
}

function MachineRowNote({
  machine,
  daemon,
  retryUpdatePending,
  onRetryDaemonUpdate,
}: Pick<
  MachineUpdateRowProps,
  "machine" | "retryUpdatePending" | "onRetryDaemonUpdate"
> & {
  daemon: MachineDaemonState | null;
}) {
  const { host } = machine;
  if (daemon === "updating") {
    return (
      <>
        <RowStateCaption state="in-progress">Updating sandy</RowStateCaption>
        <RowStateControl live state="in-progress" />
      </>
    );
  }
  if (daemon === "stalled") {
    return (
      <>
        <RowStateCaption state="failed">Update didn't finish</RowStateCaption>
        <RowStateControl
          state="failed"
          actionIcon={RETRY_ACTION_ICON as IconName}
          actionTooltip="Retry"
          actionLabel={`Retry on ${host.name} now`}
          loading={retryUpdatePending}
          onClick={() => onRetryDaemonUpdate(host.id)}
        />
      </>
    );
  }
  if (daemon === "ahead") {
    return (
      <RowStateCaption state="offline">
        Update this app to reconnect
      </RowStateCaption>
    );
  }
  if (daemon === "offline") {
    return <RowStateCaption state="offline">Offline</RowStateCaption>;
  }
  return null;
}

export function MachineUpdateRow({
  machine,
  now,
  tags,
  retryUpdatePending,
  onRetryDaemonUpdate,
}: MachineUpdateRowProps) {
  const { host } = machine;
  const daemon = machineDaemonState(machine, now);
  return (
    <div data-updates-machine={host.id}>
      <div className="relative grid min-h-12 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-sm">
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex h-5 w-6 shrink-0 items-center justify-center">
            <Icon
              aria-hidden
              name="Laptop"
              className="size-4 text-muted-foreground"
            />
          </span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate font-medium text-foreground">
              {host.name}
            </span>
            {tags.map((tag) => (
              <span
                key={tag}
                data-machine-tag
                className="shrink-0 text-xs text-subtle-foreground"
              >
                {tag}
              </span>
            ))}
          </span>
        </span>
        <span className="relative z-10 flex min-w-0 items-center justify-end gap-2">
          <MachineRowNote
            machine={machine}
            daemon={daemon}
            retryUpdatePending={retryUpdatePending}
            onRetryDaemonUpdate={onRetryDaemonUpdate}
          />
        </span>
      </div>
    </div>
  );
}

function pluralMachines(count: number): string {
  return `${count} machine${count === 1 ? "" : "s"}`;
}

function quietFleetSummary(
  machines: readonly UpdateInventoryMachine[],
): string {
  const connected = machines.filter(
    (machine) => machine.host.status === "connected",
  );
  const offline = machines.length - connected.length;
  if (connected.length === 0) {
    return machines.length === 1
      ? `${machines[0]?.host.name} is offline.`
      : `All ${pluralMachines(machines.length)} are offline.`;
  }
  const scope =
    machines.length === 1
      ? `on ${connected[0]?.host.name}`
      : offline === 0
        ? `on all ${pluralMachines(connected.length)}`
        : `on ${pluralMachines(connected.length)}`;
  return `Nothing to update ${scope}.${offline === 0 ? "" : ` ${offline} offline.`}`;
}

function BulkUpdateProgress({ remainingJobs }: { remainingJobs: number }) {
  const [batch, setBatch] = useState({ total: 0, remaining: 0 });
  if (batch.remaining !== remainingJobs) {
    setBatch({
      total:
        remainingJobs === 0
          ? 0
          : batch.remaining === 0
            ? remainingJobs
            : batch.total + Math.max(0, remainingJobs - batch.remaining),
      remaining: remainingJobs,
    });
  }
  if (remainingJobs === 0) {
    return null;
  }
  return (
    <span
      role="status"
      data-updates-progress
      className="flex h-7 items-center gap-1.5 text-xs text-subtle-foreground"
    >
      <Icon aria-hidden name="Loading" className="size-3.5 animate-spin" />
      {batch.total > 1 && batch.remaining === remainingJobs
        ? `Updating ${batch.total - remainingJobs + 1} of ${batch.total}`
        : "Updating"}
    </span>
  );
}

interface MachineUpdatesSectionProps {
  machines: readonly UpdateInventoryMachine[];
  now: number;
  localDaemonHostId: string | null;
  serverHostId: string | null;
  retryPendingHostId: string | null;
  onRetryDaemonUpdate: (hostId: string) => void;
  onRetryAllDaemonUpdates: (hostIds: string[]) => void;
}

export function MachineUpdatesSection({
  machines,
  now,
  localDaemonHostId,
  serverHostId,
  retryPendingHostId,
  onRetryDaemonUpdate,
  onRetryAllDaemonUpdates,
}: MachineUpdatesSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const attention = machines.filter((machine) =>
    machineNeedsAttention(machine, now),
  );
  const quiet = machines.filter(
    (machine) => !machineNeedsAttention(machine, now),
  );
  const listed = showAll ? [...attention, ...quiet] : attention;
  const stalledHostIds = machines
    .filter((machine) => machineDaemonState(machine, now) === "stalled")
    .map((machine) => machine.host.id);

  const bulkActions =
    stalledHostIds.length > BULK_RETRY_THRESHOLD ? (
      <div
        role="toolbar"
        aria-label="Bulk update actions"
        className="flex flex-wrap items-center justify-end gap-2"
      >
        <UpdateActionButton
          label={`Update all ${stalledHostIds.length} machines now`}
          visibleLabel="Retry all"
          icon="RotateCcw"
          iconPosition="end"
          variant="default"
          className="font-medium"
          onClick={() => onRetryAllDaemonUpdates(stalledHostIds)}
        />
      </div>
    ) : null;

  return (
    <div data-updates-domain="machines" className="space-y-2">
      <SettingsSection
        action={bulkActions}
        actionPlacement="inline"
        bodyClassName="overflow-hidden p-0"
        title="Machines"
      >
        {machines.length === 0 ? (
          <ResourceListState state="empty" message="No machines available." />
        ) : listed.length === 0 ? (
          <div
            data-updates-summary
            className="flex min-h-12 items-center gap-3 px-4 py-2 text-sm text-muted-foreground"
          >
            <span className="flex h-5 w-6 shrink-0 items-center justify-center">
              <Icon
                aria-hidden
                name="CircleCheck"
                className="size-4 text-input"
              />
            </span>
            {quietFleetSummary(quiet)}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {listed.map((machine) => {
              const hostId = machine.host.id;
              const tags = [
                hostId === serverHostId ? "Server" : null,
                machines.length > 1 && hostId === localDaemonHostId
                  ? "This machine"
                  : null,
              ].filter((tag): tag is string => tag !== null);
              return (
                <MachineUpdateRow
                  key={hostId}
                  machine={machine}
                  now={now}
                  tags={tags}
                  retryUpdatePending={retryPendingHostId === hostId}
                  onRetryDaemonUpdate={onRetryDaemonUpdate}
                />
              );
            })}
          </div>
        )}
      </SettingsSection>
      {quiet.length === 0 ? null : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-subtle-foreground">
          {attention.length === 0 ? null : (
            <span>
              {quiet.length === 1
                ? "1 other machine has nothing to update"
                : `${quiet.length} other machines have nothing to update`}
            </span>
          )}
          <button
            type="button"
            aria-expanded={showAll}
            className="cursor-pointer rounded-sm underline decoration-border underline-offset-4 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll
              ? attention.length === 0
                ? "Hide machines"
                : "Hide"
              : attention.length === 0
                ? "Show machines"
                : "Show all"}
          </button>
        </p>
      )}
    </div>
  );
}

function pluginDisplayName(item: UpdateInventoryPlugin): string {
  return item.plugin.name ?? item.plugin.id;
}

function blockedPluginReason(
  item: Extract<UpdateInventoryPlugin, { kind: "blocked" }>,
): string {
  const version = item.version;
  return item.reasons.length === 0
    ? `${version} isn’t compatible with this sandy`
    : `${version}: ${item.reasons.join("; ")}`;
}

function PluginUpdateRow({
  item,
  updating,
  onStartUpdate,
}: {
  item: UpdateInventoryPlugin;
  updating: boolean;
  onStartUpdate: (pluginId: string) => void;
}) {
  const { plugin } = item;
  const name = pluginDisplayName(item);
  const failure =
    item.kind === "update" ? plugin.updateState.lastFailure : null;
  return (
    <div
      data-plugin-update-row={plugin.id}
      className="grid min-h-12 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-sm"
    >
      <Link
        to={getPluginDetailRoutePath({
          pluginId: plugin.id,
          view: "installed",
        })}
        className="flex min-w-0 items-start gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex h-5 w-6 shrink-0 items-center justify-center">
          <PluginIcon
            pluginId={plugin.id}
            icon={plugin.icon}
            compactIconUrl={plugin.compactIconUrl}
            className="size-4 text-muted-foreground"
          />
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 truncate font-medium text-foreground">
            {name}
          </span>
          <RowVersions
            current={plugin.version}
            latest={item.kind === "update" ? item.version : null}
          />
          {item.kind === "blocked" ? (
            <span className="basis-full text-2xs break-words text-subtle-foreground">
              {blockedPluginReason(item)}
            </span>
          ) : null}
        </span>
      </Link>
      <RowActions>
        {updating ? (
          <RowStateControl live state="in-progress" />
        ) : item.kind === "blocked" ? (
          <span className="text-2xs font-semibold text-subtle-foreground">
            Blocked
          </span>
        ) : failure !== null ? (
          <>
            <FailureIndicator
              reason={
                failure.detail.length > 0
                  ? failure.detail
                  : `sandy couldn’t activate ${failure.label} and restored ${plugin.version}.`
              }
            />
            <RowStateControl
              state="failed"
              actionIcon={RETRY_ACTION_ICON as IconName}
              actionLabel={`Retry ${name} update to ${item.version}`}
              actionTooltip="Retry"
              onClick={() => onStartUpdate(plugin.id)}
            />
          </>
        ) : (
          <RowStateControl
            state="update-available"
            actionLabel={`Update ${name} to ${item.version}`}
            buttonLeading={
              <Icon aria-hidden name={UPDATE_ACTION_ICON} className="size-3" />
            }
            buttonLabel="Update"
            onClick={() => onStartUpdate(plugin.id)}
          />
        )}
      </RowActions>
    </div>
  );
}

interface PluginUpdatesSectionProps {
  plugins: UpdateInventoryPlugins;
  updatingPluginIds: ReadonlySet<string>;
  checking: boolean;
  onStartUpdates: (pluginIds: string[]) => void;
}

export function PluginUpdatesSection({
  plugins,
  updatingPluginIds,
  checking,
  onStartUpdates,
}: PluginUpdatesSectionProps) {
  const remainingJobs = updatingPluginIds.size;
  const startable = plugins.items
    .filter((item) => item.kind === "update")
    .map((item) => item.plugin.id);
  const bulkActions =
    remainingJobs === 0 && startable.length === 0 ? null : (
      <div
        role="toolbar"
        aria-label="Bulk plugin update actions"
        className="flex flex-wrap items-center justify-end gap-2"
      >
        <BulkUpdateProgress remainingJobs={remainingJobs} />
        {remainingJobs > 0 ? null : (
          <UpdateActionButton
            label={`Update all ${startable.length} plugin${startable.length === 1 ? "" : "s"}`}
            tooltipLabel="Update all"
            icon={UPDATE_ACTION_ICON}
            visibleLabel="Update all"
            variant="default"
            onClick={() => onStartUpdates(startable)}
          />
        )}
      </div>
    );
  return (
    <div data-updates-domain="plugins">
      <SettingsSection
        action={bulkActions}
        actionPlacement="inline"
        bodyClassName="overflow-hidden p-0"
        title="Plugins"
      >
        {plugins.items.length === 0 ? (
          <div
            data-updates-summary
            className="flex min-h-12 items-center gap-3 px-4 py-2 text-sm text-muted-foreground"
          >
            <span className="flex h-5 w-6 shrink-0 items-center justify-center">
              <Icon
                aria-hidden
                name={checking ? "Loading" : "CircleCheck"}
                className={cn("size-4 text-input", checking && "animate-spin")}
              />
            </span>
            {checking
              ? "Checking for updates…"
              : plugins.trackedCount === 0
                ? "No installed plugins track updates."
                : plugins.trackedCount === 1
                  ? "Nothing to update for 1 plugin."
                  : `Nothing to update across ${plugins.trackedCount} plugins.`}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {plugins.items.map((item) => (
              <PluginUpdateRow
                key={item.plugin.id}
                item={item}
                updating={updatingPluginIds.has(item.plugin.id)}
                onStartUpdate={(pluginId) => onStartUpdates([pluginId])}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function UpdatesSettingsSection() {
  const queryClient = useQueryClient();
  const inventory = useUpdateInventory();
  const { localDaemonHostId } = useHostDaemon();
  const serverPrimaryHostId = useSystemConfig().data?.primaryHostId ?? null;
  const retryHostUpdate = useRetryHostUpdate();
  const now = useNow(30_000);
  const pluginUpdateCheck = usePluginUpdateCheck(null, {
    enabled: inventory.plugins !== null,
  });
  const updatingPluginIds = new Set(
    (usePluginUpdateJobs().data ?? [])
      .filter(isActivePluginUpdateJob)
      .map((job) => job.pluginId),
  );

  function startPluginUpdates(pluginIds: readonly string[]): void {
    for (const pluginId of pluginIds) {
      const item = inventory.plugins?.items.find(
        (candidate) => candidate.plugin.id === pluginId,
      );
      const name = item === undefined ? pluginId : pluginDisplayName(item);
      void startPluginUpdate(pluginId).then(
        (job) => applyPluginUpdateJob({ queryClient, job }),
        (error: unknown) => {
          appToast.error("Plugin update failed", {
            description: name + " — " + pluginAdminErrorMessage(error),
          });
        },
      );
    }
  }

  function retryDaemonUpdate(hostId: string): void {
    retryHostUpdate.mutate(hostId, {
      onSuccess: () => {
        const machine = inventory.machines.find(
          (candidate) => candidate.host.id === hostId,
        );
        appToast.success(
          "Retrying the update on " +
            (machine?.host.name ?? "the requested machine"),
        );
      },
    });
  }

  function retryAllStalledDaemonUpdates(hostIds: string[]): void {
    for (const hostId of hostIds) {
      retryHostUpdate.mutate(hostId);
    }
    appToast.success("Retrying the update on " + hostIds.length + " machines");
  }

  return (
    <div className="space-y-6">
      <MachineUpdatesSection
        machines={inventory.machines}
        now={now}
        localDaemonHostId={localDaemonHostId}
        serverHostId={serverPrimaryHostId}
        retryPendingHostId={
          retryHostUpdate.isPending ? (retryHostUpdate.variables ?? null) : null
        }
        onRetryDaemonUpdate={retryDaemonUpdate}
        onRetryAllDaemonUpdates={retryAllStalledDaemonUpdates}
      />
      {inventory.plugins === null ? null : (
        <PluginUpdatesSection
          plugins={inventory.plugins}
          updatingPluginIds={updatingPluginIds}
          checking={pluginUpdateCheck.isFetching}
          onStartUpdates={startPluginUpdates}
        />
      )}
    </div>
  );
}
