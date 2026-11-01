import { PortLinkSettings } from "./PortLinkSettings";
import { SettingsSection, type SaveStatus } from "./settings-ui";

export function DeviceSettings({ status, onSaved }: { status?: SaveStatus; onSaved: () => void }) {
  return (
    <SettingsSection title="This device" status={status}>
      <PortLinkSettings onSaved={onSaved} />
    </SettingsSection>
  );
}
