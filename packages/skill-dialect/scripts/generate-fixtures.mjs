import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = process.argv[2] ?? join(homedir(), ".agents", "skills");
const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
);
const skills = ["full-control", "full-send"];

const quote = (value) => JSON.stringify(value);
const list = (items) => quote(items.join(", "));

function attrs(pairs) {
  return pairs
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) =>
      typeof value === "string"
        ? `${name}=${quote(value)}`
        : `${name}=${String(value)}`,
    )
    .join(" ");
}

function allowTag(allow) {
  const subagents = allow.subagents?.map(
    (s) => `${s.agent ?? ""}${s.model === undefined ? "" : `@${s.model}`}`,
  );
  return `{% allow ${attrs([
    [
      "skills",
      allow.skills === undefined ? undefined : allow.skills.join(", "),
    ],
    ["edits", allow.edits],
    ["subagents", subagents === undefined ? undefined : subagents.join(", ")],
    [
      "deny",
      allow.denyTools === undefined ? undefined : allow.denyTools.join(", "),
    ],
  ])} /%}`;
}

function gateTag(rule) {
  const pairs = [["type", rule.type]];
  if (rule.type === "user") pairs.push(["prompt", rule.prompt]);
  if (rule.type === "check")
    pairs.push(
      ["command", rule.command],
      ["label", rule.label],
      ["timeout", rule.timeoutSec],
    );
  if (rule.type === "evidence")
    pairs.push(
      ["name", rule.name],
      ["description", rule.description],
      ["ran", rule.ran],
    );
  if (rule.type === "goal")
    pairs.push(["label", rule.label], ["optional", rule.optional]);
  return `{% gate ${attrs(pairs)} /%}`;
}

function stageTags(stage) {
  const lines = [
    `{% stage ${attrs([
      ["id", stage.id],
      ["title", stage.title],
      ["autopilot", stage.autopilot?.name],
      ["args", stage.autopilot?.args],
    ])} %}`,
  ];
  if (stage.description !== undefined && stage.description.trim() !== "")
    lines.push(stage.description.trim());
  for (const input of stage.inputs ?? [])
    lines.push(`{% needs ${quote(input)} /%}`);
  for (const output of stage.outputs ?? [])
    lines.push(
      `{% output ${attrs([
        ["name", output.name],
        ["description", output.description],
        ["optional", output.optional],
      ])} /%}`,
    );
  if (stage.allow !== undefined) lines.push(allowTag(stage.allow));
  for (const rule of stage.gate ?? []) lines.push(gateTag(rule));
  for (const edge of stage.next ?? []) {
    const head = attrs([
      ["to", edge.to],
      ["label", edge.when],
    ]);
    if (edge.gate === undefined) lines.push(`{% next ${head} /%}`);
    else
      lines.push(
        `{% next ${head} %}`,
        ...edge.gate.map(gateTag),
        "{% /next %}",
      );
  }
  lines.push("{% /stage %}");
  return lines.join("\n");
}

function generate(name) {
  const skill = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
  const stagesJson = readFileSync(join(skillsDir, name, "stages.json"), "utf8");
  const machine = JSON.parse(stagesJson);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  if (match === null) throw new Error(`${name}: SKILL.md has no frontmatter`);
  if (/^metadata:/m.test(match[1]))
    throw new Error(`${name}: SKILL.md already has metadata`);
  const prose = skill.slice(match[0].length).trimEnd();
  const parts = [`---\n${match[1]}\nmetadata:\n  dialect: "1"\n---\n${prose}`];
  if (machine.allow !== undefined) parts.push(allowTag(machine.allow));
  if (machine.start !== undefined && machine.start !== machine.stages[0].id)
    throw new Error(
      `${name}: start is not the first stage; the generator does not write start=true`,
    );
  parts.push(...machine.stages.map(stageTags));
  writeFileSync(join(fixturesDir, `${name}.md`), `${parts.join("\n\n")}\n`);
  writeFileSync(join(fixturesDir, `${name}.stages.json`), stagesJson);
}

for (const name of skills) generate(name);
