#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const root = args[args.indexOf("--root") + 1];
const mode = process.env.FAKE_MODE ?? "ok";
const token = process.env.HOLON_TOKEN;

if (args[0] !== "serve" || args[args.indexOf("--port") + 1] !== "0" || args[args.indexOf("--host") + 1] !== "127.0.0.1") {
  process.stderr.write("fake holon: unexpected arguments " + args.join(" ") + "\n");
  process.exit(64);
}

if (args.includes("--exit-on-stdin-close")) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
}

if (process.env.FAKE_PID_LOG) appendFileSync(process.env.FAKE_PID_LOG, process.pid + "\n");

if (mode === "hang") {
  process.stderr.write("fake holon: still waiting\n");
  setInterval(() => {}, 1000);
} else if (mode === "die") {
  process.stderr.write("fake holon: boom\n");
  process.exit(2);
} else {
  const send = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const bodyLimit = Number(process.env.FAKE_BODY_LIMIT ?? "0");
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer " + token) {
      send(response, 401, { ok: false, error: { code: "unauthorized", message: "missing or wrong bearer token" } });
      return;
    }
    const url = new URL(request.url, "http://fake");
    if (bodyLimit > 0 && Number(request.headers["content-length"] ?? "0") > bodyLimit && process.env.FAKE_BODY_MODE === "reset") {
      request.socket.destroy();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (bodyLimit > 0 && body.length > bodyLimit) {
        send(response, 413, { ok: false, error: { code: "body_too_large", message: "the body is larger than 64 MB" } });
      } else if (url.pathname === "/v0/health") {
        send(response, 200, { ok: true, format: "holon-health/v0", version: "fake" });
      } else if (url.pathname === "/v0/info") {
        send(response, 200, { pid: process.pid, root, token, address: server.address().port });
      } else if (url.pathname === "/v0/slow") {
        setTimeout(() => send(response, 200, { pid: process.pid }), 5000);
      } else if (url.pathname === "/v0/exit-soon") {
        send(response, 200, { pid: process.pid });
        setTimeout(() => process.exit(0), 20);
      } else if (url.pathname === "/v0/crash-once") {
        const marker = process.env.FAKE_CRASH_MARKER;
        if (!existsSync(marker)) {
          writeFileSync(marker, "crashed");
          request.socket.destroy();
          process.exit(1);
        }
        send(response, 200, { pid: process.pid });
      } else if (url.pathname === "/v0/check") {
        const broken = url.searchParams.get("commit") === "broken";
        send(response, broken ? 422 : 200, {
          format: "holon-check/v0",
          holons: 1,
          errors: broken ? [{ holon: null, file: "a.holon", message: "invalid JSON" }] : [],
          warnings: [],
        });
      } else if (url.pathname === "/v0/evidence" && request.method === "POST") {
        send(response, 200, {
          format: "holon-evidence-recorded/v0",
          recorded: body.split("\n").filter((line) => line !== "").length,
          reevaluated: 1,
          unknownHolons: [],
          contentType: request.headers["content-type"],
        });
      } else {
        send(response, 404, { ok: false, error: { code: "not_found", message: "no route " + request.method + " " + url.pathname, hint: "fake hint" } });
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = String(server.address().port);
    if (mode === "split") {
      const cut = port.length - 1;
      process.stderr.write("holon serve: listening on http://127.0.0.1:" + port.slice(0, cut));
      setTimeout(() => process.stderr.write(port.slice(cut) + "\n"), 150);
    } else {
      process.stderr.write("holon serve: listening on http://127.0.0.1:" + port + "\n");
    }
  });
}
