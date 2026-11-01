import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SERVER_MOVED_ERROR_CODE,
  serverMovedErrorDetailsSchema,
} from "@sandy/host-daemon-contract";
import type { ServerMovedFile } from "@sandy/server-archive";
import {
  startMovedResponder,
  type MovedResponder,
} from "../src/moved-responder.js";

interface SendRequestArgs {
  headers?: Record<string, string>;
  method: string;
  path: string;
  port: number;
}

interface ResponderResponse {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

const movedErrorBodySchema = z
  .object({
    code: z.literal(SERVER_MOVED_ERROR_CODE),
    details: serverMovedErrorDetailsSchema,
    message: z.string(),
  })
  .strict();

const HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const responders: MovedResponder[] = [];

afterEach(async () => {
  for (const responder of responders.splice(0)) {
    await responder.close();
  }
});

function createMovedFile(overrides: Partial<ServerMovedFile>): ServerMovedFile {
  return {
    version: 1,
    moveId: "move-1",
    movedAt: 1_757_000_000_000,
    fromHostId: "host-laptop",
    toHostId: "host-desk",
    toHostName: "desk",
    serverUrl: "https://desk.example.com",
    oldCopyEntries: ["sandy.db"],
    ...overrides,
  };
}

async function listen(movedFile: ServerMovedFile): Promise<number> {
  const errors: Error[] = [];
  const responder = await startMovedResponder({
    bindAddresses: ["127.0.0.1"],
    movedFile,
    onError: (error) => {
      errors.push(error);
    },
    port: 0,
  });
  if (responder === null) {
    throw new Error(`Responder did not listen: ${errors[0]?.message}`);
  }
  responders.push(responder);
  return responder.port;
}

function sendRequest(args: SendRequestArgs): Promise<ResponderResponse> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        headers: args.headers,
        host: "127.0.0.1",
        method: args.method,
        path: args.path,
        port: args.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolvePromise({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(args.method === "POST" ? "{}" : undefined);
  });
}

describe("moved responder", () => {
  it.each([
    { method: "GET", path: "/health" },
    { method: "GET", path: "/api/v1/threads?limit=5" },
    { method: "POST", path: "/api/v1/threads" },
    { method: "GET", path: "/internal/hosts/session" },
    { method: "DELETE", path: "/internal/server-move/move-1/archive" },
  ])(
    "answers $method $path with the strict server_moved error",
    async ({ method, path }) => {
      const port = await listen(createMovedFile({}));

      const response = await sendRequest({
        headers: { accept: HTML_ACCEPT },
        method,
        path,
        port,
      });

      expect(response.status).toBe(410);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=utf-8",
      );
      expect(movedErrorBodySchema.parse(JSON.parse(response.body))).toEqual({
        code: "server_moved",
        details: {
          movedAt: 1_757_000_000_000,
          serverUrl: "https://desk.example.com",
          toHostName: "desk",
        },
        message: "This sandy server moved to desk (https://desk.example.com).",
      });
    },
  );

  it("redirects browser navigations to the new address with the path and query", async () => {
    const port = await listen(createMovedFile({}));

    const response = await sendRequest({
      headers: { accept: HTML_ACCEPT },
      method: "GET",
      path: "/projects/proj-1/threads/thr-2?tab=files&line=4",
      port,
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(
      "https://desk.example.com/projects/proj-1/threads/thr-2?tab=files&line=4",
    );
  });

  it("keeps the new address's path prefix and host when the request path looks protocol-relative", async () => {
    const port = await listen(
      createMovedFile({ serverUrl: "https://desk.example.com/sandy/" }),
    );

    const response = await sendRequest({
      headers: { accept: HTML_ACCEPT },
      method: "GET",
      path: "/.//evil.example/steal?x=1",
      port,
    });

    expect(response.status).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.host).toBe("desk.example.com");
    expect(location.href).toBe(
      "https://desk.example.com/sandy//evil.example/steal?x=1",
    );
  });

  it("answers non-browser requests for app pages with the JSON error", async () => {
    const port = await listen(createMovedFile({}));

    const curlLike = await sendRequest({
      headers: { accept: "*/*" },
      method: "GET",
      path: "/settings",
      port,
    });
    const formPost = await sendRequest({
      headers: { accept: HTML_ACCEPT },
      method: "POST",
      path: "/settings",
      port,
    });

    expect(curlLike.status).toBe(410);
    expect(
      movedErrorBodySchema.safeParse(JSON.parse(curlLike.body)).success,
    ).toBe(true);
    expect(formPost.status).toBe(410);
    expect(
      movedErrorBodySchema.safeParse(JSON.parse(formPost.body)).success,
    ).toBe(true);
  });

  it("does not redirect to an address that is not http or https", async () => {
    const port = await listen(
      createMovedFile({ serverUrl: "javascript:alert(1)" }),
    );

    const response = await sendRequest({
      headers: { accept: HTML_ACCEPT },
      method: "GET",
      path: "/",
      port,
    });

    expect(response.status).toBe(410);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("reports a busy port without throwing", async () => {
    const occupied = createServer();
    await new Promise<void>((resolvePromise) => {
      occupied.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the occupied server to have a TCP address");
    }
    const errors: Error[] = [];
    try {
      const responder = await startMovedResponder({
        bindAddresses: ["127.0.0.1"],
        movedFile: createMovedFile({}),
        onError: (error) => {
          errors.push(error);
        },
        port: address.port,
      });

      expect(responder).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        occupied.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });
  it.runIf(process.platform === "linux")(
    "answers on every bind address with the loopback port",
    async () => {
      const responder = await startMovedResponder({
        bindAddresses: ["127.0.0.1", "127.0.0.2"],
        movedFile: createMovedFile({}),
        onError: () => undefined,
        port: 0,
      });
      if (responder === null) {
        throw new Error("Responder did not listen");
      }
      responders.push(responder);

      const response = await sendRequest({
        method: "GET",
        path: "/api/v1/threads",
        port: responder.port,
      });
      expect(response.status).toBe(410);
    },
  );

  it("releases already bound addresses when a later address fails", async () => {
    const errors: Error[] = [];
    const responder = await startMovedResponder({
      bindAddresses: ["127.0.0.1", "192.0.2.123"],
      movedFile: createMovedFile({}),
      onError: (error) => {
        errors.push(error);
      },
      port: 0,
    });

    expect(responder).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "EADDRNOTAVAIL" });
  });
});
