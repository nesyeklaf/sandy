import { definePluginApp } from "@sandy-sdk/plugin-sdk/app";
import { setupDelegate } from "./delegate/app.tsx";
import { setupGoals } from "./goals/app.tsx";
import { setupTrack } from "./track/app.tsx";
import { setupWorkflows } from "./workflows/src/app.tsx";
import { WORK_TAB } from "./work-tab-link.ts";
import { WorkBanner, WorkTab } from "./work-tab.tsx";

export default definePluginApp((app) => {
  setupDelegate(app);
  setupWorkflows(app);
  setupTrack(app);
  setupGoals(app);
  app.slots.experimental_tab({ ...WORK_TAB, title: "Work", icon: "ListChecks", layout: "flush", component: WorkTab });
  app.composer.customize({ id: "work", scopes: ["thread"], banners: [{ id: "work", chrome: "bare", component: WorkBanner }] });
});
