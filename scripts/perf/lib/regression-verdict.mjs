const LOST_SHARE_TOLERANCE = 0.2;

export const metricKey = (row) => row.kind + " " + row.visit;

const validShare = (row, variant) =>
  row.attempts[variant] === 0
    ? null
    : row.samples[variant] / row.attempts[variant];

export const judgeComparison = (row, budget) => {
  const shareA = validShare(row, "a");
  const shareB = validShare(row, "b");
  if (
    shareA !== null &&
    shareB !== null &&
    shareB < shareA - LOST_SHARE_TOLERANCE
  )
    return {
      status: "fail",
      reason:
        "head finished " +
        row.samples.b +
        " of " +
        row.attempts.b +
        " actions, base " +
        row.samples.a +
        " of " +
        row.attempts.a,
    };
  if (row.delta === null || row.low === null || row.high === null)
    return {
      status: budget ? "inconclusive" : "no-data",
      reason:
        "too few valid samples (base " +
        row.samples.a +
        "/" +
        row.attempts.a +
        ", head " +
        row.samples.b +
        "/" +
        row.attempts.b +
        ")",
    };
  const slower = row.low > 0;
  if (slower && budget) {
    const overMs = row.delta > budget.budgetMs;
    const overPct =
      row.relative !== null && row.relative * 100 > budget.budgetPct;
    if (overMs && overPct)
      return {
        status: "fail",
        reason:
          "slower by more than " +
          budget.budgetMs +
          " ms and " +
          budget.budgetPct +
          "%",
      };
  }
  if (slower) return { status: "slower-within-budget", reason: null };
  if (row.high < 0) return { status: "faster", reason: null };
  return { status: "same", reason: null };
};

const overallVerdict = (rows, inconclusive) => {
  if (rows.some((row) => row.status === "fail")) return "FAIL";
  return inconclusive.length > 0 ? "INCONCLUSIVE" : "PASS";
};

export const evaluateBudgets = (report, budgets) => {
  const warnings = [];
  const inconclusive = [];
  if (!(report.rounds > 0)) inconclusive.push("No round ran.");
  const ceilingsApply = report.cpuThrottle === budgets.cpuThrottle;
  if (!ceilingsApply)
    warnings.push(
      "Ceilings are set for CPU throttle " +
        budgets.cpuThrottle +
        "x; this run used " +
        report.cpuThrottle +
        "x, so they were not checked.",
    );
  const rows = report.comparisons.map((comparison) => {
    const key = metricKey(comparison);
    const budget = budgets.metrics[key] ?? null;
    if (budget === null) warnings.push("No budget for " + key + ".");
    const judgement = judgeComparison(comparison, budget);
    if (judgement.status === "no-data")
      warnings.push(key + ": " + judgement.reason + ".");
    if (judgement.status === "inconclusive")
      inconclusive.push(key + ": " + judgement.reason + ".");
    const ceilingExceeded =
      ceilingsApply &&
      budget !== null &&
      comparison.b !== null &&
      comparison.b > budget.ceilingMs;
    if (ceilingExceeded)
      warnings.push(
        key +
          ": head median " +
          Math.round(comparison.b) +
          " ms is above the " +
          budget.ceilingMs +
          " ms ceiling.",
      );
    return {
      key,
      label: budget?.label ?? key,
      a: comparison.a,
      b: comparison.b,
      delta: comparison.delta,
      relative: comparison.relative ?? null,
      low: comparison.low,
      high: comparison.high,
      samples: comparison.samples,
      attempts: comparison.attempts,
      budgetMs: budget?.budgetMs ?? null,
      budgetPct: budget?.budgetPct ?? null,
      ceilingMs: budget?.ceilingMs ?? null,
      ceilingExceeded,
      ...judgement,
    };
  });
  for (const key of Object.keys(budgets.metrics))
    if (!rows.some((row) => row.key === key))
      inconclusive.push(key + " has a budget but was not measured.");
  return {
    verdict: overallVerdict(rows, inconclusive),
    rows,
    warnings,
    inconclusive,
  };
};

const STATUS_TEXT = {
  fail: "**FAIL**",
  "slower-within-budget": "slower, within budget",
  faster: "faster",
  same: "no difference",
  "no-data": "no data",
  inconclusive: "**INCONCLUSIVE**",
};

const ms = (value) =>
  value === null || value === undefined ? "-" : String(Math.round(value));

const signedMs = (value) =>
  value === null || value === undefined
    ? "-"
    : (value > 0 ? "+" : "") + Math.round(value);

export const REPORT_MARKER = "<!-- sandy-perf-regression -->";

export const renderMarkdown = ({ evaluation, base, head, report }) => {
  const lines = [
    REPORT_MARKER,
    "## Performance regression check: " + evaluation.verdict,
    "",
    "Base `" +
      base.sha.slice(0, 9) +
      "` (" +
      base.ref +
      ") against head `" +
      head.sha.slice(0, 9) +
      "` (" +
      head.ref +
      "), " +
      report.rounds +
      " interleaved rounds, CPU " +
      report.cpuThrottle +
      "x slower, viewport " +
      report.viewport +
      ". Wait from input until the frame after the content is usable, median ms.",
    "",
    "| Metric | Base | Head | Head - base | 95% CI | Budget | Valid/tried (base, head) | Verdict |",
    "| --- | ---: | ---: | ---: | --- | --- | --- | --- |",
  ];
  for (const row of evaluation.rows)
    lines.push(
      "| " +
        row.label +
        " | " +
        ms(row.a) +
        " | " +
        ms(row.b) +
        (row.ceilingExceeded ? " :warning:" : "") +
        " | " +
        signedMs(row.delta) +
        (row.relative === null || row.relative === undefined
          ? ""
          : " (" +
            (row.relative > 0 ? "+" : "") +
            Math.round(row.relative * 100) +
            "%)") +
        " | " +
        (row.low === null
          ? "-"
          : "[" + signedMs(row.low) + ", " + signedMs(row.high) + "]") +
        " | " +
        (row.budgetMs === null
          ? "-"
          : "+" + row.budgetMs + " ms and +" + row.budgetPct + "%") +
        " | " +
        row.samples.a +
        "/" +
        row.attempts.a +
        ", " +
        row.samples.b +
        "/" +
        row.attempts.b +
        " | " +
        STATUS_TEXT[row.status] +
        (row.reason && (row.status === "fail" || row.status === "inconclusive")
          ? ": " + row.reason
          : "") +
        " |",
    );
  lines.push(
    "",
    "A metric fails only when the whole 95% bootstrap interval of head - base is above zero and the median got slower by more than both budgets. A budgeted metric without enough valid rounds on either side makes the check inconclusive. Ceilings (:warning:) only warn.",
  );
  if (evaluation.inconclusive.length > 0) {
    lines.push("", "Inconclusive because:", "");
    for (const reason of evaluation.inconclusive) lines.push("- " + reason);
  }
  if (evaluation.warnings.length > 0) {
    lines.push("", "Warnings:", "");
    for (const warning of evaluation.warnings) lines.push("- " + warning);
  }
  return lines.join("\n") + "\n";
};
