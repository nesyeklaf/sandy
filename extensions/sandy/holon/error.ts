export class HolonError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
