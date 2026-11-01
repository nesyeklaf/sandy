import { ProjectAppearanceSettings } from "./ProjectSettings";
import { PROJECT_COLOR_DISPLAYS, type ProjectColorDisplay } from "./sidebar-settings";
import {
  SettingRow,
  SettingsSection,
  SettingsGroup,
  SettingsSelect,
  Switch,
  type SettingsDraftSectionProps,
} from "./settings-ui";

const PROJECT_COLOR_DISPLAY_LABELS: Record<ProjectColorDisplay, string> = {
  all: "Full and collapsed mode",
  full: "Full mode only",
  grouped: "Grouped repos only",
};

export function ProjectAppearanceSection({ draft, update, status }: SettingsDraftSectionProps) {
  return (
    <SettingsSection title="Repo appearance" status={status}>
      <SettingRow
        title="Repo colors"
        description="Color repo names in every mode. Choose where their stripes appear below."
        control={
          <Switch
            label="Repo colors"
            checked={draft.projectColorsEnabled}
            onChange={(checked) => update("projectColorsEnabled", checked)}
          />
        }
      >
        {draft.projectColorsEnabled ? (
          <div className="border-l-2 border-border">
            <SettingRow
              title="Show stripes in"
              description="Full mode includes cards and expanded groups. Grouped repos means combined blocks when sorting by Repo."
              control={
                <SettingsSelect
                  aria-label="Show repo stripes in"
                  value={draft.projectColorDisplay}
                  onChange={(event) => update("projectColorDisplay", event.target.value as ProjectColorDisplay)}
                  className="w-52"
                >
                  {PROJECT_COLOR_DISPLAYS.map((display) => (
                    <option key={display} value={display}>
                      {PROJECT_COLOR_DISPLAY_LABELS[display]}
                    </option>
                  ))}
                </SettingsSelect>
              }
            />
          </div>
        ) : null}
      </SettingRow>
      <SettingsGroup title="Customize a repo">
        <ProjectAppearanceSettings />
      </SettingsGroup>
    </SettingsSection>
  );
}
