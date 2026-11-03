import type { SkillInfo } from "./check.ts";
import type { Flow, FlowNode, SkillNode, Wire } from "./graph.ts";
import { parseIo } from "./io.ts";

const io = (text: string) => parseIo(text).fields;

export const UX_SKILLS: SkillInfo[] = [
  { name: "frame-the-problem", purpose: "Say what the task is for", inputs: io("feature: text"), outputs: io("frame.md: file(frame.md)") },
  { name: "ux-users", purpose: "Model who uses it and why", inputs: io("frame: file"), outputs: io("user_model.md: file(user_model.md)") },
  { name: "ux-journeys", purpose: "Two journeys that differ on one axis", inputs: io("frame: file; users?: file"), outputs: io("journeys.md: file(journeys.md)") },
  { name: "prototype", purpose: "Build a throwaway prototype per variant", inputs: io("journeys: file"), outputs: io("prototypes: file") },
  { name: "ux-walkthrough", purpose: "Fresh-eyes walkthrough", inputs: io("artifact?: text"), outputs: io("walkthrough_report.md: file(walkthrough_report.md)") },
];

export function skillNode(id: string, skill: string, binds: Record<string, [string, string]> = {}): SkillNode {
  const info = UX_SKILLS.find((item) => item.name === skill);
  if (info === undefined) throw new Error("unknown fixture skill " + skill);
  return {
    id,
    kind: "skill",
    name: skill,
    x: 0,
    y: 0,
    skill,
    instruction: "",
    inputs: info.inputs.map((input) => {
      const bind = binds[input.name];
      return { ...input, bind: bind === undefined ? null : { nodeId: bind[0], port: bind[1] } };
    }),
    outputs: info.outputs.map((output) => ({ ...output, path: null })),
  };
}

export function wire(id: string, from: string, to: string, port = 0): Wire {
  return { id, from, port, to };
}

export function uxFlow(): Flow {
  const nodes: FlowNode[] = [
    {
      id: "input",
      kind: "input",
      name: "Run settings",
      x: 0,
      y: 0,
      fields: [
        { name: "feature", type: "text", options: [], prompt: "What feature should the flow design?" },
        { name: "depth", type: "choice", options: ["quick", "medium", "deep"], prompt: "How deep should the design go?" },
      ],
    },
    skillNode("frame", "frame-the-problem", { feature: ["input", "feature"] }),
    skillNode("users", "ux-users", { frame: ["frame", "frame.md"] }),
    skillNode("journeys", "ux-journeys", { frame: ["frame", "frame.md"], users: ["users", "user_model.md"] }),
    {
      id: "fork",
      kind: "fork",
      name: "Fork by depth",
      x: 0,
      y: 0,
      choice: { nodeId: "input", port: "depth" },
      paths: [
        { label: "Quick", note: "skip" },
        { label: "Medium", note: "skip" },
        { label: "Deep", note: "" },
      ],
      otherwise: null,
    },
    skillNode("proto", "prototype", { journeys: ["journeys", "journeys.md"] }),
    skillNode("walk", "ux-walkthrough", { artifact: ["journeys", "journeys.md"] }),
    {
      id: "gate",
      kind: "gate",
      question: "Keep the journeys or fix them?",
      x: 0,
      y: 0,
      owner: "owner",
      options: ["keep", "fix"],
      material: [{ nodeId: "walk", port: "walkthrough_report.md" }],
      ends: [],
    },
    { id: "out", kind: "output", label: "ux_brief.md", x: 0, y: 0, source: { nodeId: "journeys", port: "journeys.md" }, deliverable: true },
  ];
  return {
    version: 2,
    id: "ux",
    useCaseId: "design",
    name: "UX design",
    description: "Design a feature's UX at a chosen depth",
    nodes,
    wires: [
      wire("w1", "input", "frame"),
      wire("w2", "frame", "users"),
      wire("w3", "users", "journeys"),
      wire("w4", "journeys", "fork"),
      wire("w5", "fork", "walk", 0),
      wire("w6", "fork", "walk", 1),
      wire("w7", "fork", "proto", 2),
      wire("w8", "proto", "walk"),
      wire("w9", "walk", "gate"),
      wire("w10", "gate", "out", 0),
      wire("w11", "gate", "journeys", 1),
    ],
  };
}

export function edit(flow: Flow, id: string, change: (node: FlowNode) => FlowNode): Flow {
  return { ...flow, nodes: flow.nodes.map((node) => (node.id === id ? change(node) : node)) };
}
