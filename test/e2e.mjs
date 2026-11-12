// End to end in headless Google Chrome at Galaxy S23 size (360×780 CSS px, DPR 3, touch): open a video, drag the
// timeline's end handle to the end of the set, track the body (MediaPipe), check the results, scrub the charts,
// keep it in the gallery and reopen it, read the share QR back. Screenshots go to <out dir>.
//   node test/e2e.mjs <video.mp4> <out dir> [--at s] [--end s] [--height cm] [--kg kg] [--expect pullup|c2b|t2b|bmu|swing] [--reps n] [--dark]
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import jsQR from "jsqr";

const [videoPath, outDir] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
const dark = process.argv.includes("--dark"), expect = arg("expect", null), wantReps = arg("reps", null);
mkdirSync(outDir, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".png": "image/png" };
const root = resolve(new URL("..", import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]), p = join(root, u === "/" ? "index.html" : u);
  if (!p.startsWith(root + sep) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light" });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
async function touchDrag(x0, y, x1, steps = 14) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y }] }); await page.waitForTimeout(20); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function dragHandle(which, t) {
  await page.evaluate(() => document.getElementById("timeline").scrollIntoView({ block: "center" }));
  const g = await page.evaluate((w) => {
    const tl = document.getElementById("timeline").getBoundingClientRect(), h = document.querySelector(`.timeline .handle.${w}`).getBoundingClientRect();
    return { left: tl.left, width: tl.width, hx: h.left + h.width / 2, hy: h.top + h.height / 2, hw: h.width, d: document.getElementById("video").duration };
  }, which);
  const x = g.left + g.hw + (t / g.d) * (g.width - 2 * g.hw) + (which === "in" ? -g.hw / 2 : g.hw / 2);
  await touchDrag(g.hx, g.hy, x);
}
let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
page.on("dialog", (d) => d.accept());

await page.goto(url);
await page.evaluate(([h, k]) => localStorage.setItem("kiplab.athlete", JSON.stringify({ heightCm: h ? +h : null, kg: k ? +k : null })), [arg("height", null), arg("kg", null)]);
await page.reload();
await page.screenshot({ path: `${outDir}/01-start.png`, fullPage: true });

await page.setInputFiles("#fileInput", videoPath);
await page.waitForFunction(() => /fps/.test(document.getElementById("videoInfo").textContent), null, { timeout: 30000 });
if (arg("end", null)) await dragHandle("out", +arg("end"));
if (arg("at", null)) await dragHandle("in", +arg("at"));
await page.waitForTimeout(400);
const part = await page.evaluate(() => [window.__kiplab.start, window.__kiplab.end ?? window.__kiplab.duration]);
check(!arg("at") || Math.abs(part[0] - +arg("at")) < 0.1, `start handle at ${part[0].toFixed(2)} s`);
check(!arg("end") || Math.abs(part[1] - +arg("end")) < 0.1, `end handle at ${part[1].toFixed(2)} s`);
await page.screenshot({ path: `${outDir}/02-choose.png` });

const t0 = Date.now();
await page.click("#btnAnalyse");
await page.waitForFunction(() => !document.getElementById("results").hidden || !document.getElementById("mark").hidden && /couldn't|stopped|rarely|below|wasn't/i.test(document.getElementById("markInstr").textContent), null, { timeout: 300000 });
const r = await page.evaluate(() => {
  const S = window.__kiplab, R = S.R;
  if (!R || document.getElementById("results").hidden) return { error: document.getElementById("markInstr").textContent };
  return { title: R.title, move: R.move, reps: R.reps.length, valid: R.reps.map((q) => q.valid), alpha: Math.round(R.view.alpha), moving: R.moving, frames: S.samples.length, posed: S.samples.filter((s) => s.pose).length,
    tiles: R.tiles.map((t) => `${t.label} ${t.value}${t.unit}`), checks: R.checks.map((c) => `[${c.status}] ${c.basis}: ${c.title}`), film: R.film.map((c) => `[${c.status}] ${c.title}`) };
});
if (r.error) { check(false, `analysis: ${r.error}`); } else {
  console.log(`     ${r.title} · ${r.frames} frames (${r.posed} with a body) in ${((Date.now() - t0) / 1000).toFixed(1)} s · camera ${r.alpha}°${r.moving ? " · phone moved" : ""}`);
  console.log(`     ${r.tiles.join(" | ")}`);
  for (const c of [...r.checks, ...r.film]) console.log(`     ${c}`);
  check(r.posed > 0.9 * r.frames, "the body found on nearly every frame");
  if (expect) check(r.move === expect, `recognised as ${expect} (got ${r.move})`);
  if (wantReps) check(r.reps === +wantReps, `${wantReps} reps (got ${r.reps})`);
}
await page.screenshot({ path: `${outDir}/03-results-top.png` });
await page.screenshot({ path: `${outDir}/04-results-full.png`, fullPage: true });

if (!r.error) {
  // scrub on the energy chart: the video follows
  const box = await page.locator("#energyChart").boundingBox();
  await page.evaluate(() => document.getElementById("energyChart").scrollIntoView({ block: "center" }));
  const b2 = await page.locator("#energyChart").boundingBox();
  await page.mouse.click(b2.x + b2.width * 0.6, b2.y + b2.height / 2);
  await page.waitForTimeout(500);
  const sc = await page.evaluate(() => { const S = window.__kiplab; return { cursor: S.cursor, want: S.R.tVideo(S.cursor), at: document.getElementById("video").currentTime }; });
  check(box && Math.abs(sc.at - sc.want) < 0.1, `scrubbing the energy chart moves the video (${sc.at.toFixed(2)} s, wanted ${sc.want.toFixed(2)})`);
  await page.waitForFunction(() => /Saved in the gallery|Couldn't keep/.test(document.getElementById("resSaved").textContent), null, { timeout: 20000 });
  check(/Saved in the gallery/.test(await page.textContent("#resSaved")), "kept in the gallery");
  // the gallery, and back into the set without tracking
  await page.click("#btnGallery2");
  await page.waitForFunction(() => document.querySelectorAll("#galList .lift").length === 1, null, { timeout: 10000 });
  await page.screenshot({ path: `${outDir}/05-gallery.png` });
  await page.click("#galList .lift .open");
  await page.waitForFunction(() => !document.getElementById("results").hidden && /From the gallery/.test(document.getElementById("resSaved").textContent), null, { timeout: 30000 });
  check((await page.evaluate(() => window.__kiplab.R.title)) === r.title, "reopened from the gallery, same result");
}
// share: the QR code reads back as the app's address
await page.evaluate(() => window.scrollTo(0, 0));
await page.click("#btnShareApp");
await page.waitForSelector("#shareDlg[open]");
await page.screenshot({ path: `${outDir}/06-share.png` });
const qr = await page.evaluate(async () => {
  const svg = document.querySelector("#shareQr svg"), img = new Image(), s = new XMLSerializer().serializeToString(svg).replace(/class="paper"/, 'fill="#fff"').replace(/class="ink"/, 'fill="#000"');
  img.src = `data:image/svg+xml;base64,${btoa(s)}`;
  await img.decode();
  const c = document.createElement("canvas"); c.width = c.height = 400;
  const g = c.getContext("2d"); g.drawImage(img, 0, 0, 400, 400);
  return { data: Array.from(g.getImageData(0, 0, 400, 400).data), link: document.getElementById("shareLink").textContent };
});
const code = jsQR(Uint8ClampedArray.from(qr.data), 400, 400);
check(code?.data === "https://croway.github.io/kiplab/", `share QR reads ${code?.data}`);
await page.click("#btnShareClose");

check(errors.length === 0, `no page errors${errors.length ? `:\n  ${[...new Set(errors)].slice(0, 8).join("\n  ")}` : ""}`);
await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
