import type { Client, Sample } from "./contract.ts";
import { UNKNOWN_DEVICE_LABEL, deviceLabel, shortDeviceId } from "./device.ts";
import { loadCounts } from "./load.ts";
import { hardwareText, textTable, type DeviceInfo } from "./stats.ts";

export function profileFromClient(client: Client, lastSeen: number): DeviceInfo {
  return {
    id: client.deviceId,
    label: deviceLabel(client.userAgent, client.platform),
    userAgent: client.userAgent,
    platform: client.platform,
    benchmarkIndex: client.benchmarkIndex,
    cores: client.cores,
    deviceMemoryGb: client.deviceMemoryGb,
    devicePixelRatio: client.devicePixelRatio,
    screen: client.screen,
    refreshMs: client.refreshMs,
    gpu: client.gpu,
    lastSeen,
  };
}

export function unknownDevice(): DeviceInfo {
  return {
    id: null,
    label: UNKNOWN_DEVICE_LABEL,
    userAgent: null,
    platform: null,
    benchmarkIndex: null,
    cores: null,
    deviceMemoryGb: null,
    devicePixelRatio: null,
    screen: null,
    refreshMs: null,
    gpu: null,
    lastSeen: null,
  };
}

export function deviceName(device: DeviceInfo): string {
  return device.id === null ? device.label : `${device.label} #${shortDeviceId(device.id)}`;
}

export interface DeviceMatch {
  ids: string[];
  unknown: boolean;
}

export function matchDevices(profiles: readonly DeviceInfo[], filter: string): DeviceMatch {
  const needle = filter.trim().toLowerCase().replace(/^#/, "");
  const known = profiles.filter(
    (profile) => profile.id !== null && (profile.id.startsWith(needle) || profile.label.toLowerCase().includes(needle) || deviceName(profile).toLowerCase().includes(needle)),
  );
  return { ids: known.map((profile) => profile.id).filter((id) => id !== null), unknown: needle.length > 0 && UNKNOWN_DEVICE_LABEL.includes(needle) };
}

export interface DeviceSection<T> {
  device: DeviceInfo;
  items: T[];
}

export function partitionByDevice<T>(items: readonly T[], deviceOf: (item: T) => string | null, profiles: ReadonlyMap<string, DeviceInfo>): DeviceSection<T>[] {
  const byDevice = new Map<string | null, T[]>();
  for (const item of items) {
    const key = deviceOf(item);
    const list = byDevice.get(key) ?? [];
    list.push(item);
    byDevice.set(key, list);
  }
  const sections: DeviceSection<T>[] = [];
  for (const [id, list] of byDevice) {
    const device = id === null ? unknownDevice() : (profiles.get(id) ?? { ...unknownDevice(), id, label: `device ${shortDeviceId(id)}` });
    sections.push({ device, items: list });
  }
  return sections.sort((a, b) => b.items.length - a.items.length || deviceName(a.device).localeCompare(deviceName(b.device)));
}

export function formatDeviceTable(sections: readonly DeviceSection<Sample>[]): string[] {
  const header = ["id", "device", "n", "load idle/busy/?", "hardware"];
  const rows = sections.map((section) => {
    const counts = loadCounts(section.items);
    return [
      shortDeviceId(section.device.id),
      section.device.label,
      String(section.items.length),
      `${counts.idle}/${counts.busy}/${counts.unknown}`,
      section.device.id === null ? "-" : hardwareText(section.device),
    ];
  });
  return ["Devices", ...textTable(header, rows)];
}

export function formatSectionTitle(section: DeviceSection<unknown>): string {
  const hardware = section.device.id === null ? "" : ` — ${hardwareText(section.device)}`;
  return `== ${deviceName(section.device)}, ${section.items.length} samples${hardware} ==`;
}
