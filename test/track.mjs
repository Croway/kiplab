// Body tracking over a real video in headless Chrome, with the app's own modules: writes the landmarks of every
// frame (the app's samples) and a contact sheet of frames with the skeleton drawn on them.
//   node test/track.mjs <video.mp4> <out prefix> [--model full|heavy|lite] [--every 6]
//   → <out>.samples.json, <out>.sheet.jpg (with ffmpeg)
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const [videoPath, out] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
const model = arg("model", "full"), every = +arg("every", 6);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".mp4": "video/mp4", ".task": "application/octet-stream" };
const root = resolve(new URL("..", import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const p = u === "/__video" ? resolve(videoPath) : join(root, u);
  if ((u !== "/__video" && !p.startsWith(root + sep)) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.goto(`http://localhost:${server.address().port}/test/track.html`);
await page.waitForFunction(() => window.ready);
const t0 = Date.now();
const r = await page.evaluate(([k, e]) => window.track("/__video", k, e), [model, every]);
console.log(`${videoPath}: ${r.W}×${r.H}, ${r.fps.toFixed(1)} fps, ${r.samples.length} frames, posed ${r.samples.filter((s) => s.pose).length}, ${r.model}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
writeFileSync(`${out}.samples.json`, JSON.stringify({ W: r.W, H: r.H, fps: r.fps, duration: r.duration, model: r.model, samples: r.samples }));
const dir = mkdtempSync(join(tmpdir(), "track-"));
r.shots.forEach((d, i) => writeFileSync(join(dir, `${String(i).padStart(3, "0")}.jpg`), Buffer.from(d.split(",")[1], "base64")));
try {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-i", join(dir, "%03d.jpg"), "-vf", `tile=8x${Math.ceil(r.shots.length / 8)}`, "-frames:v", "1", `${out}.sheet.jpg`]);
} catch (e) { console.error("contact sheet:", e.message); }
rmSync(dir, { recursive: true, force: true });
await browser.close();
server.close();
