import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { extname, join, normalize } from "node:path";

export const STAGING_ORIGIN = "http://127.0.0.1:39886";
export const GENUI_HASH = "5500e24ccb7f8088";
export const SIDEBAR_DELEGATE_HASH = "cc871f9f4974a1b2";

export const VARIANTS = {
  prod: { port: 32910, host: "host-prod", genui: "genui" },
  profiling: { port: 32911, host: "host-profiling", genui: "genui-unminified" },
  "genui-off": { port: 32912, host: "host-prod", genui: null },
};

const WS_ALLOW = new Set(["visibility", "subscribe", "unsubscribe", "ping"]);
const TYPES = {
  ".js": "text/javascript",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};
const IMMUTABLE = "public, max-age=31536000, immutable";

const upstream = new URL(STAGING_ORIGIN);

const sendFile = (res, file, cache) => {
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": cache,
  });
  res.end(readFileSync(file));
};

const upstreamHeaders = (headers) => ({
  ...headers,
  host: upstream.host,
  ...(headers.origin ? { origin: upstream.origin } : {}),
  ...(headers.referer
    ? { referer: upstream.origin + new URL(headers.referer).pathname }
    : {}),
});

const websocketTextTypes = () => {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const frames = [];
    for (;;) {
      if (buffer.length < 2) break;
      const opcode = buffer[0] & 15;
      let length = buffer[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = buffer[1] & 128;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) break;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      let type = null;
      if (opcode === 1) {
        try {
          type = JSON.parse(payload.toString("utf8")).type ?? "?";
        } catch {
          type = "unparsed";
        }
      }
      frames.push({ opcode, type });
      buffer = buffer.subarray(offset + length);
    }
    return frames;
  };
};

const localFile = (root, path) => {
  const file = normalize(join(root, path));
  return file.startsWith(root + "/") && existsSync(file) && statSync(file).isFile()
    ? file
    : null;
};

const rewritePlugins = (body, variant, labDir) => {
  const data = JSON.parse(body);
  const delegateDir = join(labDir, "sidebar-delegate");
  const delegateMeta = JSON.parse(readFileSync(join(delegateDir, "app.meta.json"), "utf8"));
  for (const plugin of data.plugins) {
    if (plugin.id === "sandy-sidebar-delegate") {
      const base = "/api/v1/plugin-app-assets/" + SIDEBAR_DELEGATE_HASH + "/";
      plugin.enabled = true;
      plugin.status = "running";
      plugin.app = {
        hasApp: true,
        bundle: {
          jsUrl: base + "app.js",
          cssUrl: base + "app.css",
          jsBytes: statSync(join(delegateDir, "app.js")).size,
          hash: SIDEBAR_DELEGATE_HASH,
          sdkMajor: delegateMeta.sdkMajor,
          sdkVersion: delegateMeta.sdkVersion,
          compatible: true,
          runtimeSlots: delegateMeta.runtimeSlots,
        },
      };
    }
    if (plugin.id === "genui" && variant.genui === null) plugin.app = { hasApp: false, bundle: null };
  }
  return JSON.stringify(data);
};

const PLUGIN_ASSETS = "/api/v1/plugin-app-assets/";

const labPluginFile = (labDir, path) => {
  if (!path.startsWith(PLUGIN_ASSETS)) return null;
  const [hash, ...rest] = path.slice(PLUGIN_ASSETS.length).split("/");
  if (!/^[0-9a-f]{16}$/.test(hash) || rest.length === 0) return null;
  return localFile(join(labDir, "plugins", hash), rest.join("/"));
};

export const startProxy = ({ labDir, labs = [{ name: null, dir: labDir }], auditPath, variants = Object.keys(VARIANTS) }) => {
  if (upstream.port !== "39886") throw new Error("upstream must be staging");
  const audit = (entry) => appendFileSync(auditPath, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
  const entries = labs.flatMap((lab, labIndex) =>
    variants.map((base) => ({ name: lab.name === null ? base : lab.name + ":" + base, base, labDir: lab.dir, port: VARIANTS[base].port + 10 * labIndex })),
  );
  const servers = entries.map(({ name, base, labDir, port: portNumber }) => {
    const variant = VARIANTS[base];
    const port = String(portNumber);
    const hostRoot = join(labDir, variant.host);
    const genuiBase = "/api/v1/plugin-app-assets/" + GENUI_HASH + "/";
    const delegateBase = "/api/v1/plugin-app-assets/" + SIDEBAR_DELEGATE_HASH + "/";
    const server = createServer((req, res) => {
      const url = new URL(req.url, upstream);
      const path = decodeURIComponent(url.pathname);
      if (req.method !== "GET" && req.method !== "HEAD") {
        audit({ port, method: req.method, path, decision: "reject" });
        req.resume();
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "lab_read_only", message: "lab proxy rejects writes" }));
        return;
      }
      audit({ port, method: req.method, path: path.startsWith("/assets/") ? "/assets/*" : path, decision: "allow" });
      if (!path.startsWith("/api/")) {
        if (path.startsWith("/assets/")) {
          const file = localFile(hostRoot, path);
          if (file) return sendFile(res, file, IMMUTABLE);
        } else if (path === "/" || !extname(path)) {
          return sendFile(res, join(hostRoot, "index.html"), "no-store");
        }
      }
      const pluginFile = labPluginFile(labDir, path);
      if (pluginFile) return sendFile(res, pluginFile, IMMUTABLE);
      if (path.startsWith(delegateBase)) {
        const file = localFile(join(labDir, "sidebar-delegate"), path.slice(delegateBase.length));
        if (file) return sendFile(res, file, IMMUTABLE);
      }
      if (path.startsWith(genuiBase)) {
        if (variant.genui === null) {
          audit({ port, method: req.method, path, decision: "blocked-genui-asset" });
          res.writeHead(404);
          res.end();
          return;
        }
        const name = path.slice(genuiBase.length);
        if (name === "app.js" || name === "app.js.map")
          return sendFile(res, join(labDir, variant.genui, name), IMMUTABLE);
      }
      if (path === "/api/v1/plugins") {
        const outgoing = httpRequest(
          {
            host: upstream.hostname,
            port: upstream.port,
            path: req.url,
            method: "GET",
            headers: { ...upstreamHeaders(req.headers), "accept-encoding": "identity" },
          },
          (incoming) => {
            const chunks = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.on("end", () => {
              let body = Buffer.concat(chunks).toString("utf8");
              try {
                body = rewritePlugins(body, variant, labDir);
              } catch (error) {
                audit({ port, method: "INJECT-ERR", path: String(error), decision: "pass" });
              }
              const headers = { ...incoming.headers };
              delete headers["content-length"];
              delete headers["content-encoding"];
              delete headers.etag;
              headers["cache-control"] = "no-store";
              res.writeHead(incoming.statusCode, headers);
              res.end(body);
            });
          },
        );
        outgoing.on("error", (error) => {
          if (!res.headersSent) res.writeHead(502);
          res.end(String(error));
        });
        outgoing.end();
        return;
      }
      const outgoing = httpRequest(
        { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: upstreamHeaders(req.headers) },
        (incoming) => {
          res.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(res);
        },
      );
      outgoing.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(String(error));
      });
      req.pipe(outgoing);
    });
    server.on("upgrade", (req, socket, head) => {
      audit({ port, method: "WS-UPGRADE", path: new URL(req.url, upstream).pathname, decision: "allow" });
      const textTypes = websocketTextTypes();
      const target = connect(Number(upstream.port), upstream.hostname, () => {
        const lines = [req.method + " " + req.url + " HTTP/" + req.httpVersion];
        for (const [name, value] of Object.entries(upstreamHeaders(req.headers)))
          for (const item of Array.isArray(value) ? value : [value]) lines.push(name + ": " + item);
        target.write(lines.join("\r\n") + "\r\n\r\n");
        const forward = (chunk) => {
          for (const frame of textTypes(chunk)) {
            if (frame.opcode !== 1) continue;
            if (!WS_ALLOW.has(frame.type)) {
              audit({ port, method: "WS-MSG", path: frame.type, decision: "reject-close" });
              socket.destroy();
              target.destroy();
              return;
            }
            audit({ port, method: "WS-MSG", path: frame.type, decision: "allow" });
          }
          target.write(chunk);
        };
        if (head.length) forward(head);
        socket.on("data", forward);
        target.pipe(socket);
      });
      target.on("error", () => socket.destroy());
      socket.on("error", () => target.destroy());
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(portNumber, "127.0.0.1", () => resolve({ name, server, url: "http://127.0.0.1:" + port }));
    });
  });
  return Promise.all(servers);
};

export const stopProxy = (servers) =>
  Promise.all(
    servers.map(
      ({ server }) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
