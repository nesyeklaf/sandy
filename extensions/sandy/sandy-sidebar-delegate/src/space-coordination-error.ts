type SpaceCoordinationErrorCode =
  | "space_missing"
  | "not_member"
  | "not_orchestrator"
  | "not_found"
  | "limit_reached"
  | "independent_member"
  | "invalid_request"
  | "not_managed"
  | "self_reports_off";

export class SpaceCoordinationError extends Error {
  readonly code: SpaceCoordinationErrorCode;

  constructor(code: SpaceCoordinationErrorCode, message: string) {
    super(message);
    this.name = "SpaceCoordinationError";
    this.code = code;
  }
}
