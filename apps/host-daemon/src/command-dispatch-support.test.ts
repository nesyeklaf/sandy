import { CompetingTurnError } from "@sandy/agent-runtime";
import { COMPETING_TURN_ERROR_CODE } from "@sandy/host-daemon-contract";
import { BRIDGE_JSON_RPC_ERRORS } from "@sandy/provider-bridge-protocol";
import { JsonRpcResponseError } from "@sandy/provider-bridge-protocol/bridge-kit";
import { describe, expect, it } from "vitest";
import {
  CommandDispatchError,
  getErrorCode,
  isExpectedOnlineRpcFailureError,
} from "./command-dispatch-support.js";

describe("command dispatch support", () => {
  it("reports a runtime competing-turn refusal with the contract error code", () => {
    expect(getErrorCode(new CompetingTurnError("thread-1"))).toBe(
      COMPETING_TURN_ERROR_CODE,
    );
    expect(
      getErrorCode(
        new CommandDispatchError(
          COMPETING_TURN_ERROR_CODE,
          "Refusing to start a competing turn while thread-1 is still starting",
        ),
      ),
    ).toBe("competing_turn");
    expect(getErrorCode(new Error("Refusing to start a competing turn"))).toBe(
      "command_failed",
    );
  });

  it("classifies a bridge missing-executable rejection without sniffing its message", () => {
    expect(
      getErrorCode(
        new JsonRpcResponseError(
          BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
          "sandy could not find the Codex CLI on this machine.",
        ),
      ),
    ).toBe("missing_executable");
    expect(
      getErrorCode(
        new JsonRpcResponseError(
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          "sandy could not find the Codex CLI on this machine.",
        ),
      ),
    ).toBe("command_failed");
  });

  it("classifies oversized file reads as expected RPC failures", () => {
    expect(
      isExpectedOnlineRpcFailureError(
        new CommandDispatchError("file_too_large", "File exceeds the limit"),
      ),
    ).toBe(true);
  });
});
