import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

type AutomationSignalKind = "automations-changed" | "automation-runs-changed";

export function publishAutomationChange(
  sandy: Pick<SandyPluginApi, "realtime">,
  projectId: string,
  kinds: AutomationSignalKind | AutomationSignalKind[],
): void {
  for (const kind of Array.isArray(kinds) ? kinds : [kinds]) {
    sandy.realtime.publish("automations", { projectId, kind });
  }
}
