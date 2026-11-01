import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { introduction } from "./introduction.js";

export default async function plugin(sandy: SandyPluginApi) {
  const settings = sandy.settings.define({
    introduction: {
      type: "boolean",
      label: "Send SANDY introduction",
      description:
        "Tell agents about the SANDY CLI, threads, and clickable links. Applies to new agent sessions.",
      default: true,
    },
    skills: {
      type: "boolean",
      label: "Enable bundled skills",
      description: "Make the selected SANDY guide skills available to agents.",
      default: true,
    },
    sandyCli: {
      type: "boolean",
      label: "SANDY CLI skill",
      description: "Inspect and manage SANDY through the CLI.",
      default: true,
    },
    pluginAuthoring: {
      type: "boolean",
      label: "Plugin authoring skill",
      description: "Create and change SANDY plugins and SDK extensions.",
      default: true,
    },
    skillCreator: {
      type: "boolean",
      label: "Skill creator skill",
      description: "Create and improve SANDY skills.",
      default: true,
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  sandy.agents.contributeInstructions(() =>
    current.introduction ? introduction : null,
  );
  sandy.agents.configure(() => ({
    tools: [],
    skills: current.skills
      ? [
          ...(current.sandyCli ? ["sandy-cli"] : []),
          ...(current.pluginAuthoring ? ["sandy-plugin-authoring"] : []),
          ...(current.skillCreator ? ["skill-creator"] : []),
        ]
      : [],
  }));
}
