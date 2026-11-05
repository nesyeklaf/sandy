import { memo, useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from "./components/Select";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { SnoozePickerDialog } from "./SnoozePickerDialog";
import { formatSnoozeWakeTime, resolveConfiguredSnoozePreset, type ConfiguredSnoozePreset } from "./lifecycle";

export function SnoozeSelect({
  label,
  snoozePresets,
  disabled = false,
  triggerClassName,
  onOpenChange,
  onSnooze,
  onPark,
}: {
  label: string;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  disabled?: boolean;
  triggerClassName: string;
  onOpenChange?: (open: boolean) => void;
  onSnooze: (snoozedUntil: number) => void;
  onPark?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuOpenedAt, setMenuOpenedAt] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  // The row keeps its actions revealed until the picker closes too.
  const open = menuOpen || picking;
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  return (
    <>
      <Select
        value=""
        disabled={disabled || (snoozePresets.length === 0 && !onPark)}
        onOpenChange={(next) => {
          setMenuOpen(next);
          if (next) setMenuOpenedAt(Date.now());
        }}
        onValueChange={(presetId) => {
          if (presetId === "pick") {
            setPicking(true);
            return;
          }
          if (presetId === "park") {
            onPark?.();
            return;
          }
          const preset = snoozePresets.find((item) => item.id === presetId);
          if (preset) {
            const wake = resolveConfiguredSnoozePreset(preset);
            if (wake !== null) onSnooze(wake);
          }
        }}
      >
        <Tooltip label={label}>
          <SelectTrigger aria-label={label} className={`${triggerClassName} [&>svg:last-child]:hidden`}>
            <Icon name="Clock" className="size-3.5" />
          </SelectTrigger>
        </Tooltip>
        <SelectContent align="end">
          {menuOpenedAt === null ? null : (
            <SnoozeMenuItems snoozePresets={snoozePresets} hasPark={!!onPark} openedAt={menuOpenedAt} />
          )}
        </SelectContent>
      </Select>
      <SnoozePickerDialog open={picking} onOpenChange={setPicking} onSnooze={onSnooze} />
    </>
  );
}

const SnoozeMenuItems = memo(function SnoozeMenuItems({
  snoozePresets,
  hasPark,
  openedAt,
}: {
  snoozePresets: readonly ConfiguredSnoozePreset[];
  hasPark: boolean;
  openedAt: number;
}) {
  const now = new Date(openedAt);
  return (
    <>
      {snoozePresets.map((preset) => {
        const wake = resolveConfiguredSnoozePreset(preset, now);
        return (
          <SelectItem
            key={preset.id}
            value={preset.id}
            className="text-xs"
            disabled={wake === null}
            title={wake === null ? "Today's time has passed" : formatSnoozeWakeTime(wake)}
          >
            {preset.label}
          </SelectItem>
        );
      })}
      {snoozePresets.length > 0 ? (
        <>
          <SelectSeparator className="my-1 h-px bg-border" />
          <SelectItem value="pick" className="text-xs">
            <span className="flex items-center gap-2">
              <Icon name="Calendar" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              Pick date & time…
            </span>
          </SelectItem>
        </>
      ) : null}
      {hasPark ? (
        <>
          {snoozePresets.length > 0 ? <SelectSeparator className="my-1 h-px bg-border" /> : null}
          <SelectItem value="park" className="text-xs">
            <span className="flex items-center gap-2">
              <Icon name="Car" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              Park thread
            </span>
          </SelectItem>
        </>
      ) : null}
    </>
  );
});
