import {
  deleteAllPluginKvValues,
  deleteAllPluginSettings,
  deletePluginKvValue,
  getAiServiceSelections,
  hasAppSettingsMarker,
  listPluginKvKeys,
  setAiServiceSelection,
  setAppSettingsMarker,
  type DbConnection,
} from "@sandy/db";
import { AI_TASKS } from "@sandy/domain";

const MARKER_KEY = "retiredState.outgoingConnections.v2";
const RETIRED_AI_PLUGIN_IDS: ReadonlySet<string> = new Set(["sandy-ai"]);
const RETIRED_PLUGIN_IDS = [
  "sandy-ai",
  "environment-modal-sandbox",
  "sandy-account",
  "connect",
  "sandy--connect-next",
] as const;
const PUSH_PLUGIN_ID = "push-notifications";
const PUSH_SUBSCRIPTION_KEY_PREFIX = "subscription:";

export interface RetiredOutgoingStateReport {
  aiSelectionsReset: number;
  pushSubscriptionsRemoved: number;
  retiredPluginRowsCleared: number;
}

export function removeRetiredOutgoingConnectionState(
  db: DbConnection,
): RetiredOutgoingStateReport | null {
  if (hasAppSettingsMarker(db, MARKER_KEY)) return null;
  const report: RetiredOutgoingStateReport = {
    aiSelectionsReset: 0,
    pushSubscriptionsRemoved: 0,
    retiredPluginRowsCleared: 0,
  };
  const selections = getAiServiceSelections(db);
  for (const task of AI_TASKS) {
    const selection = selections[task];
    if (
      selection.mode === "service" &&
      RETIRED_AI_PLUGIN_IDS.has(selection.pluginId)
    ) {
      setAiServiceSelection(db, task, { mode: "automatic" });
      report.aiSelectionsReset++;
    }
  }
  for (const key of listPluginKvKeys(
    db,
    PUSH_PLUGIN_ID,
    PUSH_SUBSCRIPTION_KEY_PREFIX,
  )) {
    if (deletePluginKvValue(db, PUSH_PLUGIN_ID, key)) {
      report.pushSubscriptionsRemoved++;
    }
  }
  for (const pluginId of RETIRED_PLUGIN_IDS) {
    report.retiredPluginRowsCleared += deleteAllPluginKvValues(db, pluginId);
    deleteAllPluginSettings(db, pluginId);
  }
  setAppSettingsMarker(db, MARKER_KEY);
  return report;
}
