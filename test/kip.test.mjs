/* The analysis against the simulator's truth (test/sim.mjs): camera angle, scale, centre of mass, energy, force
 * through the bar, physics consistency; filmed side-on and turned, with tracking noise.
 *   node test/kip.test.mjs [--verbose] */
import { simulate, film, PROGRAMS } from "./sim.mjs";
import { analyse } from "../js/kip.js";

const verbose = process.argv.includes("--verbose");
let fails = 0;
const ok = (cond, msg) => { if (!cond) fails++; if (!cond || verbose) console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); };
const near = (got, want, tol, msg) => ok(Math.abs(got - want) <= tol, `${msg}: ${got.toFixed(3)} (want ${want.toFixed(3)} ± ${tol})`);
const rmsOf = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

function compare(name, sim, R) {
  // truth at the analysis grid's times
  const tr = (t) => sim.frames[Math.min(sim.frames.length - 1, Math.round(t * sim.fps))];
  const eF = [], eU = [], eE = [], eFu = [], eFf = [];
  const E0 = tr(R.T[0]).E - R.Er[0]; // the analysis's energy is relative to rest; line it up
  for (let i = 5; i < R.n - 5; i++) {
    const q = tr(R.T[i]);
    eF.push(R.comF[i] - q.com[0]); eU.push(R.comU[i] - q.com[1]);
    eE.push(R.E[i] - q.E / sim.M);
    eFu.push(R.Fu[i] - q.F[1] / (sim.M * 9.81)); eFf.push(R.Ff[i] - q.F[0] / (sim.M * 9.81));
  }
  const mE = eE.reduce((a, b) => a + b, 0) / eE.length;
  return { name, comF: rmsOf(eF), comU: rmsOf(eU), E: rmsOf(eE.map((v) => v - mE)), Fu: rmsOf(eFu), Ff: rmsOf(eFf), cons: R.consistency, alpha: R.view.alpha, from: R.view.from, k: R.scale.pxPerM };
}

// the swing: the physics (centre of mass, energy, force) and the camera angle, side-on to nearly front-on
const sim = simulate({ ...PROGRAMS.swing(), fps: 60 });
for (const alpha of [0, 30, 45, 60]) {
  for (const noise of [0, 4]) {
    const samples = film(sim, { alpha, noise, wobble: noise ? 3 : 0 });
    const R = analyse(samples, { W: 1080, heightCm: 178 });
    if (R.error) { ok(false, `swing α=${alpha} noise=${noise}: ${R.error}`); continue; }
    const c = compare(`swing α=${alpha} noise=${noise}`, sim, R);
    console.log(`${c.name}: view ${c.alpha.toFixed(1)}° (${c.from}) · com rms f ${(c.comF * 100).toFixed(1)} u ${(c.comU * 100).toFixed(1)} cm · E rms ${c.E.toFixed(2)} J/kg · F rms u ${c.Fu.toFixed(3)} f ${c.Ff.toFixed(3)} bw · consistency ${(c.cons * 100).toFixed(0)}%`);
    near(c.alpha, alpha, 8, `${c.name}: camera angle`);
    ok(c.comF < 0.03 && c.comU < 0.03, `${c.name}: centre of mass within 3 cm (rms)`);
    ok(c.E < 0.15, `${c.name}: energy within 0.15 J/kg (rms)`);
    ok(c.Fu < 0.08 && c.Ff < 0.12, `${c.name}: force through the bar within 0.08 / 0.12 bodyweights (rms)`);
    ok(c.cons > 0.5, `${c.name}: the swing explained by gravity (${(c.cons * 100).toFixed(0)}%)`);
  }
}

// kipping pull-ups: hips before arms, or arms first; reps, recognition, peak force against the truth
const timing = {};
for (const lag of [0.15, -0.15]) {
  const s = simulate({ ...PROGRAMS.kipping({ lag }), fps: 60 });
  const truthF = Math.max(...s.frames.map((q) => Math.hypot(...q.F) / (s.M * 9.81)));
  for (const alpha of [0, 40]) {
    const R = analyse(film(s, { alpha, noise: 3, wobble: 2 }), { W: 1080, heightCm: 178 });
    const name = `kipping, pull ${lag > 0 ? "after" : "before"} the hip snap, α=${alpha}`;
    if (R.error) { ok(false, `${name}: ${R.error}`); continue; }
    ok(R.move === "pullup" && R.kipping, `${name}: recognised as kipping pull-ups (${R.title})`);
    ok(R.reps.length === 3, `${name}: 3 reps (${R.reps.length})`);
    const hf = R.reps.map((r) => r.hipsFirst).sort((a, b) => a - b)[1];
    timing[`${lag}:${alpha}`] = hf;
    ok(lag > 0 ? hf > 0.1 : hf < 0.02, `${name}: hips before arms ${(hf * 1000).toFixed(0)} ms`);
    near(Math.max(...R.reps.map((r) => r.peakForce)), truthF, 0.35, `${name}: peak force through the bar (× bw)`);
  }
}
for (const alpha of [0, 40]) {
  const d = timing[`0.15:${alpha}`] - timing[`-0.15:${alpha}`];
  near(d, 0.3, 0.1, `α=${alpha}: the 0.3 s between pulling after and before the snap`);
}

// strict pull-ups: no kip
{
  const s = simulate({ ...PROGRAMS.kipping({ lag: 0.3, depth: 0.05, damp: 400 }), fps: 60 });
  const R = analyse(film(s, { alpha: 20, noise: 3, wobble: 2 }), { W: 1080, heightCm: 178 });
  ok(!R.error && R.move === "pullup" && !R.kipping && R.reps.length === 3, `strict pull-ups recognised (${R.error || R.title})`);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
