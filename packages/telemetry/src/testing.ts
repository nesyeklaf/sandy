import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface OtlpRequest {
  body: Buffer;
  contentType: string | undefined;
  path: string | undefined;
}

export interface OtlpReceiver {
  close(): Promise<void>;
  endpoint: string;
  requests: OtlpRequest[];
}

export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const requests: OtlpRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks),
        contentType: request.headers["content-type"],
        path: request.url,
      });
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    endpoint: `http://127.0.0.1:${address.port}/`,
    requests,
  };
}
