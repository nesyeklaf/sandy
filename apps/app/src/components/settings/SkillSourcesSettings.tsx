import { SANDY_SKILL_SOURCE_IDS, type SandySkillSourceId } from "@sandy/domain";
import { Switch } from "@sandy/shared-ui/switch";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";

const SKILL_SOURCE_COPY: Readonly<
  Record<SandySkillSourceId, { label: string; description: string }>
> = {
  "sandy-plugins": {
    label: "Plugin skills",
    description:
      "Skills that installed sandy plugins bring, including their command skills.",
  },
  "sandy-user": {
    label: "Your sandy skills",
    description:
      "Skills in sandy's own skills folder in its data directory and in the folders set by SANDY_INHERITED_SKILLS_ROOTS.",
  },
  "sandy-project": {
    label: "Project skills",
    description: "Skills in each project's .sandy/skills folder.",
  },
  shared: {
    label: "Shared skill folders",
    description: "Folders listed under sharedSkillRoots in config.json.",
  },
};

export function SkillSourcesSettings({
  disabled,
  disabledSources,
  onDisabledSourcesChange,
}: {
  disabled: boolean;
  disabledSources: readonly SandySkillSourceId[];
  onDisabledSourcesChange: (disabledSources: SandySkillSourceId[]) => void;
}) {
  const setSourceEnabled = (source: SandySkillSourceId, enabled: boolean) => {
    onDisabledSourcesChange(
      SANDY_SKILL_SOURCE_IDS.filter((id) =>
        id === source ? !enabled : disabledSources.includes(id),
      ),
    );
  };
  return (
    <SettingsSection title="Skill sources">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Where sandy itself loads skills from to give to every agent. Skills that
          an agent loads on its own, such as pi packages or ~/.agents/skills,
          are not affected.
        </p>
        {SANDY_SKILL_SOURCE_IDS.map((source) => (
          <SettingsWithControl
            key={source}
            label={SKILL_SOURCE_COPY[source].label}
            description={SKILL_SOURCE_COPY[source].description}
          >
            <Switch
              checked={!disabledSources.includes(source)}
              disabled={disabled}
              onCheckedChange={(enabled) => setSourceEnabled(source, enabled)}
              aria-label={SKILL_SOURCE_COPY[source].label}
            />
          </SettingsWithControl>
        ))}
      </div>
    </SettingsSection>
  );
}
