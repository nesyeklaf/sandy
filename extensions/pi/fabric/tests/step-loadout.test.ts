import { describe, expect, it } from "vitest";
import { autopilotStepTools } from "../src/core/step-loadout.js";

describe("autopilotStepTools", () => {
  it("lets Fabric own the tools while no step runs", () => {
    expect(autopilotStepTools().fabricMayOwn()).toBe(true);
  });

  it("yields to a step without fabric_exec and takes ownership back after", () => {
    const step = autopilotStepTools();
    step.set({ tools: ["read", "autopilot_submit"] });
    expect(step.fabricMayOwn()).toBe(false);
    step.set(null);
    expect(step.fabricMayOwn()).toBe(true);
  });

  it("keeps ownership for a step that lists fabric_exec", () => {
    const step = autopilotStepTools();
    step.set({ tools: ["fabric_exec", "read"] });
    expect(step.fabricMayOwn()).toBe(true);
  });

  it("treats a malformed event as no step", () => {
    const step = autopilotStepTools();
    step.set({ tools: "read" });
    expect(step.fabricMayOwn()).toBe(true);
  });
});
