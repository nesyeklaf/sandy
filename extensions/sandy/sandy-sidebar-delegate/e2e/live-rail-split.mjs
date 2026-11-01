// Real-mouse check of the split thread rail against a RUNNING sandy (the fork with the
// experimental_threadTocExtension slot) and this plugin. Not part of `npm run e2e`:
// that one starts a scratch sandy-app without the fork.
//   SANDY_LIVE_THREAD_URL=https://host:port/projects/<prj>/threads/<thr> \
//   node e2e/live-rail-split.mjs [--video /tmp/rail.webm] [--rounds 20]
// The thread needs 3+ user messages and topics. Reads the rail, hovers and clicks; writes nothing.
import { chromium } from "playwright";

const URL = process.env.SANDY_LIVE_THREAD_URL;
if (!URL) throw new Error("Set SANDY_LIVE_THREAD_URL");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const videoPath = arg("--video", null);
const rounds = Number(arg("--rounds", "20"));
const VIEWPORT = { width: 1300, height: 850 };

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " " + JSON.stringify(detail) : ""));
  if (!ok) failures.push(label);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  ...(videoPath ? { recordVideo: { dir: "/tmp/rail-video", size: VIEWPORT } } : {}),
});
const page = await ctx.newPage();
page.on("pageerror", (e) => failures.push("pageerror " + String(e).slice(0, 120)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("[data-thread-toc]");
await page.waitForTimeout(2500);

if (videoPath) {
  await page.evaluate(() => {
    const cursor = document.createElement("div");
    cursor.style.cssText =
      "position:fixed;z-index:99999;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:rgba(255,60,60,.85);border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.4)";
    const hud = document.createElement("div");
    hud.style.cssText =
      "position:fixed;z-index:99999;pointer-events:none;left:340px;top:56px;padding:8px 12px;border-radius:8px;background:rgba(0,0,0,.82);color:#fff;font:600 14px/1.4 ui-monospace,monospace;white-space:pre";
    document.body.append(cursor, hud);
    window.__step = "";
    addEventListener("mousemove", (e) => {
      cursor.style.left = e.clientX + "px";
      cursor.style.top = e.clientY + "px";
    });
    const tick = () => {
      const half = document.querySelector("[data-rail-half]")?.getAttribute("data-rail-half") ?? "-";
      const view = document.querySelector("[data-toc-view]")?.getAttribute("data-toc-view") ?? "closed";
      hud.textContent = window.__step + "\npointer half: " + half + "   popover: " + view;
      requestAnimationFrame(tick);
    };
    tick();
  });
}
const step = (text) => page.evaluate((t) => (window.__step = t), text);

const rail = await page.locator("[data-thread-toc]").first().boundingBox();
const view = () => page.evaluate(() => document.querySelector("[data-toc-view]")?.getAttribute("data-toc-view") ?? null);
const left = rail.x + rail.width * 0.25;
const right = rail.x + rail.width * 0.75;
const y0 = rail.y + 40;
const settle = (ms = 450) => page.waitForTimeout(ms);
const scrollTops = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 300 && getComputedStyle(e).overflowY !== "visible")
      .map((e) => Math.round(e.scrollTop)),
  );

await page.mouse.move(700, 450);
await settle(900);

await step("1. pointer on the LEFT half");
await page.mouse.move(rail.x - 120, y0, { steps: 10 });
await page.mouse.move(left, y0, { steps: 14 });
await settle(900);
check("left half shows the messages", (await view()) === "messages");

await step("2. move to the RIGHT (colored) half");
await page.mouse.move(right, y0 + 6, { steps: 14 });
await settle(1100);
check("right half shows the topics", (await view()) === "topics");

await step("2b. glide down the RIGHT half, beside the lines: the topic follows the mouse");
const litBands = () =>
  page.evaluate(() => [...document.querySelectorAll("[data-toc-band]")].map((e) => e.getAttribute("data-highlighted") === "true"));
const bandRects = await page.evaluate(() => [...document.querySelectorAll("[data-toc-band]")].map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
const besideLines = rail.x + 18;
const seen = new Set();
let lostPick = 0;
await page.mouse.move(besideLines, rail.y + 14, { steps: 4 });
for (let y = rail.y + 14; y < rail.y + rail.height - 10; y += 9) {
  await page.mouse.move(besideLines, y, { steps: 2 });
  await page.waitForTimeout(120);
  const lit = await litBands();
  lit.forEach((on, i) => on && seen.add(i));
  if (!lit.some(Boolean)) lostPick++;
}
check("gliding beside the lines always has a topic picked", lostPick === 0, { lostPick });
check("gliding down switches through the topics", seen.size >= Math.min(3, bandRects.length), { seen: [...seen] });
for (let i = 0; i < bandRects.length; i++) {
  const y = (bandRects[i].top + bandRects[i].bottom) / 2;
  await page.mouse.move(besideLines, y, { steps: 3 });
  await settle(300);
  const lit = await litBands();
  const on = lit.map((v, k) => (v ? k : -1)).filter((k) => k >= 0);
  const covers = on.length === 1 && bandRects[on[0]].top - 3 <= y && y <= bandRects[on[0]].bottom + 3;
  check("mouse beside the lines at topic " + i + " picks a topic covering that height", covers, { on, y: Math.round(y) });
}
check("right half still shows the topics", (await view()) === "topics");

await step("3. back to the left half");
await page.mouse.move(left, y0 + 12, { steps: 14 });
await settle(1100);
check("left half again shows the messages", (await view()) === "messages");

await step("4. right half, then through the left half into the popover");
await page.mouse.move(right, y0, { steps: 12 });
await settle(900);
await page.mouse.move(left, y0 + 8, { steps: 6 });
await page.mouse.move(rail.x - 90, y0 + 8, { steps: 22 });
await settle(1000);
check("view stays topics on the way into the popover", (await view()) === "topics");

await step("5. hover each topic: its bracket lights up");
const panel = page.locator("[id^=thread-toc-panel-]");
const topicRows = panel.locator("button").filter({ hasText: "msgs" });
const topicCount = await topicRows.count();
check("topic rows listed", topicCount >= 2, { topicCount });
for (let i = 0; i < topicCount; i++) {
  const b = await topicRows.nth(i).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await settle(700);
  const lit = await page.evaluate(() => [...document.querySelectorAll("[data-toc-band]")].map((e) => e.getAttribute("data-highlighted") === "true"));
  check("topic " + i + " lights exactly its bracket", lit.filter(Boolean).length === 1 && lit[i] === true, { lit });
}

await step("6. click a topic: the timeline jumps");
const before = await scrollTops();
const target = topicRows.nth(Math.min(2, topicCount - 1));
const tb = await target.boundingBox();
await page.mouse.move(tb.x + 60, tb.y + 10, { steps: 8 });
await page.mouse.click(tb.x + 60, tb.y + 10);
await settle(1500);
const after = await scrollTops();
check("click on a topic scrolls the timeline", JSON.stringify(before) !== JSON.stringify(after), { before, after });

await step("7. leave: the popover closes");
await page.mouse.move(640, 420, { steps: 14 });
await settle(900);
check("popover closed", (await view()) === null);

await step("8. left half: click a message");
await page.mouse.move(left, y0, { steps: 10 });
await settle(900);
const msgRows = panel.locator("button").filter({ hasNotText: "msgs" });
const msgCount = await msgRows.count();
const rowIsInView = (snippet) =>
  page.evaluate((snip) => {
    const rows = [...document.querySelectorAll("[data-timeline-row-id]")].filter((e) => (e.textContent || "").includes(snip));
    return rows.some((e) => {
      const r = e.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    });
  }, snippet);
// A short slash-command message: its text is the whole row, so it is easy to find on screen afterwards.
const plainRows = msgRows.filter({ hasText: /^\/[a-z-]+$/ });
const picked = plainRows.first();
const snippet = (await picked.innerText()).split("\n")[0].replace(/^\//, "").replace(/\.\.\.$/, "").slice(0, 10);
const mb = await picked.boundingBox();
await page.mouse.move(mb.x + 60, mb.y + 8, { steps: 12 });
await settle(500);
await page.mouse.click(mb.x + 60, mb.y + 8);
await settle(1500);
await page.screenshot({ path: "/tmp/after-msg-click.png" });
check("click on a message brings that message into view", await rowIsInView(snippet), { snippet, msgCount });
await page.mouse.move(640, 420, { steps: 10 });
await settle(600);
await step("9. wheel over the rail (not over the text) scrolls the list");
await page.mouse.move(left, y0 + 20, { steps: 10 });
await settle(700);
const listTop = () => page.evaluate(() => { const p = document.querySelector("[id^=thread-toc-panel-]"); const s = p && [...p.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 5 && getComputedStyle(e).overflowY !== "visible"); return s ? s.scrollTop : null; });
const wheelBefore = await listTop();
await page.mouse.wheel(0, 240);
await settle(500);
const wheelAfter = await listTop();
check("wheel over the rail scrolls the message list", wheelBefore !== null && wheelAfter > wheelBefore, { wheelBefore, wheelAfter });
const pnb = await page.locator("[id^=thread-toc-panel-]").boundingBox();
await page.mouse.move(pnb.x + pnb.width - 3, pnb.y + 6, { steps: 8 });
await settle(300);
await page.mouse.wheel(0, 240);
await settle(500);
check("wheel over the popover edge scrolls the message list", (await listTop()) > wheelAfter, { wheelAfter, now: await listTop() });

await step("10. click on the rail, then click away: the popover closes");
await page.mouse.move(left, y0 + 20, { steps: 8 });
await settle(400);
await page.mouse.click(left, y0 + 20);
await settle(400);
await page.mouse.click(300, 300);
await settle(700);
check("click away closes the popover", (await view()) === null);

await step("11. hover right ON a line: that exact topic stays picked");
// The click-away above may have landed on a link in the thread and navigated; start from the thread again.
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("[data-thread-toc]");
await settle(2500);
await page.mouse.move(right, y0, { steps: 8 });
await settle(700);
const onLine = await page.evaluate(() => [...document.querySelectorAll("[data-toc-band]")].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
check("bands are on screen", onLine.length >= 2, { n: onLine.length });
for (let i = 0; i < onLine.length; i++) {
  await page.mouse.move(right, rail.y + 4, { steps: 4 });
  await page.mouse.move(onLine[i].x, onLine[i].y, { steps: 10 });
  await settle(350);
  const lit = await litBands();
  check("hovering on line " + i + " keeps exactly that topic", lit.filter(Boolean).length === 1 && lit[i] === true, { lit });
}
await page.mouse.move(640, 420, { steps: 10 });
await settle(500);
await step("done");
await settle(800);
await ctx.close();

// Randomised pass: entry side, speed and half vary; the view must always follow the half.
const page2 = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
await page2.goto(URL, { waitUntil: "networkidle" });
await page2.waitForSelector("[data-thread-toc]");
await page2.waitForTimeout(2500);
const view2 = () => page2.evaluate(() => document.querySelector("[data-toc-view]")?.getAttribute("data-toc-view") ?? null);
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const bad = [];
for (let i = 0; i < rounds; i++) {
  const side = ["left", "above", "below", "right"][Math.floor(rnd() * 4)];
  const half = rnd() < 0.5 ? "messages" : "topics";
  const tx = rail.x + rail.width * (half === "messages" ? 0.15 + rnd() * 0.3 : 0.6 + rnd() * 0.35);
  const ty = rail.y + 10 + rnd() * (rail.height - 20);
  await page2.mouse.move(side === "left" ? rail.x - 200 : side === "right" ? rail.x + rail.width + 100 : tx, side === "above" ? rail.y - 120 : side === "below" ? rail.y + rail.height + 120 : ty);
  await page2.waitForTimeout(150 + rnd() * 200);
  await page2.mouse.move(tx, ty, { steps: 2 + Math.floor(rnd() * 12) });
  await page2.waitForTimeout(260);
  if ((await view2()) !== half) bad.push({ i, side, half, phase: "enter" });
  const other = half === "messages" ? "topics" : "messages";
  await page2.mouse.move(rail.x + rail.width * (other === "messages" ? 0.2 : 0.8), ty, { steps: 3 });
  await page2.waitForTimeout(300);
  if ((await view2()) !== other) bad.push({ i, half: other, phase: "cross" });
  const pn = await page2.locator("[id^=thread-toc-panel-]").boundingBox();
  const py = Math.min(Math.max(ty, pn.y + 4), pn.y + pn.height - 4);
  await page2.mouse.move(pn.x + pn.width / 2, py, { steps: 3 + Math.floor(rnd() * 8) });
  await page2.waitForTimeout(300);
  if ((await view2()) !== other) bad.push({ i, phase: "into popover", expect: other });
  await page2.mouse.move(500, 300, { steps: 5 });
  await page2.waitForTimeout(250);
  if ((await view2()) !== null) bad.push({ i, phase: "leave" });
}
check("randomised: " + rounds + " rounds x 4 checks follow the pointer half", bad.length === 0, bad.slice(0, 5));

await browser.close();
if (videoPath) {
  const { readdirSync, renameSync } = await import("node:fs");
  const f = readdirSync("/tmp/rail-video").filter((n) => n.endsWith(".webm")).sort().pop();
  renameSync("/tmp/rail-video/" + f, videoPath);
}
console.log(failures.length ? "FAILED: " + failures.join("; ") : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
