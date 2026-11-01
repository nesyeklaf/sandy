/** pi/autopilot emits {tools} on this pi.events channel before a /autopilot step sets its tools, null after. */
export const AUTOPILOT_STEP_LOADOUT_EVENT = "autopilot:step-loadout";

/** Fabric owns the model's tools unless a step runs without fabric_exec. */
export const autopilotStepTools = () => {
  let tools: unknown;
  return {
    set: (value: unknown) => { tools = (value as { tools?: unknown } | null)?.tools; },
    fabricMayOwn: () => !Array.isArray(tools) || tools.includes("fabric_exec"),
  };
};
