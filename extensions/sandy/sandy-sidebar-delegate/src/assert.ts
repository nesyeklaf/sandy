export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertUnreachable(value: never): never {
  throw new AssertionError(`Unhandled variant: ${String(value)}`);
}
