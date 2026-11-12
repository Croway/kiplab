// The analysis on real clips, against what a person saw in them: a local regression test. The clips (and their
// tracked landmarks) are videos of people, so they stay out of the repo: track them with test/track.mjs into a
// folder, and describe them in that folder's clips.json:
//   [{ "file": "a.samples.json", "from": 0, "to": 8.6, "height": 165, "move": "pullup", "reps": 3, "kipping": true }]
//   node test/real.mjs <folder>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyse } from "../js/kip.js";

const dir = process.argv[2];
const clips = JSON.parse(readFileSync(join(dir, "clips.json"), "utf8"));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${m}`); };
for (const c of clips) {
  const D = JSON.parse(readFileSync(join(dir, c.file), "utf8"));
  const R = analyse(D.samples.filter((s) => s.t >= (c.from ?? 0) && s.t <= (c.to ?? 1e9)), { W: D.W, heightCm: c.height });
  const name = `${c.file} ${c.from ?? 0}–${c.to ?? "end"} s`;
  if (R.error) { ok(false, `${name}: ${R.error}`); continue; }
  if (c.move) ok(R.move === c.move, `${name}: ${c.move} (${R.title})`);
  if (c.reps !== undefined) ok(R.reps.length === c.reps, `${name}: ${c.reps} reps (${R.reps.length})`);
  if (c.kipping !== undefined) ok(R.kipping === c.kipping, `${name}: ${c.kipping ? "kipping" : "strict"}`);
  if (c.still !== undefined) ok(R.moving === !c.still, `${name}: phone ${c.still ? "still" : "moving"}`);
  if (c.alpha) ok(R.view.alpha >= c.alpha[0] && R.view.alpha <= c.alpha[1], `${name}: camera ${R.view.alpha.toFixed(0)}° in ${c.alpha.join("–")}`);
  ok(R.reps.every((r) => r.peakForce > 1.2 && r.peakForce < 3.5), `${name}: peak forces plausible (${R.reps.map((r) => r.peakForce.toFixed(1)).join(", ")}× bw)`);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
