import { createDbTimeAccumulator, runWithDbTimeAccumulator } from "@sandy/db";
import type { Context, MiddlewareHandler, Next } from "hono";
import { matchedRoutes } from "hono/route";

const SERVER_TIMING_PATH_PATTERN = /^\/(?:api\/v1|internal)\//u;
const QUOTED_STRING_ESCAPE_PATTERN = /["\\]/gu;

function formatDurationMs(durationMs: number): string {
  return durationMs.toFixed(1);
}

function formatRoutePattern(pattern: string): string {
  return `"${pattern.replace(QUOTED_STRING_ESCAPE_PATTERN, "\\$&")}"`;
}

function matchedRoutePattern(context: Context): string {
  const routes = matchedRoutes(context);
  const handler = routes
    .filter((route) => route.method !== "ALL" && route.path !== "/*")
    .at(-1);
  return (handler ?? routes.at(-1))?.path ?? "";
}

function formatServerTiming(args: {
  dbDurationMs: number;
  dbQueryCount: number;
  routePattern: string;
  totalDurationMs: number;
}): string {
  const metrics = [`total;dur=${formatDurationMs(args.totalDurationMs)}`];
  if (args.dbQueryCount > 0) {
    metrics.push(`db;dur=${formatDurationMs(args.dbDurationMs)}`);
  }
  if (args.routePattern !== "") {
    metrics.push(`app;desc=${formatRoutePattern(args.routePattern)}`);
  }
  return metrics.join(", ");
}

function setResponseHeader(context: Context, name: string, value: string) {
  try {
    context.res.headers.set(name, value);
  } catch {
    context.res = new Response(context.res.body, context.res);
    context.res.headers.set(name, value);
  }
}

export function serverTiming(): MiddlewareHandler {
  return async (context: Context, next: Next) => {
    if (
      !SERVER_TIMING_PATH_PATTERN.test(context.req.path) ||
      context.req.header("upgrade") !== undefined
    ) {
      return next();
    }
    const startedAt = performance.now();
    const accumulator = createDbTimeAccumulator();
    await runWithDbTimeAccumulator(accumulator, next);
    setResponseHeader(
      context,
      "server-timing",
      formatServerTiming({
        dbDurationMs: accumulator.durationMs,
        dbQueryCount: accumulator.queryCount,
        routePattern: matchedRoutePattern(context),
        totalDurationMs: performance.now() - startedAt,
      }),
    );
    const allowOrigin = context.res.headers.get("access-control-allow-origin");
    if (allowOrigin !== null) {
      setResponseHeader(context, "timing-allow-origin", allowOrigin);
    }
  };
}
