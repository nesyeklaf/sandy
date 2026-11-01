import type { OpenPort, PortSnapshot } from "./contract";

export function portsByEnvironment(snapshot: PortSnapshot): Map<string, OpenPort[]> {
  const result = new Map<string, OpenPort[]>();
  for (const group of snapshot.groups) {
    const ports = new Map(result.get(group.environmentId)?.map((port) => [port.port, port]));
    for (const port of group.ports) ports.set(port.port, port);
    result.set(
      group.environmentId,
      [...ports.values()].sort((a, b) => a.port - b.port),
    );
  }
  return result;
}
