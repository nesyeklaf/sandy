import type { ForwardInput, ForwardResult } from "../forward";

export interface ForwardRpc {
  call(method: "forward", input: ForwardInput): Promise<ForwardResult>;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const FORWARD_FAILED_STATUS = 502;

function methodOf(value: string | undefined): ForwardInput["method"] {
  const method = (value ?? "GET").toUpperCase();
  if (method === "GET" || method === "POST" || method === "PUT") return method;
  throw new Error(`the Holons tab does not send ${method}`);
}

function failed(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: "forward_failed", message } }), {
    status: FORWARD_FAILED_STATUS,
    headers: { "Content-Type": "application/json" },
  });
}

export function rpcFetch(rpc: ForwardRpc, threadId: string): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input, "http://holon.invalid");
    const query = Object.fromEntries(url.searchParams);
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") return failed("the Holons tab sends only text bodies");
    const body = typeof init?.body === "string" ? init.body : undefined;
    let result: ForwardResult;
    try {
      result = await rpc.call("forward", {
        threadId,
        method: methodOf(init?.method),
        path: url.pathname,
        ...(Object.keys(query).length === 0 ? {} : { query }),
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : String(cause));
    }
    if (!result.ok) return failed(result.error);
    return new Response(NULL_BODY_STATUS.has(result.status) ? null : result.text, { status: result.status });
  };
}
