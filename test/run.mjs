// The analysis on tracked samples (from test/track.mjs), the part chosen as on the timeline: prints what the app
// would show. node test/run.mjs <x.samples.json> [--from s] [--to s] [--height cm] [--kg kg] [--move pullup|…] [--reps]
import { readFileSync } from "node:fs";
import { analyse, fmtMetric } from "../js/kip.js";

const [file] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
const D = JSON.parse(readFileSync(file, "utf8"));
const from = +arg("from", 0), to = +arg("to", 1e9);
const samples = D.samples.filter((s) => s.t >= from && s.t <= to);
const R = analyse(samples, { W: D.W, heightCm: +arg("height", 0) || undefined, kg: +arg("kg", 0) || undefined, move: arg("move", "auto") });
if (R.error) { console.log("ERROR", R.error); process.exit(1); }
console.log(`${R.title}   [${R.moveFrom}] fs ${R.fs} · view ${R.view.alpha.toFixed(0)}° [${R.view.band.map((x) => x.toFixed(0)).join("–")}] (${R.view.from}, turn ${R.view.spread.toFixed(0)}°, depth says ${R.view.depth?.toFixed(0)}°) · facing ${R.facing} (${R.facingFrom}) · cons ${(R.consistency * 100).toFixed(0)}% · ${R.moving ? "MOVING" : "still"} (wander ${(R.wander * 100).toFixed(1)}% stature) · ${R.scale.pxPerM.toFixed(0)} px/m`);
console.log("tiles:", R.tiles.map((t) => `${t.label} ${t.value}${t.unit}`).join(" | "));
for (const r of R.reps) {
  console.log(`  rep ${r.n} ${r.kind} ${r.valid.padEnd(6)} t=${(R.T[r.top] + from).toFixed(2)} hipsFirst ${(r.hipsFirst * 1000).toFixed(0)}ms snap${r.snapDir > 0 ? "+" : "-"} kip ${r.fromKip === null ? "-" : (r.fromKip * 100).toFixed(0)}% work ${r.workRatio === null ? "-" : (r.workRatio * 100).toFixed(0)}% rise ${(r.rise * 100).toFixed(0)}cm F ${r.peakForce.toFixed(2)} kept ${r.kept === null ? "-" : (r.kept * 100).toFixed(0)}% hang ${(r.hang * 100).toFixed(0)}% | chin ${(r.std.chinU * 100).toFixed(0)} chest ${(r.std.chest * 100).toFixed(0)} feet ${(r.std.feet * 100).toFixed(0)} sh ${(r.std.shTop * 100).toFixed(0)} lock ${r.std.lock ? (r.std.lock * 100).toFixed(0) : "-"} ${r.kipping ? "kip" : "strict"}`);
}
for (const c of R.checks) console.log(`  [${c.status}] ${c.basis}: ${c.title} — ${c.text}`);
for (const c of R.film) console.log(`  film [${c.status}] ${c.title} — ${c.text}`);
if (process.argv.includes("--metrics")) for (const m of R.metrics) console.log(`  ${m.group} · ${m.label}: ${fmtMetric(m)} ${m.unit} ${m.note ? `(${m.note})` : ""}`);
