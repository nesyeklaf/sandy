import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

const TRACER_NAME = "sandy";
const TRACEPARENT_KEY = "traceparent";

interface SpanOptions {
  attributes?: Attributes;
  name: string;
}

async function runInSpan<T>(
  span: Span,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  try {
    return await run(span);
  } catch (error) {
    if (error instanceof Error) {
      span.recordException(error);
    }
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

export function withOutgoingSpan<T>(
  options: SpanOptions,
  run: (traceparent: string | undefined, span: Span) => Promise<T>,
): Promise<T> {
  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(
      options.name,
      { attributes: options.attributes, kind: SpanKind.CLIENT },
      (span) =>
        runInSpan(span, (active) => {
          const carrier: Record<string, string> = {};
          propagation.inject(context.active(), carrier);
          return run(carrier[TRACEPARENT_KEY], active);
        }),
    );
}

export function withIncomingSpan<T>(
  options: SpanOptions & { traceparent: string | undefined },
  run: (span: Span) => Promise<T>,
): Promise<T> {
  const parent =
    options.traceparent === undefined
      ? context.active()
      : propagation.extract(context.active(), {
          [TRACEPARENT_KEY]: options.traceparent,
        });
  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(
      options.name,
      { attributes: options.attributes, kind: SpanKind.SERVER },
      parent,
      (span) => runInSpan(span, run),
    );
}

export function markSpanFailed(span: Span, message: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}
