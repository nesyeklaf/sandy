import { definePluginApp } from "@sandy-sdk/plugin-sdk/app";
import { OverviewPage } from "./ui/overview-page.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "connections",
    title: "Connections",
    icon: "Network",
    path: "connections",
    component: OverviewPage,
  });
});
