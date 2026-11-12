import {
  SPACE_HEADER_DENSITIES,
  THREAD_DENSITIES,
  type SpaceHeaderDensity,
  type ThreadDensity,
} from "./sidebar-settings-values";
import { DENSITY_LABELS } from "./ViewSheet";
import { SettingRow, SettingsSection, SettingsSelect, Switch, type SettingsDraftSectionProps } from "./settings-ui";

export function SidebarLayoutSettings({ draft, update, status }: SettingsDraftSectionProps) {
  return (
    <SettingsSection title="Sidebar layout" status={status}>
      <SettingRow
        title="Space headers"
        description="How much a Space shows while it is closed: Minimal only urgent counts, Compact the key counts, Detailed adds repositories and idle work. Independent of thread density."
        control={
          <SettingsSelect
            aria-label="Space headers"
            value={draft.spaceHeaderDensity}
            onChange={(event) => update("spaceHeaderDensity", event.target.value as SpaceHeaderDensity)}
            className="w-52"
          >
            {SPACE_HEADER_DENSITIES.map((density) => (
              <option key={density} value={density}>
                {density[0]!.toUpperCase() + density.slice(1)}
              </option>
            ))}
          </SettingsSelect>
        }
      />
      <SettingRow
        title="Density"
        description="Comfortable shows each thread on three lines, Compact on two, Dense on one. Auto draws Needs you and Failed as full cards, Working on two lines and the rest on one. Each shelf can override this from its ⋯ menu."
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
        description="Keep the repo icon and hide its name on Compact rows in Waiting, Pinned, and Working. Dense rows always show only the icon. Hover to see the repo name."
        control={
          <Switch
            label="Hide repo names in compact cards"
            checked={draft.compactProjectIconOnly}
            onChange={(checked) => update("compactProjectIconOnly", checked)}
          />
        }
      />
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
