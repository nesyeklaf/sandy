import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_ID_KEY, deviceLabel, loadDeviceId, newDeviceId, screenText, shortDeviceId } from "./device.ts";

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0";
const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0";
const CHROME_ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 16; SM-S936B Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.7000.12 Mobile Safari/537.36";
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID_REDUCED = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";
const EDGE_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0";

test("labels name the OS, browser and major version, the Android model when the UA still has it", () => {
  assert.equal(deviceLabel(FIREFOX_LINUX), "Linux Firefox 158");
  assert.equal(deviceLabel(FIREFOX_WINDOWS), "Windows Firefox 157");
  assert.equal(deviceLabel(CHROME_ANDROID_WEBVIEW), "Android WebView 156 (SM-S936B)");
  assert.equal(deviceLabel(CHROME_ANDROID_REDUCED), "Android Chrome 156");
  assert.equal(deviceLabel(CHROME_MAC), "macOS Chrome 156");
  assert.equal(deviceLabel(SAFARI_IOS), "iOS Safari 18");
  assert.equal(deviceLabel(EDGE_WINDOWS), "Windows Edge 156");
});

test("a missing or unrecognisable user agent still gets a label", () => {
  assert.equal(deviceLabel(null), "unknown device");
  assert.equal(deviceLabel(""), "unknown device");
  assert.equal(deviceLabel("curl/8", "Linux x86_64"), "Linux x86_64");
  assert.equal(deviceLabel("curl/8"), "curl/8");
});

test("the device id is created once and read back from storage on the next load", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  const first = loadDeviceId(storage);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(store.get(DEVICE_ID_KEY), first);
  assert.equal(loadDeviceId(storage), first);
});

test("a malformed stored id is replaced, and blocked storage still gives one id per page", () => {
  const store = new Map<string, string>([[DEVICE_ID_KEY, "x"]]);
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  const fresh = loadDeviceId(storage);
  assert.notEqual(fresh, "x");
  const blocked = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  const first = loadDeviceId(blocked);
  assert.equal(loadDeviceId(blocked), first);
});

test("ids are random and short ids are a prefix", () => {
  assert.notEqual(newDeviceId(), newDeviceId());
  assert.equal(shortDeviceId("0123456789abcdef"), "012345");
  assert.equal(shortDeviceId(null), "-");
  assert.equal(screenText(2560, 1440), "2560x1440");
  assert.equal(screenText(0, 0), null);
});
