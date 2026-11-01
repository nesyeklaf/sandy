import { useLayoutEffect, useState, type ReactNode } from "react";
import type {
  ExperimentalThreadTocBand,
  ExperimentalThreadTocInput,
  ExperimentalThreadTocTabProps,
} from "@sandy-sdk/plugin-sdk";
import {
  usePluginSlots,
  type PluginThreadTocExtensionSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

export interface ThreadTocBandEntry {
  slot: PluginThreadTocExtensionSlot;
  band: ExperimentalThreadTocBand;
}

export interface ThreadTocTabEntry {
  key: string;
  label: string;
  slot: PluginThreadTocExtensionSlot;
}

type BandsReport = (
  slot: PluginThreadTocExtensionSlot,
  threadId: string,
  bands: readonly ExperimentalThreadTocBand[] | null,
) => void;

function slotKey(slot: PluginThreadTocExtensionSlot): string {
  return `${slot.pluginId}/${slot.id}`;
}

function sameBands(
  left: readonly ExperimentalThreadTocBand[],
  right: readonly ExperimentalThreadTocBand[],
): boolean {
  return (
    left.length === right.length &&
    left.every((band, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        band.fromSeq === other.fromSeq &&
        band.toSeq === other.toSeq &&
        band.hue === other.hue &&
        band.label === other.label &&
        band.dashed === other.dashed &&
        band.active === other.active
      );
    })
  );
}

function BandsHost({
  slot,
  input,
  onBands,
}: {
  slot: PluginThreadTocExtensionSlot;
  input: ExperimentalThreadTocInput;
  onBands: BandsReport;
}) {
  const bands = slot.useBands(input);
  if (!Array.isArray(bands)) {
    throw new Error("useBands must return an array");
  }
  const { threadId } = input;
  useLayoutEffect(() => {
    onBands(slot, threadId, bands);
  }, [slot, threadId, bands, onBands]);
  useLayoutEffect(
    () => () => onBands(slot, threadId, null),
    [slot, threadId, onBands],
  );
  return null;
}

function BandsObserver({
  slot,
  input,
  onBands,
}: {
  slot: PluginThreadTocExtensionSlot;
  input: ExperimentalThreadTocInput;
  onBands: BandsReport;
}) {
  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="threadTocExtension/bands"
      slotId={slot.id}
      instanceId={input.threadId}
      crashResetKey={String(slot.generation)}
      crashFallback={null}
      wrapRoot={false}
      onCrash={() => onBands(slot, input.threadId, [])}
    >
      <BandsHost slot={slot} input={input} onBands={onBands} />
    </PluginSlotMount>
  );
}

export function useThreadTocExtensions(input: ExperimentalThreadTocInput): {
  bands: readonly ThreadTocBandEntry[];
  tabs: readonly ThreadTocTabEntry[];
  observers: ReactNode;
} {
  const { threadTocExtensions } = usePluginSlots();
  const [reported, setReported] = useState<
    ReadonlyMap<
      PluginThreadTocExtensionSlot,
      { threadId: string; bands: readonly ExperimentalThreadTocBand[] }
    >
  >(() => new Map());
  const [onBands] = useState<BandsReport>(
    () =>
      (
        slot: PluginThreadTocExtensionSlot,
        threadId: string,
        bands: readonly ExperimentalThreadTocBand[] | null,
      ) => {
        setReported((current) => {
          const previous = current.get(slot);
          const unchanged =
            bands === null
              ? previous === undefined || previous.threadId !== threadId
              : previous !== undefined &&
                previous.threadId === threadId &&
                sameBands(previous.bands, bands);
          if (unchanged) return current;
          const next = new Map(current);
          if (bands === null) next.delete(slot);
          else next.set(slot, { threadId, bands });
          return next;
        });
      },
  );
  const { threadId } = input;
  return {
    bands: threadTocExtensions.flatMap((slot) => {
      const entry = reported.get(slot);
      if (entry?.threadId !== threadId) return [];
      return entry.bands.map((band) => ({ slot, band }));
    }),
    tabs: threadTocExtensions.flatMap((slot) =>
      slot.tab === undefined
        ? []
        : [{ key: slotKey(slot), label: slot.tab.label, slot }],
    ),
    observers: threadTocExtensions.map((slot) => (
      <BandsObserver
        key={`${slotKey(slot)}/${slot.generation}/${threadId}`}
        slot={slot}
        input={input}
        onBands={onBands}
      />
    )),
  };
}

export function ThreadTocTabMount({
  slot,
  ...props
}: ExperimentalThreadTocTabProps & { slot: PluginThreadTocExtensionSlot }) {
  const Tab = slot.tab?.component;
  if (Tab === undefined) return null;
  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="threadTocExtension/tab"
      slotId={slot.id}
      instanceId={props.threadId}
      crashResetKey={String(slot.generation)}
      crashFallback={null}
    >
      <Tab {...props} />
    </PluginSlotMount>
  );
}

export function notifyThreadTocBandHover(
  entry: ThreadTocBandEntry,
  hovered: boolean,
  input: ExperimentalThreadTocInput,
): void {
  entry.slot.onBandHover?.(hovered ? entry.band : null, input);
}

export function notifyThreadTocBandClick(
  entry: ThreadTocBandEntry,
  input: ExperimentalThreadTocInput,
): void {
  entry.slot.onBandClick?.(entry.band, input);
}
