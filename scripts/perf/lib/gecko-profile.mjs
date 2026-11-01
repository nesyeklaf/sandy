import { chunkLabel } from "./sourcemap.mjs";

export const MAX_SAMPLE_WEIGHT_MS = 10;
export const SWITCH_PREFIX = "sandy:switch";
export const LAB_SWITCH = "lab:switch";

const JS_FUNCTION = /^(.*) \((.+):(\d+):(\d+)\)(?:\[\d+\])?$/;
const JS_ANONYMOUS =
  /^((?:https?|chrome|resource|moz-extension|file):.+):(\d+):(\d+)(?:\[\d+\])?$/;

const column = (table, name) => {
  const index = table.schema[name];
  if (index === undefined)
    throw new Error("Gecko profile table has no '" + name + "' column");
  return index;
};

export const profileThreads = (profile) => {
  const threads = [];
  const visit = (node) => {
    for (const thread of node.threads ?? []) threads.push(thread);
    for (const child of node.processes ?? []) visit(child);
  };
  visit(profile);
  return threads;
};

export const userTimings = (thread) => {
  const markers = thread.markers;
  const nameIndex = column(markers, "name");
  const start = column(markers, "startTime");
  const end = column(markers, "endTime");
  const data = column(markers, "data");
  return markers.data
    .filter(
      (row) =>
        row[data]?.type === "UserTiming" && row[data].entryType === "measure",
    )
    .map((row) => ({
      name: row[data].name ?? thread.stringTable[row[nameIndex]],
      start: row[start],
      end: row[end],
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
};

export const contentMainThread = (profile, prefix = SWITCH_PREFIX) => {
  const candidates = profileThreads(profile)
    .filter(
      (thread) => thread.name === "GeckoMain" && thread.processType === "tab",
    )
    .map((thread) => ({
      thread,
      spans: userTimings(thread).filter((timing) =>
        timing.name.startsWith(prefix),
      ).length,
    }))
    .filter((candidate) => candidate.spans > 0)
    .sort((a, b) => b.spans - a.spans);
  return candidates[0]?.thread ?? null;
};

export const styleThreadsOf = (profile, main) =>
  profileThreads(profile).filter(
    (thread) =>
      thread.pid === main.pid && thread.name.startsWith("StyleThread"),
  );

const categoryNames = (categories) => categories.map((entry) => entry.name);

export const stackCategories = (thread, categories) => {
  const stacks = thread.stackTable;
  const frames = thread.frameTable;
  const prefixColumn = column(stacks, "prefix");
  const frameColumn = column(stacks, "frame");
  const categoryColumn = column(frames, "category");
  const subcategoryColumn = column(frames, "subcategory");
  const fallback = Math.max(0, categoryNames(categories).indexOf("Other"));
  const category = new Int32Array(stacks.data.length);
  const subcategory = new Int32Array(stacks.data.length);
  stacks.data.forEach((row, index) => {
    const prefix = row[prefixColumn];
    const frame = frames.data[row[frameColumn]];
    const own = frame?.[categoryColumn];
    if (own !== null && own !== undefined) {
      category[index] = own;
      subcategory[index] = frame[subcategoryColumn] ?? 0;
    } else if (prefix !== null && prefix !== undefined) {
      category[index] = category[prefix];
      subcategory[index] = subcategory[prefix];
    } else {
      category[index] = fallback;
      subcategory[index] = 0;
    }
  });
  return { category, subcategory };
};

export const parseJsFrame = (location) => {
  const named = JS_FUNCTION.exec(location);
  if (named)
    return {
      name: named[1] || "(anonymous)",
      url: named[2],
      line: Number(named[3]),
      column: Number(named[4]),
    };
  const anonymous = JS_ANONYMOUS.exec(location);
  if (anonymous)
    return {
      name: "(anonymous)",
      url: anonymous[1],
      line: Number(anonymous[2]),
      column: Number(anonymous[3]),
    };
  return null;
};

export const jsFrameUrls = (thread) => {
  const locationColumn = column(thread.frameTable, "location");
  const urls = new Set();
  for (const frame of thread.frameTable.data) {
    const parsed = parseJsFrame(thread.stringTable[frame[locationColumn]]);
    if (parsed !== null) urls.add(parsed.url);
  }
  return [...urls];
};

const describeJsFrame = (parsed, resolve) => {
  const mapped = resolve(parsed.url, parsed.line - 1, parsed.column - 1);
  if (mapped !== null)
    return {
      name: parsed.name,
      location: mapped.source + ":" + (mapped.line + 1),
      module: mapped.source,
    };
  return {
    name: parsed.name,
    location: chunkLabel(parsed.url) + ":" + parsed.line + ":" + parsed.column,
    module: chunkLabel(parsed.url),
  };
};

const innermostJsFunctions = (thread, resolve) => {
  const stacks = thread.stackTable;
  const prefixColumn = column(stacks, "prefix");
  const frameColumn = column(stacks, "frame");
  const locationColumn = column(thread.frameTable, "location");
  const byLocation = new Map();
  const functions = [];
  const functionOfFrame = (frameIndex) => {
    const location = thread.frameTable.data[frameIndex]?.[locationColumn];
    if (byLocation.has(location)) return byLocation.get(location);
    const parsed = parseJsFrame(thread.stringTable[location] ?? "");
    let id = -1;
    if (parsed !== null) {
      const described = describeJsFrame(parsed, resolve);
      const key = described.name + " " + described.location;
      id = functions.findIndex((entry) => entry.key === key);
      if (id === -1) {
        id = functions.length;
        functions.push({ key, ...described });
      }
    }
    byLocation.set(location, id);
    return id;
  };
  const owner = new Int32Array(stacks.data.length);
  stacks.data.forEach((row, index) => {
    const own = functionOfFrame(row[frameColumn]);
    const prefix = row[prefixColumn];
    owner[index] =
      own !== -1
        ? own
        : prefix === null || prefix === undefined
          ? -1
          : owner[prefix];
  });
  return { owner, functions };
};

export const timedSamples = (thread, maxWeightMs = MAX_SAMPLE_WEIGHT_MS) => {
  const samples = thread.samples;
  const stack = column(samples, "stack");
  const time = column(samples, "time");
  const cpu = samples.schema.threadCPUDelta;
  const rows = samples.data;
  return rows.map((row, index) => ({
    stack: row[stack],
    time: row[time],
    previous: index > 0 ? rows[index - 1][time] : null,
    weight: Math.min(
      (rows[index + 1]?.[time] ?? row[time]) - row[time],
      maxWeightMs,
    ),
    cpuMs: cpu === undefined ? null : (row[cpu] ?? 0) / 1e6,
  }));
};

const overlapOf = (start, end, window) =>
  Math.max(0, Math.min(end, window.end) - Math.max(start, window.start));

const cpuInWindow = (samples, window) => {
  let total = 0;
  let measured = false;
  for (const sample of samples) {
    if (sample.cpuMs === null || sample.previous === null) continue;
    measured = true;
    if (sample.time <= window.start || sample.previous >= window.end) continue;
    const span = sample.time - sample.previous;
    total +=
      span <= 0
        ? sample.cpuMs
        : (sample.cpuMs * overlapOf(sample.previous, sample.time, window)) /
          span;
  }
  return measured ? total : null;
};

const round2 = (value) =>
  value === null ? null : Math.round(value * 100) / 100;

const sortedEntries = (totals, limit) =>
  [...totals.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map((entry) => ({ ...entry, ms: round2(entry.ms) }));

const markerTotals = (thread, window, limit) => {
  const markers = thread.markers;
  const nameIndex = column(markers, "name");
  const start = column(markers, "startTime");
  const end = column(markers, "endTime");
  const data = column(markers, "data");
  const totals = new Map();
  for (const row of markers.data) {
    const type = row[data]?.type;
    if (type === "UserTiming" || row[start] === null || row[end] === null)
      continue;
    const ms = overlapOf(row[start], row[end], window);
    if (ms <= 0) continue;
    const name = thread.stringTable[row[nameIndex]];
    const current = totals.get(name) ?? { name, ms: 0, count: 0 };
    current.ms += ms;
    current.count += 1;
    totals.set(name, current);
  }
  return sortedEntries(totals, limit);
};

export const createProfileAnalysis = (
  profile,
  { resolve = () => null, prefix = SWITCH_PREFIX } = {},
) => {
  const main = contentMainThread(profile, prefix);
  if (main === null) return null;
  const categories = profile.meta.categories;
  const names = categoryNames(categories);
  const idle = names.indexOf("Idle");
  const javaScript = names.indexOf("JavaScript");
  const { category, subcategory } = stackCategories(main, categories);
  const { owner, functions } = innermostJsFunctions(main, resolve);
  const samples = timedSamples(main);
  const styleSamples = styleThreadsOf(profile, main).map((thread) => ({
    name: thread.name,
    samples: timedSamples(thread),
  }));

  const attribute = (window, { limit = 15 } = {}) => {
    const byCategory = new Map();
    const byFunction = new Map();
    const byModule = new Map();
    let sampledMs = 0;
    let idleMs = 0;
    for (const sample of samples) {
      if (sample.stack === null || sample.stack === undefined) continue;
      const ms = overlapOf(sample.time, sample.time + sample.weight, window);
      if (ms <= 0) continue;
      const categoryIndex = category[sample.stack];
      if (categoryIndex === idle) {
        idleMs += ms;
        continue;
      }
      sampledMs += ms;
      const categoryName = names[categoryIndex] ?? "Other";
      const subcategoryName =
        categories[categoryIndex]?.subcategories?.[subcategory[sample.stack]] ??
        "Other";
      const entry = byCategory.get(categoryName) ?? {
        category: categoryName,
        ms: 0,
        subcategories: new Map(),
      };
      entry.ms += ms;
      entry.subcategories.set(
        subcategoryName,
        (entry.subcategories.get(subcategoryName) ?? 0) + ms,
      );
      byCategory.set(categoryName, entry);
      const functionIndex = owner[sample.stack];
      if (functionIndex === -1) continue;
      const fn = functions[functionIndex];
      const current = byFunction.get(fn.key) ?? {
        name: fn.name,
        location: fn.location,
        ms: 0,
        jsMs: 0,
      };
      current.ms += ms;
      if (categoryIndex === javaScript) current.jsMs += ms;
      byFunction.set(fn.key, current);
      const module = byModule.get(fn.module) ?? { module: fn.module, ms: 0 };
      module.ms += ms;
      byModule.set(fn.module, module);
    }
    const stylo = styleSamples.map(({ name, samples: threadSamples }) => ({
      name,
      cpuMs: cpuInWindow(threadSamples, window),
    }));
    const styloMeasured = stylo.filter((entry) => entry.cpuMs !== null);
    return {
      name: window.name,
      start: window.start,
      durationMs: round2(window.end - window.start),
      sampledMs: round2(sampledMs),
      idleMs: round2(idleMs),
      mainCpuMs: round2(cpuInWindow(samples, window)),
      categories: [...byCategory.values()]
        .sort((a, b) => b.ms - a.ms)
        .map((entry) => ({
          category: entry.category,
          ms: round2(entry.ms),
          subcategories: [...entry.subcategories.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, ms]) => ({ name, ms: round2(ms) })),
        })),
      functions: [...byFunction.values()]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, limit)
        .map((entry) => ({
          ...entry,
          ms: round2(entry.ms),
          jsMs: round2(entry.jsMs),
        })),
      modules: sortedEntries(byModule, 10),
      styloMs:
        styloMeasured.length === 0
          ? null
          : round2(styloMeasured.reduce((sum, entry) => sum + entry.cpuMs, 0)),
      styloThreads: stylo.map((entry) => ({
        name: entry.name,
        cpuMs: round2(entry.cpuMs),
      })),
      markers: markerTotals(main, window, 12),
    };
  };

  return { thread: main, timings: userTimings(main), attribute };
};

export const switchWindows = (timings) => {
  const totals = timings.filter((timing) => timing.name === SWITCH_PREFIX);
  return totals.map((total) => ({
    ...total,
    phases: timings
      .filter(
        (timing) =>
          timing.name.startsWith(SWITCH_PREFIX + ":") &&
          timing.start >= total.start - 0.5 &&
          timing.end <= total.end + 0.5,
      )
      .map((timing) => ({
        ...timing,
        phase: timing.name.slice(SWITCH_PREFIX.length + 1),
      })),
  }));
};

export const matchLabWindows = (timings, switches) =>
  timings
    .filter((timing) => timing.name === LAB_SWITCH)
    .map((lab) => ({
      lab,
      app:
        switches.find(
          (candidate) =>
            candidate.start >= lab.start - 50 && candidate.start <= lab.end,
        ) ?? null,
    }));

export const analyzeSwitches = (profile, options = {}) => {
  const analysis = createProfileAnalysis(profile, options);
  if (analysis === null) return null;
  const switches = switchWindows(analysis.timings);
  return {
    thread: {
      pid: analysis.thread.pid,
      tid: analysis.thread.tid,
      processName: analysis.thread.processName ?? null,
    },
    windows: matchLabWindows(analysis.timings, switches).map(
      ({ lab, app }) => ({
        lab: analysis.attribute(lab, options),
        app: app === null ? null : analysis.attribute(app, options),
        phases:
          app === null
            ? []
            : app.phases.map((phase) => ({
                phase: phase.phase,
                ...analysis.attribute(phase, options),
              })),
      }),
    ),
  };
};

const meanOf = (lists, keyOf, valueOf, count) => {
  const totals = new Map();
  for (const list of lists)
    for (const entry of list) {
      const key = keyOf(entry);
      const current = totals.get(key) ?? { entry, sums: {} };
      for (const [field, value] of Object.entries(valueOf(entry)))
        current.sums[field] = (current.sums[field] ?? 0) + (value ?? 0);
      totals.set(key, current);
    }
  return [...totals.values()].map(({ entry, sums }) => ({
    ...entry,
    ...Object.fromEntries(
      Object.entries(sums).map(([field, sum]) => [field, round2(sum / count)]),
    ),
  }));
};

export const summarizeWindows = (attributions, limit = 15) => {
  const count = attributions.length;
  if (count === 0) return null;
  const mean = (field) =>
    round2(
      attributions.reduce((sum, entry) => sum + (entry[field] ?? 0), 0) / count,
    );
  return {
    windows: count,
    durationMs: mean("durationMs"),
    sampledMs: mean("sampledMs"),
    idleMs: mean("idleMs"),
    mainCpuMs: mean("mainCpuMs"),
    styloMs: mean("styloMs"),
    categories: meanOf(
      attributions.map((entry) => entry.categories),
      (entry) => entry.category,
      (entry) => ({ ms: entry.ms }),
      count,
    )
      .map(({ subcategories, ...rest }) => ({
        ...rest,
        subcategories: meanOf(
          attributions.map(
            (entry) =>
              entry.categories.find((item) => item.category === rest.category)
                ?.subcategories ?? [],
          ),
          (item) => item.name,
          (item) => ({ ms: item.ms }),
          count,
        ).sort((a, b) => b.ms - a.ms),
      }))
      .sort((a, b) => b.ms - a.ms),
    functions: meanOf(
      attributions.map((entry) => entry.functions),
      (entry) => entry.name + " " + entry.location,
      (entry) => ({ ms: entry.ms, jsMs: entry.jsMs }),
      count,
    )
      .sort((a, b) => b.ms - a.ms)
      .slice(0, limit),
    modules: meanOf(
      attributions.map((entry) => entry.modules),
      (entry) => entry.module,
      (entry) => ({ ms: entry.ms }),
      count,
    )
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10),
    markers: meanOf(
      attributions.map((entry) => entry.markers),
      (entry) => entry.name,
      (entry) => ({ ms: entry.ms, count: entry.count }),
      count,
    )
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 12),
  };
};
