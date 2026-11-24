/* Comparing saved sets: up to four, lined up at the first rep's pull. Their videos play and scrub together, their
 * centre of mass paths and hip angles share one chart each (one categorical colour per set), and every measurement
 * sits side by side, with the difference when there are two. Bar Path's compare.js with the body for the plate: the
 * paths are around the bar, the same place in every set (Bar Path draws each lift from its own start), and the
 * hips' hollow and arch take the bar speed's place.
 *
 * Time here is τ, seconds from each set's own mark (markOf); set k shows grid index mark + τ·fs, i.e. video time
 * R.tVideo(that index). */
import { analyse, MOVES, fmtMetric, inWords } from "./kip.js";
import { tr, num } from "./i18n.js";
import * as V from "./video.js";
import * as Ov from "./overlay.js";
import { tok, clamp, setup, ticks, fmt, dot, label, dotBox, scrub } from "./chartkit.js";
import { when } from "./gallery.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const withUnit = (v, unit) => (!unit ? v : /^[°%]/.test(unit) ? `${v}${unit}` : `${v} ${unit}`);
const TRAIL_S = 2; // the replay's trail: the last 2 s, as on the results
/** the measurements' groups in kip.js's order (a swing set has only the first two and the last: taken from whichever
 * set came first, the filming group would sit between a rep set's) */
const GROUPS = ["swing", "shape", "set", "energy", "force", "power", "timing", "standard", "filming"];

/**
 * What a set is lined up at, by the movement shown (the one picked on the results, when it was): the first rep's pull
 * (the arms start to pull); toes-to-bar have no pull to speak of, so the first rep's top (also reps found from the
 * feet but called a pull-up); swings, the first swing back (the centre of mass furthest behind the bar).
 * { i: grid index, kind: "pull" | "top" | "swing" | "start" }
 */
export function markOf(R) {
  const r = R.reps[0];
  if (r && R.move !== "swing") return R.fam === "pull" && R.move !== "t2b" ? { i: r.onset, kind: "pull" } : { i: r.top, kind: "top" };
  const back = (R.swingExt || []).find((i) => R.swingDeg[i] < 0);
  return back !== undefined ? { i: back, kind: "swing" } : { i: 0, kind: "start" };
}

export class Compare {
  /** refs: { videos, legend, scrub, read, play, prev, next, rates, path, hips, table, note } */
  constructor(refs) {
    this.r = refs;
    this.L = [];
    this.tau = 0;
    this.rate = 0.25;
    this.playing = false;
    refs.scrub.addEventListener("input", () => { this.stop(); this.go(+refs.scrub.value); });
    refs.prev.addEventListener("click", () => { this.stop(); this.go(this.tau - this.step()); });
    refs.next.addEventListener("click", () => { this.stop(); this.go(this.tau + this.step()); });
    refs.play.addEventListener("click", () => { if (this.playing) { this.stop(); this.go(this.tau); } else this.start(); });
    for (const b of refs.rates.querySelectorAll("button")) {
      b.addEventListener("click", () => {
        this.rate = +b.dataset.rate;
        for (const o of refs.rates.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        if (this.playing) { this.stop(); this.start(); }
      });
    }
    this.chartDrag(refs.hips, (x) => this.geoH && this.geoH.tauAt(x));
    this.chartDrag(refs.path, (x, y) => this.geoP && this.geoP.tauAt(x, y));
    this.controls(false);
  }
  step() { return 1 / Math.max(...this.L.map((l) => l.R.fs)); }

  /** items: [{ card, data, video: Blob }], already loaded from the store */
  async open(items) {
    this.close();
    const r = this.r, gen = this.gen;
    this.L = items.map((it, k) => {
      const o = it.data.opts || {};
      const R = analyse(it.data.samples, { ...o, facing: o.facingOverride ?? o.facing }); // as the results analyse it
      return { card: it.card, data: it.data, blob: it.video, k, R, color: `--s${k + 1}` };
    }).filter((l) => !l.R.error);
    for (const l of this.L) l.mark = markOf(l.R);
    const moves = new Set(this.L.map((l) => l.R.move));
    r.note.hidden = moves.size < 2;
    r.note.textContent = moves.size < 2 ? "" : tr("cmp.differentMoves", { moves: [...moves].map((x) => MOVES[x]).join(", ") });
    const kinds = new Set(this.L.map((l) => l.mark.kind));
    this.readKey = kinds.size === 1 ? `cmp.read.${[...kinds][0]}` : "cmp.read.mixed";

    // the range of τ covered by any set
    this.lo = Math.min(...this.L.map(({ R, mark }) => -mark.i / R.fs));
    this.hi = Math.max(...this.L.map(({ R, mark }) => (R.n - 1 - mark.i) / R.fs));
    r.scrub.min = String(this.lo); r.scrub.max = String(this.hi); r.scrub.step = "any";

    r.legend.replaceChildren();
    r.videos.replaceChildren();
    r.videos.dataset.n = String(this.L.length);
    for (const l of this.L) {
      const li = el("li");
      li.style.setProperty("--c", `var(${l.color})`);
      li.style.setProperty("--c-on", `var(${l.color}-on)`);
      li.append(el("span", "sw", String(l.k + 1)), el("span", "ttl", l.R.title), el("span", "when", when(l.card.filmed)));
      r.legend.append(li);

      const tile = el("figure", "cmp-tile");
      tile.style.setProperty("--c", `var(${l.color})`);
      tile.style.setProperty("--c-on", `var(${l.color}-on)`);
      const view = el("div", "viewer");
      const video = el("video"), canvas = el("canvas");
      video.muted = true; video.playsInline = true;
      view.append(video, canvas, el("span", "tag", String(l.k + 1)));
      tile.append(view, el("figcaption", null, `${l.R.title} · ${when(l.card.filmed)}`));
      r.videos.append(tile);
      Object.assign(l, { video, canvas, view, url: URL.createObjectURL(l.blob), busy: null, want: null });
    }
    try {
      await Promise.all(this.L.map(async (l) => {
        const info = await V.load(l.video, l.url);
        Object.assign(l, { W: info.W, H: info.H });
        Ov.fitViewer(l.view, info.W, info.H);
      }));
    } catch (e) {
      if (gen !== this.gen) return; // closed while loading: the video's source was taken away
      this.close();
      r.note.hidden = false;
      r.note.textContent = e?.message || String(e);
      return;
    }
    if (gen !== this.gen) return; // closed (Back) while the videos loaded: another compare may be opening
    this.ready = true;
    this.controls(true);
    this.table();
    this.go(0);
  }

  close() {
    this.gen = (this.gen || 0) + 1;
    this.stop();
    for (const l of this.L) { l.video.removeAttribute("src"); l.video.load(); URL.revokeObjectURL(l.url); }
    this.L = [];
    this.ready = false;
    this.controls(false);
    this.geoP = this.geoH = null; // their hit tests hold the sets (and through them the videos)
    this.r.table.replaceChildren();
    this.r.read.textContent = "";
    this.r.path.width = this.r.hips.width = 0; // blank until drawn again
  }
  /** the replay's controls work only once every video has loaded */
  controls(on) { for (const b of [this.r.play, this.r.prev, this.r.next, this.r.scrub]) b.disabled = !on; }

  /* τ for set l: its grid index and video time */
  idx(l, tau) { return clamp(Math.round(l.mark.i + tau * l.R.fs), 0, l.R.n - 1); }
  vt(l, tau) { return l.R.tVideo(this.idx(l, tau)); }

  /** show everyone at τ: seek each video (latest request wins), redraw */
  go(tau) {
    if (!this.ready) return;
    this.tau = clamp(tau, this.lo, this.hi);
    for (const l of this.L) this.seek(l, this.vt(l, this.tau));
    this.draw();
  }
  seek(l, t) {
    l.want = t;
    l.busy ??= (async () => {
      try { while (l.want !== null) { const x = l.want; l.want = null; await V.seek(l.video, x); } } catch { /* a newer seek wins */ }
      l.busy = null;
      this.overlay(l);
    })();
    return l.busy;
  }

  /* together: wall clock in real seconds, each video at rate × its slow-motion factor, nudged back when it drifts */
  async start() {
    if (!this.ready) return;
    if (this.tau >= this.hi - 1e-3) this.go(this.lo);
    const run = (this.run = (this.run || 0) + 1); // a speed change stops and starts again: the old loop must end
    this.playing = true;
    this.r.play.textContent = tr("common.pause");
    await Promise.all(this.L.map((l) => this.seek(l, this.vt(l, this.tau))));
    if (!this.playing || run !== this.run) return;
    for (const l of this.L) { l.held = false; l.video.playbackRate = this.rate * l.R.slow; l.video.play().catch(() => {}); }
    let last = performance.now();
    const tick = (now) => {
      if (!this.playing || run !== this.run) return;
      this.tau += ((now - last) / 1000) * this.rate;
      last = now;
      if (this.tau >= this.hi) { this.stop(); this.go(this.hi); return; } // the videos to the last frame shown
      for (const l of this.L) {
        const want = this.vt(l, this.tau), at = l.mark.i + this.tau * l.R.fs;
        if (at < 0 || at >= l.R.n - 1) { // not started yet, or finished: hold its first or last frame, exactly
          if (!l.held) { l.held = true; l.video.pause(); this.seek(l, want); }
          continue;
        }
        l.held = false;
        if (l.video.paused && !l.video.seeking) l.video.play().catch(() => {});
        if (Math.abs(l.video.currentTime - want) > 0.15 * Math.max(1, l.R.slow)) l.video.currentTime = want;
        this.overlay(l);
      }
      this.draw(false);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.run = (this.run || 0) + 1;
    this.r.play.textContent = tr("common.play");
    for (const l of this.L) l.video.pause();
  }

  /* drawing */
  overlay(l) {
    const { R } = l, i = R.indexAt(l.video.currentTime), trail = [];
    for (let j = Math.max(0, i - Math.round(TRAIL_S * R.fs)); j <= i; j++) trail.push({ x: R.comX[j], y: R.comY[j], k: null });
    Ov.draw(l.canvas, { W: l.W, H: l.H, bar: { x: R.Bx[i], y: R.By[i] }, com: { x: R.comX[i], y: R.comY[i] }, trail, color: tok(l.color) });
  }
  /** after a resize or a theme change, once every video is loaded */
  redraw() { if (this.ready) this.draw(); }
  draw(all = true) {
    this.r.scrub.value = String(this.tau);
    this.r.read.textContent = tr(this.readKey, { t: `${this.tau >= 0 ? "+" : "−"}${num(Math.abs(this.tau), 2)}` });
    this.geoP = drawPaths(this.r.path, this.L, this.tau, this);
    this.geoH = drawHips(this.r.hips, this.L, this.tau, this);
    if (all) for (const l of this.L) if (!l.busy) this.overlay(l);
  }
  chartDrag(canvas, at) {
    scrub(canvas, (p) => {
      const tau = at(p.x, p.y);
      if (tau !== undefined && tau !== null) { this.stop(); this.go(tau); }
    });
  }

  /** every measurement side by side; with two sets, the difference second minus first. A unit every set shares goes
   * under the label (Bar Path's way: narrow columns); different ones (J and J/kg: a bodyweight given for one set
   * only) stay with each value */
  table() {
    const t = this.r.table, two = this.L.length === 2;
    t.replaceChildren();
    const head = el("tr");
    head.append(el("th", null, ""));
    for (const l of this.L) { const th = el("th", "col"); th.style.setProperty("--c", `var(${l.color})`); th.style.setProperty("--c-on", `var(${l.color}-on)`); th.append(el("span", "sw", String(l.k + 1))); head.append(th); }
    if (two) head.append(el("th", "col", "2 − 1"));
    t.append(head);
    const rows = new Map(), groups = GROUPS.map((g) => tr(`metric.group.${g}`));
    for (const l of this.L) for (const m of l.R.metrics) {
      const key = `${m.group}\u0000${m.label}`;
      if (!groups.includes(m.group)) groups.push(m.group);
      if (!rows.has(key)) rows.set(key, { group: m.group, label: m.label, vals: [] });
      rows.get(key).vals[l.k] = m;
    }
    let group = null;
    for (const row of [...rows.values()].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group))) {
      if (row.group !== group) {
        group = row.group;
        const line = el("tr"), th = el("th", "grp", group);
        th.colSpan = this.L.length + 1 + (two ? 1 : 0);
        line.append(th);
        t.append(line);
      }
      const ms = row.vals.filter(Boolean), words = ms.some(inWords);
      const units = new Set(ms.map((m) => m.unit)), shared = !words && units.size === 1 ? [...units][0] : null;
      const shown = (m) => (inWords(m) ? fmtMetric(m) : shared !== null ? fmtMetric(m) : withUnit(fmtMetric(m), m.unit));
      const line = el("tr"), a = el("td", null, row.label);
      if (shared) a.append(el("span", "n", shared));
      line.append(a);
      for (const l of this.L) { const m = row.vals[l.k]; line.append(el("td", words ? "v words" : "v", m ? shown(m) : "–")); }
      if (two) {
        const [m1, m2] = row.vals;
        let d = "–";
        if (m1 && m2 && !words && m1.unit === m2.unit && Number.isFinite(m1.value) && Number.isFinite(m2.value)) {
          const dv = m2.value - m1.value, s = fmtMetric({ ...m2, value: Math.abs(dv) }), zero = s === fmtMetric({ ...m2, value: 0 });
          d = zero ? s : `${dv > 0 ? "+" : "−"}${s}`;
        }
        line.append(el("td", "v d", d));
      }
      t.append(line);
    }
  }
}

/* ------------------------------------------------------------------ the charts */
/** the part of a set the hip chart's scale fits: its reps, from half a second before the first to half a second after
 * the last (a jump onto the bar or a drop off it would set the scale and squash the reps), else all of it. As the
 * results' charts: the time series fit the reps, the path around the bar shows all of it */
function fitPart(R) {
  if (!R.stages.length) return [0, R.n - 1];
  const pad = Math.round(0.5 * R.fs);
  return [Math.max(0, Math.min(...R.stages.map((s) => s.i0)) - pad), Math.min(R.n - 1, Math.max(...R.stages.map((s) => s.i1)) + pad)];
}

/** every set's centre of mass around the bar in its colour, true scale (as kipcharts.js's drawPath); a dot where
 * each is at τ */
function drawPaths(canvas, L, tau, C) {
  const w0 = canvas.parentElement.clientWidth;
  let fl = -0.2, fr = 0.2, ub = 0.15, ul = -0.3;
  for (const { R } of L) for (let i = 0; i < R.n; i++) { fl = Math.min(fl, R.comF[i]); fr = Math.max(fr, R.comF[i]); ul = Math.min(ul, R.comU[i]); ub = Math.max(ub, R.comU[i]); }
  fl -= 0.08; fr += 0.08; ub += 0.08; ul -= 0.08;
  const m = { l: 38, r: 10, t: 22, b: 34 };
  const k = Math.min((w0 - m.l - m.r) / (fr - fl), 460 / (ub - ul)); // one scale both ways: the paths' true shape
  const h = Math.round(clamp(m.t + m.b + k * (ub - ul), 240, 520));
  const { ctx, w } = setup(canvas, h);
  const cx = m.l + (w - m.l - m.r - k * (fr - fl)) / 2;
  const px = (f) => cx + (f - fl) * k, py = (u) => m.t + (ub - u) * k;

  ctx.lineWidth = 1;
  for (const v of ticks(ul, ub, 6)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(fmt(v, 1), m.l - 6, py(v));
  }
  for (const v of ticks(fl, fr, 5)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(Math.round(px(v)) + 0.5, m.t); ctx.lineTo(Math.round(px(v)) + 0.5, h - m.b); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(v > 0 ? `+${fmt(v, 1)}` : fmt(v, 1), px(v), h - m.b + 5);
  }
  ctx.fillStyle = tok("--muted"); ctx.textBaseline = "top";
  ctx.textAlign = "left"; ctx.fillText(tr("chart.fromBar"), 4, 2);
  ctx.fillText(tr("chart.back"), m.l, h - 13);
  ctx.textAlign = "right"; ctx.fillText(tr("chart.forward"), w - m.r, h - 13);

  ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const { R, color } of L) {
    ctx.strokeStyle = tok(color);
    ctx.beginPath();
    for (let i = 0; i < R.n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, px(R.comF[i]), py(R.comU[i]));
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(px(0), py(0), 5, 0, 7); ctx.fillStyle = tok("--surface"); ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = tok("--ink"); ctx.stroke();
  const placed = [dotBox(px(0), py(0), 6)];
  for (const l of L) { const i = C.idx(l, tau); dot(ctx, px(l.R.comF[i]), py(l.R.comU[i]), 5, tok(l.color)); placed.push(dotBox(px(l.R.comF[i]), py(l.R.comU[i]), 5)); }
  label(ctx, tr("chart.bar"), px(0), py(0), "right", w, placed);
  return {
    tauAt(x, y) { // the nearest point of any path
      let best = null, bd = Infinity;
      for (const { R, mark } of L) for (let i = 0; i < R.n; i++) {
        const d = (px(R.comF[i]) - x) ** 2 + (py(R.comU[i]) - y) ** 2;
        if (d < bd) { bd = d; best = (i - mark.i) / R.fs; }
      }
      return best;
    },
  };
}

/** every set's hip angle (+ hollow, − arch) against time from its mark; a line at τ */
function drawHips(canvas, L, tau, C) {
  const h = 220;
  const { ctx, w } = setup(canvas, h);
  let lo = 0, hi = 0;
  for (const { R } of L) { const [a, b] = fitPart(R); for (let i = a; i <= b; i++) { lo = Math.min(lo, R.hip[i]); hi = Math.max(hi, R.hip[i]); } }
  const pad = 0.08 * (hi - lo || 1);
  lo -= pad; hi += pad;
  const m = { l: 38, r: 10, t: 20, b: 24 };
  const px = (s) => m.l + ((s - C.lo) / (C.hi - C.lo || 1)) * (w - m.l - m.r);
  const py = (v) => h - m.b - ((v - lo) / (hi - lo)) * (h - m.t - m.b);
  ctx.lineWidth = 1;
  for (const v of ticks(lo, hi, 5)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(fmt(v, 0), m.l - 6, py(v));
  }
  // time ticks, leaving room at the right end for the unit
  const unitX = w - m.r - ctx.measureText("s").width - 6;
  for (const v of ticks(C.lo, C.hi, 6)) {
    const text = v > 0 ? `+${fmt(v, 1)}` : fmt(v, 1);
    if (px(v) + ctx.measureText(text).width / 2 > unitX) continue;
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(Math.round(px(v)) + 0.5, m.t); ctx.lineTo(Math.round(px(v)) + 0.5, h - m.b); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(text, px(v), h - m.b + 5);
  }
  ctx.fillStyle = tok("--muted");
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("°", 4, 0);
  ctx.textAlign = "right"; ctx.fillText(tr("cmp.hips.axis"), w - m.r, 0);
  ctx.fillText("s", w - m.r, h - m.b + 5);
  ctx.save();
  ctx.beginPath(); ctx.rect(m.l, m.t - 3, w - m.l - m.r, h - m.t - m.b + 6); ctx.clip(); // values past the scale
  ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const { R, mark, color } of L) {
    ctx.strokeStyle = tok(color);
    ctx.beginPath();
    for (let i = 0; i < R.n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, px((i - mark.i) / R.fs), py(R.hip[i]));
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = tok("--ink-2"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(px(tau)) + 0.5, m.t); ctx.lineTo(Math.round(px(tau)) + 0.5, h - m.b); ctx.stroke();
  for (const l of L) { const i = C.idx(l, tau); dot(ctx, px((i - l.mark.i) / l.R.fs), clamp(py(l.R.hip[i]), m.t, h - m.b), 4, tok(l.color)); }
  return { tauAt: (x) => C.lo + clamp((x - m.l) / (w - m.l - m.r), 0, 1) * (C.hi - C.lo) };
}
