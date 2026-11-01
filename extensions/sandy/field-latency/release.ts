export interface ReleaseInfo {
  sandyVersion: string | null;
  appScript: string | null;
}

export const UNKNOWN_RELEASE = "unknown";

const MAIN_SCRIPT = /\/(index-[^/?#]*\.js)(?:[?#]|$)/;

export function appScriptHash(sources: readonly string[]): string | null {
  for (const source of sources) {
    const match = MAIN_SCRIPT.exec(source);
    if (!match?.[1]) continue;
    const hash = /^index-(.+)\.js$/.exec(match[1])?.[1];
    return (hash ?? match[1]).slice(0, 80);
  }
  return null;
}

export function releaseKey(info: ReleaseInfo): string {
  const parts = [info.sandyVersion, info.appScript].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join("+") : UNKNOWN_RELEASE;
}

export function readRelease(doc: Pick<Document, "querySelector" | "querySelectorAll">): ReleaseInfo {
  const version = doc.querySelector('meta[name="sandy-version"]')?.getAttribute("content")?.trim() ?? "";
  const sources = [...doc.querySelectorAll('script[type="module"][src]')].map((script) => script.getAttribute("src") ?? "");
  return { sandyVersion: version.length > 0 ? version.slice(0, 80) : null, appScript: appScriptHash(sources) };
}
