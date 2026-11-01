export const meta = {
  name: "optimize-tests",
  description:
    "Measure and speed up one frontend and one backend test file in parallel; each worker runs its autopilot, a reviewer judges it, and a rejected worker continues in its own session.",
};

const MAX_ROUNDS = 2;

const measurement = {
  type: "object",
  required: ["wallMs", "testsMs", "passed", "failed"],
  properties: {
    wallMs: { type: "number" },
    testsMs: { type: "number" },
    passed: { type: "number" },
    failed: { type: "number" },
  },
};
const improvedReport = {
  type: "object",
  required: ["kind", "file", "before", "after", "change", "filesChanged"],
  properties: {
    kind: { type: "string" },
    file: { type: "string" },
    before: measurement,
    after: measurement,
    change: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
  },
};
const verdict = {
  type: "object",
  required: ["ok", "issues"],
  properties: { ok: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
};

function review(target, report, round) {
  return agent(
    `You review a test optimization for the ${target.kind} test file ${target.file} in the throwaway repo ${args.repo}.\n` +
      `Report of round ${round}:\n${JSON.stringify(report, null, 2)}\n\n` +
      `Accept (ok: true) only if all of these hold, checked against the report and, if you like, the repo itself:\n` +
      `1. A concrete change was made to speed the file up (a measurement alone is not an optimization).\n` +
      `2. "after" was measured by the autopilot and shows no failed tests and the same number of passed tests as "before".\n` +
      `3. after.wallMs or after.testsMs is lower than before; or the report explains convincingly why no safe speedup exists.\n` +
      `4. The change keeps what the tests prove (no deleted assertions, no skipped tests).\n` +
      `Otherwise ok: false with concrete issues the worker can act on. Do not edit any files.`,
    { provider: "pi", model: "openai-codex/gpt-6-astra", reasoningLevel: "medium", title: `Review ${target.kind} · round ${round}`, phase: target.kind, schema: verdict },
  );
}

async function optimize(target) {
  phase(target.kind);
  // Round 1: the worker session runs the autopilot; no model turn, the autopilot reports its value.
  const first = await agent(`/autopilot --report ${target.kind}-tests ${args.repo} ${target.file}`, {
    provider: "pi", model: "openai-codex/gpt-6-astra", reasoningLevel: "medium",
    raw: true,
    report: true,
    keep: true,
    title: `${target.kind} tests`,
    phase: target.kind,
  });
  const session = first.session;
  let report = first.value;
  const rounds = [{ round: 1, session, report }];
  for (let round = 1; ; round += 1) {
    const judged = await review(target, report, round);
    rounds[rounds.length - 1].verdict = judged;
    log(`${target.kind} round ${round}: ${judged.ok ? "accepted" : "rejected"} (worker ${session})`);
    if (judged.ok || round >= MAX_ROUNDS) break;
    // The same worker thread continues: its context and prompt cache carry over.
    const next = await agent(
      `The reviewer rejected round ${round}:\n- ${judged.issues.join("\n- ")}\n\n` +
        `Work only inside ${args.repo}; never touch any other checkout. Speed up ${target.file} without weakening what it proves ` +
        `(you may change the test file and its test helpers). Then measure with the autopilot tool: ` +
        `autopilot({name: "${target.kind}-tests", args: "${args.repo} ${target.file}"}). ` +
        `"before" is the measurement from the /autopilot run above, "after" the new one.`,
      { provider: "pi", model: "openai-codex/gpt-6-astra", reasoningLevel: "medium", session, keep: true, schema: improvedReport, title: `${target.kind} tests · round ${round + 1}`, phase: target.kind },
    );
    report = next.value;
    rounds.push({ round: round + 1, session: next.session, report });
  }
  return { kind: target.kind, file: target.file, rounds };
}

return await parallel(args.targets.map((target) => () => optimize(target)));
