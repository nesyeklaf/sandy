import { Link } from "react-router-dom";
import { Icon } from "@sandy/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@sandy/shared-ui/tooltip";
import { cn } from "@sandy/shared-ui/lib/utils";
import { SidebarMenuItem } from "@/components/ui/sidebar.js";
import { useUpdateInventory } from "@/hooks/useUpdateInventory";
import { useMachineAttention } from "@/hooks/useMachineAttention";
import { getSettingsRoutePath } from "@/lib/route-paths";

interface SidebarUpdatesBadgeProps {
  onNavigate?: () => void;
}

const CHIP_CLASS = cn(
  "flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-sidebar-border px-2",
  "text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
);

export function SidebarUpdatesBadge({ onNavigate }: SidebarUpdatesBadgeProps) {
  const inventory = useUpdateInventory();

  const machineAttention = useMachineAttention(
    inventory.machines.map((machine) => machine.host),
    inventory.isLoading,
  );

  const pluginUpdateCount =
    inventory.plugins?.items.filter((item) => item.kind === "update").length ??
    0;

  if (pluginUpdateCount === 0 && machineAttention.label === null) {
    return null;
  }

  const updatesRoutePath = getSettingsRoutePath("updates");
  const pluginLabel =
    pluginUpdateCount === 1
      ? "1 plugin update available"
      : `${pluginUpdateCount} plugin updates available`;

  return (
    <SidebarMenuItem className="flex min-w-0 items-center gap-1">
      {machineAttention.label !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={getSettingsRoutePath("machines")}
              onClick={() => {
                machineAttention.acknowledge();
                onNavigate?.();
              }}
              aria-label={machineAttention.label}
              data-testid="sidebar-machines-attention-badge"
              className={cn(CHIP_CLASS, "text-warning-text")}
            >
              <Icon name="AlertTriangle" className="size-3" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{machineAttention.label}</TooltipContent>
        </Tooltip>
      ) : null}
      {pluginUpdateCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={pluginLabel}
              data-testid="sidebar-updates-badge-plugins"
              className={CHIP_CLASS}
            >
              <Icon name="Plug02" className="size-3 text-muted-foreground" />
              {pluginUpdateCount}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{pluginLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}
