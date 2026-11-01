import type { Host } from "@sandy/domain";
import { searchPickerOptions } from "@sandy/shared-ui/picker-search";

export const MACHINE_SEARCH_MIN_OPTIONS = 5;

export function searchMachineHosts(
  hosts: readonly Host[],
  query: string,
): readonly Host[] {
  return searchPickerOptions({
    options: hosts,
    query,
    getLabel: (host) => host.name,
    getAliases: (host) => [host.id],
  });
}
