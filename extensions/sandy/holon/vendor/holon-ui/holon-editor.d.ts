import type { CSSProperties, ReactElement } from "react";

export type Theme = "dark" | "light";

export interface EditorAssets {
  elkWorker?: string;
  routingWorker?: string;
  avoidWasm?: string;
  mermaid?: string;
}

export interface Api {
  workspace?(): Promise<unknown>;
  project?(name: string): Api;
  [method: string]: unknown;
}

export interface HolonEditorProps {
  api: Api;
  assets?: EditorAssets;
  theme?: Theme;
  storageKey?: string | null;
  className?: string;
  style?: CSSProperties;
}

export function HolonEditor(props: HolonEditorProps): ReactElement;
export function createHttpApi(baseUrl?: string, fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>): Api;
export function distAssets(base: string, options?: { mermaid?: boolean }): EditorAssets;
export const EDITOR_STORAGE_KEY: string;
