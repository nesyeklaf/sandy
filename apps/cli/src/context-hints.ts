const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const HOST_LOOKUP_TIMEOUT_MS = 2500;

export type ResolveContextHostId = () => Promise<string | null>;

function readContextId(name: string): string | null {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) return null;
  return VALID_ID_PATTERN.test(value) ? value : null;
}

export function contextProjectId(): string | null {
  return readContextId("SANDY_PROJECT_ID");
}

export function contextThreadId(): string | null {
  return readContextId("SANDY_THREAD_ID");
}

export function contextEnvironmentId(): string | null {
  return readContextId("SANDY_ENVIRONMENT_ID");
}

export function createContextHostIdResolver(
  getUrl: () => string,
): ResolveContextHostId {
  return async () => {
    const environmentId = contextEnvironmentId();
    if (environmentId === null) return null;
    try {
      const { createCliSandySdk } = await import("./client.js");
      const lookup = createCliSandySdk(getUrl())
        .environments.get({ environmentId })
        .then((environment) => environment.hostId);
      const timeout = new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), HOST_LOOKUP_TIMEOUT_MS);
        timer.unref();
      });
      return await Promise.race([lookup, timeout]);
    } catch {
      return null;
    }
  };
}

export function missingProjectHint(): string {
  const projectId = contextProjectId();
  return projectId === null
    ? "List project IDs with `sandy project list`."
    : `This thread's project is ${projectId}; add --project ${projectId}.`;
}

export function missingThreadFlagHint(): string {
  const threadId = contextThreadId();
  return threadId === null
    ? "List thread IDs with `sandy thread list`."
    : `The current thread is ${threadId}; add --thread ${threadId}.`;
}

export function missingEnvironmentHint(): string {
  const environmentId = contextEnvironmentId();
  return environmentId === null
    ? "List environment IDs with `sandy environment list`."
    : `The current environment is ${environmentId}; add --environment ${environmentId}.`;
}

export async function missingHostHint(
  flag: "--host" | "--machine",
  resolveHostId: ResolveContextHostId,
): Promise<string> {
  const hostId = await resolveHostId();
  return hostId === null
    ? "List machine IDs with `sandy machine list`."
    : `This thread runs on ${hostId}; add ${flag} ${hostId}.`;
}

export function missingThreadIdHint(): string {
  const threadId = contextThreadId();
  return threadId === null
    ? "Pass a thread ID; --self is unavailable because SANDY_THREAD_ID is not set."
    : `Add --self to target the current thread (${threadId}), or pass a thread ID.`;
}

export function terminalScopeHint(): string {
  const threadId = contextThreadId();
  return threadId === null
    ? "Add one of --thread <id>, --environment <id>, or --machine <id-or-name>."
    : `For this thread's terminals add --thread ${threadId}.`;
}
