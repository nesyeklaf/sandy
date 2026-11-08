import { definePluginApp } from "@sandy-sdk/plugin-sdk/app";
import { HolonOpener } from "./ui/HolonOpener";

export default definePluginApp((app) => {
  app.slots.fileOpener({ id: "holon", title: "Holon", extensions: ["holon"], component: HolonOpener });
});
