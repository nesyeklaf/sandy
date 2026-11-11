import { definePluginApp } from "@sandy-sdk/plugin-sdk/app";
import { HolonsTab } from "./ui/HolonsTab";

export default definePluginApp((app) => {
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "fixed", id: "holons", title: "Holons", icon: "Hierarchy", component: HolonsTab, layout: "flush" });
});
