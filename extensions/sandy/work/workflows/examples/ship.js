export const meta = {
  name: "ship",
  description:
    "Review the changes and write release notes in parallel; each worker runs the pi autopilot ship, which steers its own session with step() and per-stage tools.",
  phases: [{ title: "review" }, { title: "release" }],
};

function stage(name, ref) {
  return agent(`/autopilot --report ship ${name}${ref ? ` ${ref}` : ""}`, {
    provider: "pi",
    model: "openai-codex/gpt-6-astra",
    reasoningLevel: "medium",
    // The autopilot runs several turns of its own; only the value it reports ends the call.
    raw: true,
    report: true,
    title: `ship ${name}`,
    phase: name,
  });
}

const [review, release] = await Promise.all([stage("review", args?.base), stage("release", args?.from)]);
const high = (review.findings ?? []).filter((finding) => finding.severity === "high");
log(`review: ${(review.findings ?? []).length} findings (${high.length} high), ${(review.dropped ?? []).length} dropped`);
return { ready: high.length === 0 && !review.error && !release.error, review, release };
