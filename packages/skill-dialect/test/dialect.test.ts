import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkValue,
  deriveValues,
  evaluate,
  formatProblem,
  parseSkill,
  renderPreamble,
  renderStage,
  renderTrackSkillRead,
  type CompiledMachine,
} from "../src/index.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const thinkItThrough = fixture("think-it-through.md");

function compiled(source: string, file = "skill.md"): CompiledMachine {
  const result = parseSkill(source, file);
  if (!result.ok)
    throw new Error(result.problems.map(formatProblem).join("\n"));
  return result.machine;
}

function stage(machine: CompiledMachine, id: string) {
  const found = machine.stages.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no stage ${id}`);
  return found;
}

function lineOf(source: string, needle: string): number {
  return source.slice(0, source.indexOf(needle)).split("\n").length;
}

const musts = "1. fast\n2. cheap";

describe("think-it-through", () => {
  const machine = compiled(thinkItThrough, "think-it-through.md");

  it("compiles stages, inputs, derive and the decided edges", () => {
    expect(machine.id).toBe("think-it-through");
    expect(machine.title).toBe("Think it through");
    expect(machine.stages.map((s) => s.id)).toEqual([
      "frame",
      "ask",
      "weigh",
      "premortem",
      "review",
      "decide",
    ]);
    expect(machine.inputs?.map((i) => i.name)).toEqual(["Task", "Choice"]);
    expect(machine.result).toEqual([
      { name: "Pick", from: "weigh.Pick" },
      { name: "Premortem", from: "premortem.Premortem" },
    ]);
    expect(stage(machine, "weigh").inputs).toEqual([
      "frame.Frame",
      "review.Checks",
    ]);
    const review = stage(machine, "review");
    expect(review.next.map((e) => e.to)).toEqual(["weigh", "decide", "done"]);
    expect(review.next[0]).toMatchObject({
      max: 2,
      exceeded: "owner",
      cond: { fn: "equals", ref: "review.Verdict", value: "fix" },
    });
    expect(review.next[2]?.cond).toBeUndefined();
    expect(stage(machine, "ask").gate).toEqual([{ type: "user" }]);
  });

  it("renders weigh without the review paragraph before any review and with it after a broken must", () => {
    const weigh = stage(machine, "weigh");
    const before = renderStage(weigh, {
      "input.Choice": "A or B",
      "frame.Frame": "the frame",
    });
    expect(before).toBe(
      "Use the skill weigh-options.\n\nUse weigh-options on A or B with this frame: the frame",
    );
    const after = renderStage(weigh, {
      "input.Choice": "A or B",
      "frame.Frame": "the frame",
      "frame.Musts": musts,
      "review.Checks": "- 1: met\n- 2: broken — costs too much",
    });
    expect(after).toContain(
      "The last review found broken musts:\n- 1. fast: met\n- 2. cheap: broken — costs too much\nAddress those first.",
    );
    expect(after).not.toMatch(/\{%|\$review/);
  });

  it("renders the same scope to the same bytes", () => {
    const review = stage(machine, "review");
    const scope = { "frame.Musts": musts, "weigh.Pick": "A" };
    expect(renderStage(review, scope)).toBe(renderStage(review, { ...scope }));
    expect(compiled(thinkItThrough)).toEqual(compiled(thinkItThrough));
    expect(renderStage(review, scope)).toContain(
      "Premortem: (not produced yet)",
    );
  });

  it("derives the verdict from the map of checks", () => {
    const review = stage(machine, "review");
    const scope = (checks: string) => ({
      "frame.Musts": musts,
      "review.Checks": checks,
    });
    expect(deriveValues(review, scope("- 1: met\n- 2: broken — no"))).toEqual({
      "review.Verdict": "fix",
    });
    expect(
      deriveValues(review, scope("- 1: unclear — maybe\n- 2: met")),
    ).toEqual({ "review.Verdict": "owner" });
    expect(deriveValues(review, scope("- 1: met\n- 2: met"))).toEqual({
      "review.Verdict": "pass",
    });
  });

  it("strips tags from the preamble and lists the run inputs", () => {
    const preamble = renderPreamble(thinkItThrough);
    expect(preamble).toContain("# Think it through");
    expect(preamble).toContain("- Input Task (text)");
    expect(preamble).not.toContain("{%");
    const read = renderTrackSkillRead(thinkItThrough);
    expect(read).toContain(
      'stage_start({skill: "think-it-through", inputs: {"Task": "...", "Choice": "..."}})',
    );
    expect(read?.startsWith("---\nname: think-it-through\n")).toBe(true);
    expect(
      renderTrackSkillRead("---\nname: plain\n---\n# Plain\n"),
    ).toBeUndefined();
  });
});

describe("broken skills", () => {
  const broken = (from: string, to: string) => {
    expect(thinkItThrough).toContain(from);
    const source = thinkItThrough.replace(from, to);
    const result = parseSkill(source, "broken.md");
    if (result.ok) throw new Error("expected problems");
    return { problems: result.problems, line: lineOf(source, to) };
  };

  it("names an unknown next target with its line and the stage ids", () => {
    const { problems, line } = broken(
      '{% next to="premortem"',
      '{% next to="premortm"',
    );
    expect(problems).toEqual([
      expect.objectContaining({
        file: "broken.md",
        line,
        tag: "next",
        message: 'next to="premortm" is not a stage',
      }),
    ]);
    expect(problems[0]?.fix).toContain("premortem");
  });

  it("refuses a condition other than present on a text output", () => {
    const { problems, line } = broken(
      'when=equals($frame.Clear, "no")',
      'when=equals($frame.Frame, "no")',
    );
    expect(problems).toEqual([
      expect.objectContaining({ file: "broken.md", line, tag: "next" }),
    ]);
    expect(problems[0]?.message).toContain("free text");
    expect(problems[0]?.fix).toContain("present($frame.Frame)");
  });

  it("refuses an unknown tag", () => {
    const { problems, line } = broken(
      '{% output name="Pick" type="text" /%}',
      '{% pick name="Pick" type="text" /%}',
    );
    expect(
      problems.some(
        (p) => p.tag === "pick" && p.line === line && p.fix.includes("output"),
      ),
    ).toBe(true);
    expect(formatProblem(problems.find((p) => p.tag === "pick")!)).toMatch(
      /^broken\.md:\d+ pick: unknown tag \{% pick %\} — use one of: /,
    );
  });

  it("refuses an unknown attribute, equals outside the choice, and next inside if", () => {
    expect(
      broken('{% next to="premortem"', '{% next too="x" to="premortem"')
        .problems[0]?.message,
    ).toBe("unknown attribute too on {% next %}");
    expect(
      broken('equals($frame.Clear, "no")', 'equals($frame.Clear, "nope")')
        .problems[0]?.fix,
    ).toBe("use one of: yes, no");
    const nested = broken(
      "Address those first.",
      'Address those first.\n{% next to="done" label="x" /%}',
    );
    expect(nested.problems[0]?.message).toBe("{% next %} inside an if");
  });
});

describe("values", () => {
  const scope = { "frame.Musts": musts };
  const map = "map($frame.Musts, choice(met, broken, unclear))";

  it("refuses a value outside the choice and names the allowed values", () => {
    expect(checkValue(map, "- 1: nope — x\n- 2: met", scope)).toEqual({
      ok: false,
      error: 'position 1: "nope" is not one of: met, broken, unclear',
    });
    expect(checkValue("choice(yes, no)", "maybe", {})).toEqual({
      ok: false,
      error: '"maybe" is not one of: yes, no',
    });
  });

  it("refuses missing, duplicate and extra map positions and a missing reason", () => {
    expect(checkValue(map, "- 1: met", scope)).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing positions: 2"),
    });
    expect(
      checkValue(map, "- 1: met\n- 1: met\n- 2: met", scope),
    ).toMatchObject({ ok: false, error: "position 1 is given twice" });
    expect(
      checkValue(map, "- 1: met\n- 2: met\n- 3: met", scope),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("position 3"),
    });
    expect(checkValue(map, "- 1: met\n- 2: broken", scope)).toMatchObject({
      ok: false,
      error: expect.stringContaining("reason is required"),
    });
    expect(checkValue(map, "- 2: met\n- 1: broken — slow", scope)).toEqual({
      ok: true,
      value: "- 1: broken — slow\n- 2: met",
    });
  });

  it("refuses empty, duplicate and misnumbered list entries", () => {
    expect(checkValue("list(text)", "", {})).toMatchObject({
      ok: false,
      error: "the list is empty",
    });
    expect(checkValue("list(text)", "1. a\n2. a", {})).toMatchObject({
      ok: false,
      error: 'entry "a" is listed twice',
    });
    expect(checkValue("list(text)", "1. a\n3. b", {})).toMatchObject({
      ok: false,
    });
    expect(checkValue("list(text)", " 1.  a \n2. b", {})).toEqual({
      ok: true,
      value: "1. a\n2. b",
    });
  });

  it("makes every function false on an absent value", () => {
    expect(evaluate({ fn: "present", ref: "a.B" }, {})).toBe(false);
    expect(evaluate({ fn: "equals", ref: "a.B", value: "x" }, {})).toBe(false);
    expect(evaluate({ fn: "any", ref: "a.B", value: "x" }, {})).toBe(false);
    expect(evaluate({ fn: "all", ref: "a.B", value: "x" }, {})).toBe(false);
    expect(
      evaluate(
        { fn: "all", ref: "a.B", value: "met" },
        { "a.B": "- 1: met\n- 2: met" },
      ),
    ).toBe(true);
  });
});
