export interface ServerTimingMetric {
  name: string;
  duration: number;
}

export interface RequestTiming {
  startTime: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  serverTiming: readonly ServerTimingMetric[];
}

export interface NetworkPhases {
  server?: number;
  network: number;
}

const END_SLACK_MS = 2;

export function serverMs(request: RequestTiming): number | null {
  if (request.serverTiming.length === 0) return null;
  const total = request.serverTiming.find((metric) => metric.name === "total");
  if (total) return total.duration;
  return Math.max(...request.serverTiming.map((metric) => metric.duration));
}

export function waitMs(request: RequestTiming): number {
  return request.requestStart > 0 ? Math.max(0, request.responseStart - request.requestStart) : 0;
}

function round(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

export function deriveNetworkPhases(requests: readonly RequestTiming[], start: number, end: number): NetworkPhases | null {
  const onPath = requests
    .filter((request) => request.startTime >= start && request.startTime <= end && request.responseEnd <= end + END_SLACK_MS)
    .sort((a, b) => a.startTime - b.startTime);
  if (onPath.length === 0) return null;
  const gating: RequestTiming[] = [];
  let clusterEnd = -Infinity;
  for (const request of onPath) {
    const last = gating[gating.length - 1];
    if (last === undefined || request.startTime >= clusterEnd) {
      gating.push(request);
      clusterEnd = request.responseEnd;
    } else if (request.responseEnd > clusterEnd) {
      gating[gating.length - 1] = request;
      clusterEnd = request.responseEnd;
    }
  }
  let server = 0;
  let network = 0;
  let timed = false;
  for (const request of gating) {
    const wait = waitMs(request);
    const spent = serverMs(request);
    if (spent === null) {
      network += wait;
    } else {
      timed = true;
      const counted = Math.min(spent, wait > 0 ? wait : spent);
      server += counted;
      network += Math.max(0, wait - counted);
    }
  }
  return timed ? { server: round(server), network: round(network) } : { network: round(network) };
}
