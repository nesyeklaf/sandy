import { createReadStream, existsSync, statSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import { connect } from "node:net";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const MIME = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

const { values } = parseArgs({
  options: {
    dist: { type: "string", default: "apps/app/dist-profiling" },
    upstream: { type: "string", default: "http://127.0.0.1:38886" },
    port: { type: "string", default: "38887" },
    host: { type: "string", default: "127.0.0.1" },
  },
});

const dist = resolve(values.dist);
const upstream = new URL(values.upstream);
const indexHtml = join(dist, "index.html");
if (!existsSync(indexHtml)) {
  throw new Error(
    `No index.html in ${dist}. Run pnpm --filter @sandy/app run build:profiling first.`,
  );
}

const distFile = (pathname) => {
  const path = resolve(
    dist,
    "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname),
  );
  if (!path.startsWith(dist + "/")) return null;
  return existsSync(path) && statSync(path).isFile() ? path : null;
};

const sendFile = (response, path, status = 200) => {
  response.writeHead(status, {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "cache-control": path.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(path).pipe(response);
};

const upstreamHeaders = (headers) => {
  const rewritten = { ...headers, host: upstream.host };
  if (typeof headers.origin === "string") rewritten.origin = upstream.origin;
  if (typeof headers.referer === "string") {
    const referer = new URL(headers.referer);
    rewritten.referer = upstream.origin + referer.pathname + referer.search;
  }
  return rewritten;
};

const proxy = (request, response) => {
  const outgoing = httpRequest(
    {
      host: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request.headers),
    },
    (incoming) => {
      const html = String(incoming.headers["content-type"] ?? "").startsWith(
        "text/html",
      );
      if (request.method === "GET" && html && incoming.statusCode === 200) {
        incoming.resume();
        sendFile(response, indexHtml);
        return;
      }
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    },
  );
  outgoing.on("error", (error) => {
    if (!response.headersSent)
      response.writeHead(502, { "content-type": "text/plain" });
    response.end(`upstream error: ${error.message}`);
  });
  request.pipe(outgoing);
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://local").pathname;
  const file = request.method === "GET" ? distFile(pathname) : null;
  if (file !== null) {
    sendFile(response, file);
    return;
  }
  proxy(request, response);
});

server.on("upgrade", (request, socket, head) => {
  const target = connect(Number(upstream.port), upstream.hostname, () => {
    const lines = [
      `${request.method} ${request.url} HTTP/${request.httpVersion}`,
    ];
    for (const [name, value] of Object.entries(
      upstreamHeaders(request.headers),
    )) {
      for (const item of Array.isArray(value) ? value : [value])
        lines.push(`${name}: ${item}`);
    }
    target.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  const close = () => {
    target.destroy();
    socket.destroy();
  };
  target.on("error", close);
  socket.on("error", close);
});

server.listen(Number(values.port), values.host, () => {
  console.log(
    `profiling app on http://${values.host}:${values.port} -> ${upstream.origin} (assets from ${dist})`,
  );
});
