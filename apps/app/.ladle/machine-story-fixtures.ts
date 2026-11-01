import type {
  ServerAccessStatus,
  SystemMachineProvider,
} from "@sandy/server-contract";
import { machineServerAccessBlockedReason } from "../src/components/machines/machine-server-access";
import type { MachineAccessState } from "../src/components/settings/MachineAccessSettings";

const noop = () => {};
const noopAsync = async () => {};

export const TAILNET_SETUP_REQUIRED: ServerAccessStatus = {
  providers: [
    {
      id: "tailnet",
      displayName: "Tailnet",
      description: "Use this computer's tailnet address.",
      pluginId: "tailnet-access",
      availability: {
        status: "setup-required",
        message: "Sign in to Tailscale",
      },
    },
    {
      id: "direct",
      displayName: "Manual",
      description: "Use your own domain or network address.",
      pluginId: null,
      availability: null,
    },
  ],
  defaultProviderId: "tailnet",
  effectiveUrl: null,
  urlSource: null,
};

export const TAILNET_READY: ServerAccessStatus = {
  ...TAILNET_SETUP_REQUIRED,
  providers: TAILNET_SETUP_REQUIRED.providers.map((provider) =>
    provider.id === "tailnet"
      ? {
          ...provider,
          availability: {
            status: "available",
            serverUrl: "https://sandy.example.com",
          },
        }
      : provider,
  ),
};

export const TAILNET_UNAVAILABLE: ServerAccessStatus = {
  ...TAILNET_SETUP_REQUIRED,
  providers: TAILNET_SETUP_REQUIRED.providers.map((provider) =>
    provider.id === "tailnet"
      ? {
          ...provider,
          availability: {
            status: "unavailable",
            message: "Credential revoked",
          },
        }
      : provider,
  ),
};

export const MANUAL_WITHOUT_URL: ServerAccessStatus = {
  ...TAILNET_SETUP_REQUIRED,
  defaultProviderId: "direct",
};

export function machineAccessState(
  access: ServerAccessStatus,
  overrides: Partial<MachineAccessState> = {},
): MachineAccessState {
  const selected = overrides.selected ?? access.defaultProviderId ?? "tailnet";
  return {
    access,
    disabled: false,
    draft: null,
    error: null,
    effective: access.providers.find((provider) => provider.id === selected),
    configurationMessage: machineServerAccessBlockedReason(access, selected),
    saving: false,
    selected,
    value: access.urlSource === "setting" ? (access.effectiveUrl ?? "") : "",
    editDraft: noop,
    selectProvider: noop,
    commitUrl: noopAsync,
    ...overrides,
  };
}

export function machineProvider(
  overrides: Partial<SystemMachineProvider> &
    Pick<SystemMachineProvider, "id" | "displayName">,
): SystemMachineProvider {
  return {
    description: "Run a machine for development.",
    icon: "Terminal",
    logoUrl: null,
    pluginId: `plugin-${overrides.id}`,
    inputs: null,
    acceptsEmptyInputs: true,
    supportsSuspend: false,
    ...overrides,
  };
}

export const MODAL_MACHINE_PROVIDER = machineProvider({
  id: "modal-sandbox",
  displayName: "Modal Sandbox",
  description: "Create a sandbox in your Modal account.",
  pluginId: "environment-modal-sandbox",
  icon: "Terminal",
  supportsSuspend: true,
});

export const MANUAL_MACHINE_PROVIDER = machineProvider({
  id: "manual",
  displayName: "Manual machine setup",
  description:
    "Run one command on a machine you already have to connect it to this server.",
  pluginId: "core",
  icon: "Terminal",
});
