import {
  CLIENT_ERROR_MESSAGE_MAX_LENGTH,
  CLIENT_ERROR_STACK_MAX_LENGTH,
  type ClientErrorReport,
  type ClientErrorSource,
} from "@sandy/server-contract";

const MAX_REPORTS_PER_PAGE = 20;

export type SendClientErrorReport = (
  report: ClientErrorReport,
) => Promise<unknown>;

export interface ClientErrorReporter {
  report(
    source: ClientErrorSource,
    error: unknown,
    componentStack?: string | null,
  ): void;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function describeError(error: unknown): {
  message: string;
  stack: string | null;
} {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      stack: error.stack ?? null,
    };
  }
  const message = typeof error === "string" ? error : String(error);
  return { message, stack: null };
}

export function createClientErrorReporter(args: {
  send: SendClientErrorReport;
  readPath: () => string;
}): ClientErrorReporter {
  const seen = new Set<string>();
  return {
    report(source, error, componentStack = null) {
      if (seen.size >= MAX_REPORTS_PER_PAGE) return;
      const described = describeError(error);
      const message = described.message.trim() || "Unknown error";
      const key = JSON.stringify([source, message]);
      if (seen.has(key)) return;
      seen.add(key);
      args
        .send({
          source,
          message: truncate(message, CLIENT_ERROR_MESSAGE_MAX_LENGTH),
          stack:
            described.stack === null
              ? null
              : truncate(described.stack, CLIENT_ERROR_STACK_MAX_LENGTH),
          componentStack:
            componentStack === null
              ? null
              : truncate(componentStack, CLIENT_ERROR_STACK_MAX_LENGTH),
          path: truncate(
            args.readPath() || "/",
            CLIENT_ERROR_MESSAGE_MAX_LENGTH,
          ),
        })
        .catch(() => undefined);
    },
  };
}

export function installClientErrorListeners(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  reporter: ClientErrorReporter,
): () => void {
  const onError = (event: ErrorEvent) => {
    reporter.report("window-error", event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reporter.report("unhandled-rejection", event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
