import type { SystemEnvironmentProvider } from "@sandy/server-contract";

export function providerInputsControlRequired(
  provider: SystemEnvironmentProvider,
): boolean {
  return provider.inputs !== null && !provider.acceptsEmptyInputs;
}
