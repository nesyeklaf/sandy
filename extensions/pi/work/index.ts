// pi/work: one pi extension for work in a session. Each part keeps its folder and tests; this file registers
// them. link first: it sets PI_GOAL_HEADLESS before goal/ reads it. Every tool_call handler goes through one
// gate (gate.ts): delegate, track and autopilot decide first, the goal's bookkeeping sees only allowed calls.
// tasks: every session's task list (tasks/), kept as session entries that sandy/work/goals reads.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolCallGate } from "./gate.ts";
import link from "./link.ts";
import goal from "./goal/extensions/goal.ts";
import track from "./track/src/extension.ts";
import autopilot from "./autopilot/autopilot.ts";
import delegate from "./delegate/gate.ts";
import tasks from "./tasks/tasks.ts";

export default function work(pi: ExtensionAPI): void {
  const gate = new ToolCallGate();
  link(gate.view(pi, "link", 0));
  goal(gate.view(pi, "goal", 9));
  track(gate.view(pi, "track", 2));
  autopilot(gate.view(pi, "autopilot", 3));
  delegate(gate.view(pi, "delegate", 1));
  tasks(gate.view(pi, "tasks", 8));
  pi.on("tool_call", gate.handle);
}
