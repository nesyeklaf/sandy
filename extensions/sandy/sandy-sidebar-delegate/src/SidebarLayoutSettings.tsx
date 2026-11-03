import { MAX_INACTIVE_AFTER_HOURS, MIN_INACTIVE_AFTER_HOURS } from "./inactive";
import { THREAD_DENSITIES, type ThreadDensity } from "./sidebar-settings-values";
import { DENSITY_LABELS } from "./ViewSheet";
import {
  InlineNumber,
  SettingRow,
  SettingsSection,
  SettingsSelect,
  Switch,
  type SettingsDraftSectionProps,
} from "./settings-ui";

export function SidebarLayoutSettings({
  draft,
  update,
  status,
  inactiveHoursValid,
}: SettingsDraftSectionProps & { inactiveHoursValid: boolean }) {
  return (
    <SettingsSection title="Sidebar layout" status={status}>
      <SettingRow
        title="Density"
        description="Comfortable shows each thread on three lines, Compact on two, Dense on one. Auto gives threads that need you or are working full cards and the rest two lines. Each shelf can override this from its ⋯ menu."
        control={
          <SettingsSelect
            aria-label="Density"
            value={draft.threadDensity}
            onChange={(event) => update("threadDensity", event.target.value as ThreadDensity)}
            className="w-52"
          >
            {THREAD_DENSITIES.map((density) => (
              <option key={density} value={density}>
                {DENSITY_LABELS[density]}
              </option>
            ))}
          </SettingsSelect>
        }
      >
        {draft.threadDensity !== "comfortable" ? (
          <div className="border-l-2 border-border">
            <SettingRow
              title="Keep pinned threads full"
              description="Pinned threads keep their full cards."
              control={
                <Switch
                  label="Keep pinned threads full"
                  checked={draft.keepPinnedThreadsFull}
                  onChange={(checked) => update("keepPinnedThreadsFull", checked)}
                />
              }
            />
            <SettingRow
              title="Keep woken threads full"
              description="A snoozed thread that wakes shows a full card until you open it or dismiss its Woke marker."
              control={
                <Switch
                  label="Keep woken threads full"
                  checked={draft.keepWokeThreadsFull}
                  onChange={(checked) => update("keepWokeThreadsFull", checked)}
                />
              }
            />
          </div>
        ) : null}
      </SettingRow>
      <SettingRow
        title="Hide repo names in compact cards"
        description="Keep the repo icon and hide its name on Compact and Dense rows in Active, Pinned, and Working. Hover to see the repo name."
        control={
          <Switch
            label="Hide repo names in compact cards"
            checked={draft.compactProjectIconOnly}
            onChange={(checked) => update("compactProjectIconOnly", checked)}
          />
        }
      />
      <SettingRow
        title="Working shelf"
        experimental
        description="Keep working threads in their own shelf. They return to Active when work finishes, fails, or needs you. Pinned threads stay pinned."
        control={
          <Switch
            label="Working shelf"
            checked={draft.workingShelf}
            onChange={(checked) => update("workingShelf", checked)}
          />
        }
      />
      <SettingRow
        title="Inactive shelf"
        description="Move quiet, unpinned threads out of Active. New activity brings them back."
        control={
          <Switch
            label="Inactive shelf"
            checked={draft.inactiveThreadsEnabled}
            onChange={(checked) => update("inactiveThreadsEnabled", checked)}
          />
        }
      >
        {draft.inactiveThreadsEnabled ? (
          <InlineNumber
            label="Hours before inactive"
            prefix="After"
            suffix="hours without activity"
            value={draft.inactiveAfterHours}
            min={MIN_INACTIVE_AFTER_HOURS}
            max={MAX_INACTIVE_AFTER_HOURS}
            valid={inactiveHoursValid}
            errorId="inactive-hours-error"
            onChange={(value) => update("inactiveAfterHours", value)}
          />
        ) : null}
      </SettingRow>

      <SettingRow
        title="Dock shelves to the bottom"
        experimental
        description="Keep shelves below Active at the bottom of the sidebar. Expanded shelves scroll with the thread list."
        control={
          <Switch
            label="Dock shelves to the bottom"
            checked={draft.dockShelves}
            onChange={(checked) => update("dockShelves", checked)}
          />
        }
      />
    </SettingsSection>
  );
}
