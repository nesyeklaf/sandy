import type { EnvironmentProvisionCommand } from "@sandy/host-daemon-contract";

export interface EnvironmentProvisionRequest {
  command: EnvironmentProvisionCommand;
}
