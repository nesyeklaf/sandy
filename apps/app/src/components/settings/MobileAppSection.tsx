import { PluginMobileSettingsSections } from "@/components/plugin/PluginSettingsSections";
import { MachineAccessSettings } from "./MachineAccessSettings";

export function MobileAppSection() {
  return (
    <section aria-label="Mobile" className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Mobile</h2>
        <p className="mt-1 text-sm text-subtle-foreground">
          Use sandy from your phone
        </p>
      </div>
      <MachineAccessSettings title="Accessing sandy from your phone">
        {(pluginId) => <PluginMobileSettingsSections pluginId={pluginId} />}
      </MachineAccessSettings>
    </section>
  );
}
