// The compare screen end to end in headless Google Chrome at Galaxy S23 size (360×780 CSS px, DPR 3, touch): three
// simulated sets (test/sim.mjs: two kipping pull-up sets and kip swings, on synthetic ffmpeg videos, so no clip of a
// person) kept in the gallery; compare two, scrub a chart, play, go back, compare three. Screenshots go to <out dir>.
//   node test/compare.mjs <out dir> [--dark] [--lang it]
import { chromium } from "playwright-core";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { simulate, film, PROGRAMS } from "./sim.mjs";
import { analyse } from "../js/kip.js";
import { markOf } from "../js/compare.js";

const dir = resolve(process.argv[2] || "out/compare");
mkdirSync(dir, { recursive: true });
const dark = process.argv.includes("--dark"), lang = process.argv.includes("--lang") ? process.argv[process.argv.indexOf("--lang") + 1] : "en";
const tag = `${lang}${dark ? "-dark" : ""}`;

// the sets: samples at 540×960 px (a small video), and the card the app would keep
const sets = [
  ["kip3", PROGRAMS.kipping({ reps: 3, lag: 0.15 }), 75],
  ["kip4", PROGRAMS.kipping({ reps: 4, lag: -0.05, depth: 0.8 }), null], // no bodyweight: J/kg against J, no difference
  ["swing", PROGRAMS.swing(), 75],
].map(([name, prog, kg]) => {
  const samples = film(simulate({ ...prog, fps: 30 }), { W: 540, Hpx: 960, f: 1050, noise: 2, wobble: 1.5 });
  const opts = { W: 540, slowmo: 1, facing: 0, move: "auto", heightCm: 178, kg };
  const R = analyse(samples, opts);
  if (R.error) throw new Error(`${name}: ${R.error}`);
  const dur = samples.at(-1).t + 0.1;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=540x960:rate=30:duration=${dur.toFixed(2)}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, `${name}.mp4`)]);
  return { name, samples, opts, title: R.title, move: R.move, tiles: R.tiles.slice(0, 2).map(({ label, value, unit }) => ({ label, value, unit })) };
});

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".png": "image/png", ".mp4": "video/mp4" };
const root = resolve(new URL("..", import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const p = u.startsWith("/__sets/") ? join(dir, u.slice(8)) : join(root, u === "/" ? "index.html" : u);
  if (!(p.startsWith(root + sep) || p.startsWith(dir + sep)) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light", serviceWorkers: "block" });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };
const errors = [];

// where a set is lined up follows the movement shown, also one picked by hand over what was detected
{
  const R = (move) => analyse(sets[0].samples, { ...sets[0].opts, move }), auto = R("auto"), r1 = auto.reps[0];
  check(markOf(auto).kind === "pull" && markOf(auto).i === r1.onset, "a pull-up set: at the first rep's pull");
  check(markOf(R("t2b")).kind === "top" && markOf(R("t2b")).i === r1.top, "the same set called toes-to-bar: at the first rep's top");
  const sw = R("swing"), m = markOf(sw);
  check(m.kind === "swing" && sw.swingDeg[m.i] < 0, "the same set called a kip swing: at the first swing back");
}
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
page.on("dialog", (d) => d.accept());
async function touchDrag(x0, y, x1, steps = 14) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y }] }); await page.waitForTimeout(20); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

await page.goto(url);
await page.evaluate((l) => localStorage.setItem("kiplab.lang", l), lang);
await page.evaluate(async (sets) => {
  const Store = await import("/js/store.js");
  let filmed = Date.parse("2026-11-20T10:00:00");
  for (const s of sets) {
    const blob = await (await fetch(`/__sets/${s.name}.mp4`)).blob();
    const id = Store.newId();
    filmed += 3600e3;
    const card = { id, filmed, saved: Date.now(), name: `${s.name}.mp4`, title: s.title, lift: s.move, kg: s.opts.kg, tiles: s.tiles };
    const data = { samples: s.samples, start: 0, end: null, fps: 30, W: 540, opts: { ...s.opts, facingOverride: null }, runStats: null, poseNote: "" };
    await Store.put(card, data, new File([blob], card.name, { type: "video/mp4" }));
  }
}, sets);
await page.reload();
await page.waitForFunction(() => !document.getElementById("btnGallery").hidden);
await page.click("#btnGallery");
await page.waitForFunction(() => document.querySelectorAll("#galList .pick input").length === 3);
const boxes = page.locator("#galList .pick input");
await boxes.nth(1).click();
check(await page.evaluate(() => document.getElementById("btnGalCompare").disabled), "Compare off with one ticked");
console.log("     bar:", await page.textContent("#galBarText"));
await boxes.nth(2).click();
check(!(await page.evaluate(() => document.getElementById("btnGalCompare").disabled)), "Compare on with two ticked");
await page.screenshot({ path: `${dir}/${tag}-1-gallery.png` });
await page.click("#btnGalCompare");
await page.waitForFunction(() => document.querySelectorAll("#cmpTable tr").length > 5 && window.__kiplabCompare.L.every((l) => l.W), null, { timeout: 15000 });
await page.waitForTimeout(500);
const st = await page.evaluate(() => { const C = window.__kiplabCompare; return { n: C.L.length, lo: C.lo, hi: C.hi, tau: C.tau, marks: C.L.map((l) => l.mark), read: document.getElementById("cmpRead").textContent, note: document.getElementById("cmpNote").hidden, legend: [...document.querySelectorAll("#cmpLegend li")].map((li) => li.textContent), t: C.L.map((l) => l.video.currentTime) }; });
console.log("    ", JSON.stringify(st));
check(st.n === 2 && st.tau === 0, "two sets, at τ = 0");
check(st.t.every((t, k) => Math.abs(t - (st.marks[k].i / 30)) < 0.05), "each video at its mark");
const rows = await page.evaluate(() => [...document.querySelectorAll("#cmpTable tr")].map((tr) => [...tr.children].map((c) => c.textContent).join(" | ")));
console.log(rows.map((r) => "     " + r).join("\n"));
await page.screenshot({ path: `${dir}/${tag}-2-compare.png`, fullPage: true });
// scrub the hip chart sideways
const box = await page.evaluate(() => { const c = document.getElementById("cmpHips"); c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
await touchDrag(box.x + box.w * 0.3, box.y + box.h / 2, box.x + box.w * 0.7);
await page.waitForTimeout(400);
const after = await page.evaluate(() => { const C = window.__kiplabCompare; return { tau: C.tau, t: C.L.map((l) => l.video.currentTime), want: C.L.map((l) => C.vt(l, C.tau)) }; });
console.log("     after scrub", JSON.stringify(after));
check(after.tau > 0 && after.t.every((t, k) => Math.abs(t - after.want[k]) < 0.05), "scrubbing the hip chart moves every video");
// a vertical drag must not scrub
const tau0 = after.tau;
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.w * 0.5, y: box.y + 40 }] });
for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.w * 0.5 + 1, y: box.y + 40 + i * 12 }] }); await page.waitForTimeout(20); }
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
check(await page.evaluate((t) => window.__kiplabCompare.tau === t, tau0), "a vertical drag on a chart doesn't scrub");
// play
await page.evaluate(() => window.scrollTo(0, 0));
await page.click("#cmpRates button[data-rate='1']");
const p0 = await page.evaluate(() => window.__kiplabCompare.tau);
await page.click("#cmpPlay");
await page.waitForTimeout(1500);
const p1 = await page.evaluate(() => { const C = window.__kiplabCompare; return { tau: C.tau, playing: C.playing, t: C.L.map((l) => l.video.currentTime), want: C.L.map((l) => C.vt(l, C.tau)), btn: document.getElementById("cmpPlay").textContent }; });
console.log("     playing", JSON.stringify(p1));
check(p1.playing && p1.tau - p0 > 1 && p1.t.every((t, k) => Math.abs(t - p1.want[k]) < 0.2), "playing moves τ and the videos together");
await page.screenshot({ path: `${dir}/${tag}-3-playing.png` });
// a speed change while playing: one clock, at the new speed
await page.click("#cmpRates button[data-rate='0.5']");
await page.waitForTimeout(300);
const h0 = await page.evaluate(() => [window.__kiplabCompare.tau, performance.now()]);
await page.waitForTimeout(1000);
const h1 = await page.evaluate(() => [window.__kiplabCompare.tau, performance.now()]);
const rate = (h1[0] - h0[0]) / ((h1[1] - h0[1]) / 1000);
check(Math.abs(rate - 0.5) < 0.08, `after switching to ½× while playing, τ runs at ${rate.toFixed(2)} s/s (want 0.5)`);
// play through the end: the shorter set finishes first and holds its last frame exactly, the longer one too at the end
await page.click("#cmpRates button[data-rate='1']");
await page.evaluate(() => { const C = window.__kiplabCompare; C.go(C.hi - 2.6); }); // the shorter set ends 2.3 s before
await page.waitForTimeout(3300);
const end = await page.evaluate(() => { const C = window.__kiplabCompare; return { playing: C.playing, tau: C.tau, hi: C.hi, off: C.L.map((l) => Math.abs(l.video.currentTime - l.R.tVideo(l.R.n - 1))) }; });
check(!end.playing && end.tau === end.hi && end.off.every((d) => d < 0.02), `played to the end: every video on its last frame (off by ${end.off.map((d) => d.toFixed(3)).join(", ")} s)`);
await page.click("#cmpPlay");
await page.waitForTimeout(300);
await page.click("#cmpPlay");
await page.waitForTimeout(400);
const ps = await page.evaluate(() => { const C = window.__kiplabCompare; return C.L.map((l) => Math.abs(l.video.currentTime - C.vt(l, C.tau))); });
check(ps.every((d) => d < 0.02), `paused: every video at the τ shown (off by ${ps.map((d) => d.toFixed(3)).join(", ")} s)`);
// back to the gallery, Forward onto the comparison again, back; then three
await page.click("#btnCmpBack");
await page.waitForFunction(() => window.__kiplab.mode === "gallery");
check(await page.evaluate(() => window.__kiplabCompare.L.length === 0 && document.getElementById("cmpPlay").disabled), "back closes the compare view (its controls off)");
await page.goForward();
await page.waitForFunction(() => window.__kiplab.mode === "compare" && window.__kiplabCompare.ready, null, { timeout: 15000 }).catch(() => {});
check(await page.evaluate(() => window.__kiplab.mode === "compare" && window.__kiplabCompare.L.length === 2), "Forward opens the same comparison again");
await page.goBack();
await page.waitForFunction(() => window.__kiplab.mode === "gallery");
const sel = await page.evaluate(() => document.querySelectorAll("#galList .pick input:checked").length);
for (const k of [0, 1, 2]) await boxes.nth(k).check();
await page.click("#btnGalCompare");
await page.waitForFunction(() => window.__kiplabCompare.L.length === 3 && window.__kiplabCompare.L.every((l) => l.W), null, { timeout: 15000 });
await page.waitForTimeout(500);
const st3 = await page.evaluate(() => { const C = window.__kiplabCompare; return { marks: C.L.map((l) => l.mark), read: document.getElementById("cmpRead").textContent, note: document.getElementById("cmpNote").textContent, cols: document.querySelector("#cmpTable tr").children.length }; });
console.log("    ", JSON.stringify(st3));
check(st3.cols === 4, "three sets: no difference column");
await page.screenshot({ path: `${dir}/${tag}-4-three.png`, fullPage: true });
// the phone's Back
await page.goBack();
await page.waitForFunction(() => window.__kiplab.mode === "gallery");
check(true, "the phone's Back returns to the gallery");
check(!errors.length, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
await browser.close();
server.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
