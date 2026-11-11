import { z } from "zod";

export const FORWARD_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

const ID = "[^/]+";
const ROUTES: readonly { method: "GET" | "POST" | "PUT"; pattern: RegExp; query: readonly string[] }[] = [
  { method: "GET", pattern: /^\/v0\/health$/, query: [] },
  { method: "GET", pattern: /^\/v0\/map$/, query: ["change"] },
  { method: "GET", pattern: new RegExp(`^/v0/holons/${ID}$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v0/holons/${ID}/source$`), query: [] },
  { method: "POST", pattern: /^\/v0\/edit$/, query: ["change"] },
  { method: "GET", pattern: /^\/v0\/changes$/, query: [] },
  { method: "POST", pattern: /^\/v0\/changes$/, query: [] },
  { method: "GET", pattern: new RegExp(`^/v0/changes/${ID}$`), query: [] },
  { method: "POST", pattern: new RegExp(`^/v0/changes/${ID}/(approve|reject|archive)$`), query: [] },
  { method: "GET", pattern: /^\/v0\/diagrams$/, query: [] },
  { method: "GET", pattern: new RegExp(`^/v0/diagrams/${ID}$`), query: [] },
  { method: "GET", pattern: /^\/v0\/policy$/, query: [] },
  { method: "PUT", pattern: /^\/v0\/policy$/, query: [] },
  { method: "GET", pattern: /^\/v0\/file$/, query: ["path"] },
  { method: "PUT", pattern: /^\/v0\/file$/, query: [] },
  { method: "GET", pattern: /^\/v0\/refs$/, query: [] },
];

function segmentsAreSafe(path: string): boolean {
  return path.split("/").every((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
  });
}

export function allowedRoute(method: string, path: string, query: Record<string, string>): string | null {
  if (!segmentsAreSafe(path)) return `${path} has a dot or slash segment`;
  const route = ROUTES.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  if (route === undefined) return `${method} ${path} is not an editor route of holon serve`;
  const unknown = Object.keys(query).filter((name) => !route.query.includes(name));
  if (unknown.length > 0) return `${method} ${path} takes no query ${unknown.join(", ")}`;
  return null;
}

export const forwardInput = z
  .object({
    threadId: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT"]),
    path: z.string().startsWith("/v0/"),
    query: z.record(z.string(), z.string()).optional(),
    body: z
      .string()
      .refine((body) => new TextEncoder().encode(body).byteLength <= FORWARD_BODY_LIMIT_BYTES, `a body of at most ${FORWARD_BODY_LIMIT_BYTES / 1024 / 1024} MB`)
      .optional(),
  })
  .superRefine((input, context) => {
    const problem = allowedRoute(input.method, input.path, input.query ?? {});
    if (problem !== null) context.addIssue({ code: "custom", message: problem, path: ["path"] });
    if (input.method === "GET" && input.body !== undefined) context.addIssue({ code: "custom", message: "a GET has no body", path: ["body"] });
  });

export const forwardResult = z.union([
  z.object({ ok: z.literal(true), status: z.number().int(), text: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type ForwardInput = z.infer<typeof forwardInput>;
export type ForwardResult = z.infer<typeof forwardResult>;
