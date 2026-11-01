// Transcription through the ChatGPT backend with the Codex login in ~/.codex/auth.json.
// Sent with curl. chatgpt.com answers Node's fetch (undici) with a Cloudflare challenge
// (403, cf-mitigated: challenge) every time, node:https on the first call after a pause, and curl not at all
// (measured on this host: fetch 0/6, node:https 5/6 per burst, curl 12/12).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
export const MODEL = "gpt-transcribe";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type Credentials = { accessToken: string; accountId: string; expired: boolean; fedramp: boolean };
export type CredentialsResult = { ok: true; credentials: Credentials } | { ok: false; message: string };

export function authPath(): string {
  const home = process.env.CODEX_HOME?.trim();
  return path.join(home ? home : path.join(os.homedir(), ".codex"), "auth.json");
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function authClaims(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const claims = jwtPayload(token)?.["https://api.openai.com/auth"];
  return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

export function parseAuth(raw: string, file: string, now = Date.now()): CredentialsResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, message: `${file} is not valid JSON. Run codex login on this host.` };
  }
  const auth = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const tokens = auth.tokens && typeof auth.tokens === "object" ? (auth.tokens as Record<string, unknown>) : null;
  const accessToken = str(tokens?.access_token);
  if (!accessToken) return { ok: false, message: `No ChatGPT login in ${file}. Run codex login on this host.` };
  const access = authClaims(accessToken);
  const id = authClaims(str(tokens?.id_token));
  const accountId = str(tokens?.account_id) ?? str(access?.chatgpt_account_id) ?? str(id?.chatgpt_account_id);
  if (!accountId) return { ok: false, message: "The Codex login has no ChatGPT account id. Run codex login on this host." };
  const exp = jwtPayload(accessToken)?.exp;
  return {
    ok: true,
    credentials: {
      accessToken,
      accountId,
      expired: typeof exp === "number" && now >= exp * 1000,
      fedramp: access?.chatgpt_account_is_fedramp === true || id?.chatgpt_account_is_fedramp === true,
    },
  };
}

export async function readCredentials(): Promise<CredentialsResult> {
  const file = authPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, message: `No Codex login at ${file}. Run codex login on this host.` };
  }
  return parseAuth(raw, file);
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav",
  "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac", "audio/x-flac": "flac",
};

export function audioFileName(audio: { name?: string; type: string }): { filename: string; mimeType: string } {
  const mimeType = audio.type.split(";")[0]?.trim().toLowerCase() || "audio/webm";
  const name = audio.name?.trim();
  if (name && /\.[a-z0-9]+$/i.test(name)) return { filename: name, mimeType };
  return { filename: `voice.${EXTENSIONS[mimeType] ?? "webm"}`, mimeType };
}

type HttpResult = { status: number; headers: string; body: string };

// curl reads its arguments from a config on stdin, so the token never shows up in ps.
export function curlConfig(url: string, headers: Record<string, string>, form: string[], out: { body: string; headers: string }): string {
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ")}"`;
  const lines = [`url = ${quote(url)}`, `output = ${quote(out.body)}`, `dump-header = ${quote(out.headers)}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`header = ${quote(`${name}: ${value}`)}`);
  for (const field of form) lines.push(`form = ${quote(field)}`);
  return lines.join("\n") + "\n";
}

function curl(config: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = execFile("curl", ["-sS", "--max-time", "9", "--max-filesize", String(MAX_RESPONSE_BYTES), "-w", "%{http_code}", "-K", "-"], { signal, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "curl is not installed on this host" : String(stderr).trim() || error.message;
        reject(new Error(`Codex transcription request failed: ${reason}`));
        return;
      }
      resolve(Number(String(stdout).trim()) || 0);
    });
    child.stdin?.end(config);
  });
}

async function post(url: string, headers: Record<string, string>, audio: { data: Buffer; filename: string; type: string }, fields: Record<string, string>, signal: AbortSignal): Promise<HttpResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-voice-"));
  try {
    const audioPath = path.join(tmp, audio.filename);
    await fs.writeFile(audioPath, audio.data, { mode: 0o600 });
    const form = [`file=@${audioPath};type=${audio.type}`];
    for (const [name, value] of Object.entries(fields)) {
      const fieldPath = path.join(tmp, `${name}.txt`);
      await fs.writeFile(fieldPath, value, { mode: 0o600 });
      form.push(`${name}=<${fieldPath}`);
    }
    const out = { body: path.join(tmp, "body"), headers: path.join(tmp, "headers") };
    const status = await curl(curlConfig(url, headers, form, out), signal);
    const [body, head] = await Promise.all([fs.readFile(out.body, "utf8").catch(() => ""), fs.readFile(out.headers, "utf8").catch(() => "")]);
    return { status, headers: head.toLowerCase(), body };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function errorDetail(result: HttpResult): string {
  if (/^cf-mitigated:\s*challenge/m.test(result.headers)) return "chatgpt.com answered with a Cloudflare challenge";
  if (/^content-type:\s*text\/html/m.test(result.headers)) return "";
  const text = result.body.replace(/\s+/g, " ").trim();
  try {
    const json = JSON.parse(text) as { detail?: unknown; error?: { message?: unknown } | unknown; message?: unknown };
    const message = str((json.error as { message?: unknown } | undefined)?.message) ?? str(json.detail) ?? str(json.message) ?? str(json.error);
    if (message) return message.slice(0, 300);
  } catch {}
  return text.slice(0, 300);
}

export async function transcribe(audio: File, hint: string | null, signal: AbortSignal): Promise<string> {
  if (audio.size > MAX_AUDIO_BYTES) throw new Error("Recordings over 20 MB are too large for Codex");
  const auth = await readCredentials();
  if (!auth.ok) throw new Error(auth.message);
  const { filename, mimeType } = audioFileName(audio);
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.credentials.accessToken}`,
    "chatgpt-account-id": auth.credentials.accountId,
    originator: "sandy",
    "user-agent": "sandy-codex-voice",
  };
  if (auth.credentials.fedramp) headers["x-openai-fedramp"] = "true";
  const fields: Record<string, string> = { model: MODEL };
  if (hint) fields.prompt = hint;
  const data = Buffer.from(await audio.arrayBuffer());
  const result = await post(TRANSCRIBE_URL, headers, { data, filename: filename.replace(/[^\w.-]/g, "_"), type: mimeType }, fields, signal);
  if (result.status === 401) throw new Error("The Codex login was refused (HTTP 401). Run codex login on this host.");
  if (result.status < 200 || result.status >= 300) {
    const detail = errorDetail(result);
    throw new Error(`Codex transcription failed with HTTP ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  let text: unknown;
  try {
    text = (JSON.parse(result.body) as { text?: unknown }).text;
  } catch {
    throw new Error("Codex transcription response was not valid JSON");
  }
  if (typeof text !== "string") throw new Error("Codex transcription response had no text");
  return text;
}
