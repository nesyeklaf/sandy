export const DEVICE_ID_KEY = "sandy-field-latency:device";
export const UNKNOWN_DEVICE_LABEL = "unknown device";

const DEVICE_ID_PATTERN = /^[a-z0-9]{12,64}$/;

export function newDeviceId(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  return Array.from(random(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let memoryDeviceId: string | null = null;

export function loadDeviceId(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string {
  try {
    const stored = storage?.getItem(DEVICE_ID_KEY) ?? null;
    if (stored !== null && DEVICE_ID_PATTERN.test(stored)) return stored;
    const fresh = memoryDeviceId ?? newDeviceId();
    memoryDeviceId = fresh;
    storage?.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    memoryDeviceId ??= newDeviceId();
    return memoryDeviceId;
  }
}

function safeStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function shortDeviceId(id: string | null): string {
  return id === null ? "-" : id.slice(0, 6);
}

function osName(userAgent: string): string | null {
  if (/Android/.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/Linux|X11/.test(userAgent)) return "Linux";
  return null;
}

function major(userAgent: string, pattern: RegExp): string | null {
  return pattern.exec(userAgent)?.[1] ?? null;
}

function browserName(userAgent: string): { name: string; version: string | null } | null {
  const android = /Android/.test(userAgent);
  const candidates: [string, RegExp][] = [
    ["Edge", /\bEdg(?:A|iOS)?\/(\d+)/],
    ["Opera", /\bOPR\/(\d+)/],
    ["Samsung Internet", /\bSamsungBrowser\/(\d+)/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
  ];
  for (const [name, pattern] of candidates) {
    const version = major(userAgent, pattern);
    if (version !== null) return { name, version };
  }
  const chrome = major(userAgent, /\b(?:Chrome|CriOS|HeadlessChrome)\/(\d+)/);
  if (chrome !== null) return { name: android && /; wv\)/.test(userAgent) ? "WebView" : "Chrome", version: chrome };
  const safari = major(userAgent, /\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//);
  if (safari !== null) return { name: "Safari", version: safari };
  return null;
}

function androidModel(userAgent: string): string | null {
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent)?.[1]?.trim() ?? null;
  return model === null || model === "K" || model.length < 2 ? null : model;
}

export function deviceLabel(userAgent: string | null, platform: string | null = null): string {
  if (userAgent === null || userAgent.length === 0) return UNKNOWN_DEVICE_LABEL;
  const os = osName(userAgent) ?? platform;
  const browser = browserName(userAgent);
  const model = androidModel(userAgent);
  const parts = [os, browser === null ? null : `${browser.name}${browser.version === null ? "" : ` ${browser.version}`}`].filter((part) => part !== null);
  if (parts.length === 0) return userAgent.slice(0, 40);
  return model === null ? parts.join(" ") : `${parts.join(" ")} (${model})`;
}

export function screenText(width: number, height: number): string | null {
  return width > 0 && height > 0 ? `${Math.round(width)}x${Math.round(height)}` : null;
}

export function readPlatform(): string | null {
  const hints: unknown = Reflect.get(navigator, "userAgentData");
  if (typeof hints === "object" && hints !== null) {
    const platform: unknown = Reflect.get(hints, "platform");
    if (typeof platform === "string" && platform.length > 0) return platform.slice(0, 80);
  }
  return navigator.platform ? navigator.platform.slice(0, 80) : null;
}

export function readGpu(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
    if (!(gl instanceof WebGLRenderingContext)) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof renderer === "string" && renderer.length > 0 ? renderer.slice(0, 200) : null;
  } catch {
    return null;
  }
}
