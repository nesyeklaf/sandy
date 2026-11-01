import { test } from "node:test";
import assert from "node:assert/strict";
import { audioFileName, curlConfig, parseAuth } from "./transcribe.ts";

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

test("reads account id from the file, then from the token claims", () => {
  const direct = parseAuth(JSON.stringify({ tokens: { access_token: jwt({ exp: 2e9 }), account_id: "acc" } }), "f", 0);
  assert.deepEqual(direct.ok && direct.credentials.accountId, "acc");
  const claim = parseAuth(JSON.stringify({ tokens: { access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "c" } }) } }), "f");
  assert.equal(claim.ok && claim.credentials.accountId, "c");
});

test("flags an expired token and refuses a missing login", () => {
  const expired = parseAuth(JSON.stringify({ tokens: { access_token: jwt({ exp: 1 }), account_id: "a" } }), "f", 5000);
  assert.equal(expired.ok && expired.credentials.expired, true);
  assert.equal(parseAuth("{}", "f").ok, false);
  assert.equal(parseAuth("nope", "f").ok, false);
});

test("names the upload from the MIME type when the file has no extension", () => {
  assert.deepEqual(audioFileName({ type: "audio/webm;codecs=opus", name: "blob" }), { filename: "voice.webm", mimeType: "audio/webm" });
  assert.deepEqual(audioFileName({ type: "audio/wav", name: "t.wav" }), { filename: "t.wav", mimeType: "audio/wav" });
});

test("quotes curl config values so a header cannot break out of its line", () => {
  const config = curlConfig("https://x.test/a", { authorization: 'Bearer a"b\\c\nurl = "https://evil"' }, ["file=@/tmp/v.wav;type=audio/wav"], { body: "/tmp/b", headers: "/tmp/h" });
  const lines = config.trimEnd().split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'url = "https://x.test/a"');
  assert.equal(lines[3], 'header = "authorization: Bearer a\\"b\\\\c url = \\"https://evil\\""');
  assert.equal(lines[4], 'form = "file=@/tmp/v.wav;type=audio/wav"');
});
