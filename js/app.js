/* Kip Lab: the screens and the flow. Get a video (record or pick), choose the set on the timeline, track the body
 * on every frame, analyse, show the replay and the charts. Everything runs on the device. Bar Path's app.js with
 * the plate marking taken out (the hands give the bar) and the results of js/kip.js. */
import { analyse, fmtMetric, inWords, MOVES } from "./kip.js";
import * as V from "./video.js";
import * as Pose from "./pose.js";
import * as Rec from "./recorder.js";
import * as Ov from "./overlay.js";
import { Timeline } from "./trim.js";
import { initShare } from "./share.js";
import * as Store from "./store.js";
import { Gallery, mb } from "./gallery.js";
import { drawPath, pathHit, drawSeries, seriesHit, fillTip, where, GOAL } from "./kipcharts.js";
import { rampCss, scrub } from "./chartkit.js";
import { tr, num, rich, applyDom, setLang, pickLang, LANGS } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const video = $("video"), overlay = $("overlay"), viewer = $("viewer");

/* the language first: every text below (and the timeline's) is read from its catalog */
let savedLang = null;
try { savedLang = localStorage.getItem("kiplab.lang"); } catch { /* storage unavailable: the phone's language */ }
try { await setLang(pickLang(savedLang)); } catch { await setLang("en"); } // a catalog that can't load: English
applyDom();
/** a number as String() writes it (72.5, 80), with the language's decimal mark */
const plain = (v) => num(v, (String(v).split(".")[1] || "").length);

const S = {
  src: null, blob: null, name: "set",
  W: 0, H: 0, duration: 0, fps: 30,
  start: 0, end: null,
  samples: null, R: null, cursor: null, facingOverride: null,
  mode: "start", abort: null, playing: false, rate: 0.25,
  cam: null, recorder: null, stopLevel: null, poseNote: "",
  file: null, filmed: 0, entryId: null, thumbFrame: null, runStats: null,
};
window.__kiplab = S; // for tests and debugging

/* ------------------------------------------------------------------ settings, and the athlete's height and weight */
const KEEP = ["slowmo", "poseModel"];
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("kiplab.settings") || "{}");
    for (const k of KEEP) if (s[k] != null && $(k).querySelector(`option[value="${CSS.escape(String(s[k]))}"]`)) $(k).value = s[k];
    const a = JSON.parse(localStorage.getItem("kiplab.athlete") || "{}");
    $("heightCm").value = a.heightCm ? String(a.heightCm) : "";
    $("kg").value = a.kg ? String(a.kg) : "";
  } catch { /* storage unavailable: defaults */ }
}
function saveSettings() {
  try { localStorage.setItem("kiplab.settings", JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, $(k).value])))); } catch { /* ignore */ }
}
function saveAthlete() {
  try { localStorage.setItem("kiplab.athlete", JSON.stringify({ heightCm: heightCm(), kg: kg() })); } catch { /* ignore */ }
}
const kg = () => { const v = parseFloat($("kg").value); return v >= 25 && v <= 200 ? v : null; };
const heightCm = () => { const v = parseFloat($("heightCm").value); return v >= 120 && v <= 230 ? v : null; };
const opts = () => ({ W: S.W, slowmo: +$("slowmo").value, facing: S.facingOverride ?? +$("facing").value, move: $("moveSel").value, heightCm: heightCm(), kg: kg() });

/* ------------------------------------------------------------------ screens */
function setMode(m) {
  S.mode = m;
  document.body.dataset.mode = m; // the app's header shows on the start screen only
  $("start").hidden = m !== "start";
  $("gallery").hidden = m !== "gallery";
  if (m === "gallery") stopPlayback();
  $("camera").hidden = m !== "camera";
  $("work").hidden = !["mark", "running", "results"].includes(m);
  $("mark").hidden = m !== "mark";
  $("running").hidden = m !== "running";
  $("results").hidden = m !== "results";
  $("hud").hidden = m !== "results";
  $("settings").hidden = ["camera", "running", "gallery"].includes(m);
  for (const id of ["btnPrev", "btnNext"]) $(id).disabled = m === "running";
  $("btnPreview").hidden = m !== "mark";
  stopPreview();
  TL.setMode(m === "mark" ? "trim" : m === "results" ? "scrub" : "off");
  if (m === "mark") TL.setHead(null);
  readout();
}

/* ------------------------------------------------------------------ open a video */
/** saved: { card, data } from the gallery: the analysis comes back as it was, without tracking again */
async function openVideo(file, name, recorded, saved = null) {
  stopPlayback();
  if (S.src) URL.revokeObjectURL(S.src);
  Object.assign(S, { blob: recorded ? file : null, name, src: URL.createObjectURL(file), samples: null, R: null, end: null, start: 0, cursor: null, facingOverride: null });
  Object.assign(S, { file, filmed: saved ? saved.card.filmed : file.lastModified || Date.now(), entryId: saved?.card.id ?? null, thumbFrame: null, runStats: null });
  if (!saved) { loadSettings(); $("moveSel").value = "auto"; $("facing").value = "0"; }
  $("resSaved").textContent = "";
  $("btnDelete").hidden = true;
  hideTrim();
  $("btnSaveVideo").hidden = !recorded;
  $("btnAnalyse").disabled = true;
  rich($("markInstr"), tr("mark.instr"));
  TL.setVideo(0, 30);
  setMode("mark");
  $("videoInfo").textContent = tr("mark.opening");
  try {
    const info = await V.load(video, S.src);
    Object.assign(S, { W: info.W, H: info.H, duration: info.duration });
    Ov.fitViewer(viewer, S.W, S.H);
    S.fps = saved?.data.fps || (await V.probeFps(video)) || 30;
    await V.seek(video, saved ? saved.data.start : 0);
    TL.setVideo(S.duration, S.fps);
    TL.filmstrip(S.src);
    if (saved) return restore(saved.data);
    TL.setRange(0, S.duration);
    $("btnAnalyse").disabled = false;
    shown();
    videoInfo();
  } catch (e) {
    setMode("start");
    $("recordHint").textContent = e.message || String(e);
  }
}
/** a saved set: its part, tracked frames and settings, then its results */
function restore(d) {
  const o = d.opts || {};
  for (const k of ["slowmo", "facing"]) if (o[k] !== undefined && $(k).querySelector(`option[value="${CSS.escape(String(o[k]))}"]`)) $(k).value = String(o[k]);
  $("moveSel").value = o.move || "auto";
  $("heightCm").value = o.heightCm ? String(o.heightCm) : "";
  $("kg").value = o.kg ? String(o.kg) : "";
  Object.assign(S, { start: d.start, end: d.end ?? null, samples: d.samples, runStats: d.runStats || null, poseNote: d.poseNote || "", facingOverride: o.facingOverride ?? null });
  TL.setRange(S.start, endT());
  $("btnAnalyse").disabled = false;
  videoInfo();
  showResults(true);
  $("resSaved").textContent = tr("res.fromGallery");
  $("btnDelete").hidden = false;
  updateTrim();
}
function videoInfo() {
  $("videoInfo").textContent = tr(S.fps < 50 ? "mark.infoLowFps" : "mark.info", { w: S.W, h: S.H, fps: Math.round(S.fps), dur: num(S.duration, 1) });
}

/* ------------------------------------------------------------------ scrubbing and choosing the part */
let seekBusy = null, seekWant = null;
/** seek, coalescing a burst of requests (a drag) into the latest; resolves when the video has settled */
function seekTo(t) {
  seekWant = clamp(t, 0, S.duration || 0);
  seekBusy ??= (async () => {
    try { while (seekWant !== null) { const x = seekWant; seekWant = null; await V.seek(video, x); } } catch { /* a newer seek wins */ }
    seekBusy = null;
    shown();
  })();
  return seekBusy;
}
const endT = () => S.end ?? S.duration;
function shown(t = video.currentTime) {
  if (S.mode === "results") TL.setHead(clamp(t, S.start, endT()));
  readout(t);
  redrawOverlay(t);
}
function readout(t = video.currentTime) {
  $("timeRead").textContent = S.mode === "mark" && !preview
    ? tr("mark.range", { from: num(S.start, 2), to: num(endT(), 2), dur: num(endT() - S.start, 2) })
    : tr("work.time", { t: num(t, 2) });
}
const TL = new Timeline($("timeline"), {
  onInput(what, t) {
    stopPlayback();
    stopPreview();
    if (what === "in") S.start = t;
    if (what === "out") S.end = t >= S.duration - 1e-6 ? null : t;
    if (what === "head" && S.R) { S.cursor = S.R.indexAt(t); drawCharts(); }
    seekTo(t);
    readout();
  },
  onCommit() {},
});
$("btnPrev").addEventListener("click", () => { stopPlayback(); TL.step(-1); });
$("btnNext").addEventListener("click", () => { stopPlayback(); TL.step(1); });

/* play the chosen part, to check the whole set is in it */
let preview = false;
async function startPreview() {
  stopPlayback();
  preview = true;
  $("btnPreview").textContent = tr("common.stop");
  await seekTo(S.start);
  if (!preview) return;
  video.playbackRate = 1;
  const frame = (t) => {
    if (!preview) return false;
    if (t >= endT()) { stopPreview(); return false; }
    TL.setHead(t);
    readout(t);
    return true;
  };
  if (V.hasRVFC) { const cb = (now, m) => { if (frame(m.mediaTime)) video.requestVideoFrameCallback(cb); }; video.requestVideoFrameCallback(cb); }
  else { const loop = () => { if (frame(video.currentTime)) requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
  video.addEventListener("ended", stopPreview, { once: true });
  video.play().catch(() => stopPreview());
}
function stopPreview() {
  if (!preview) return;
  preview = false;
  video.pause();
  $("btnPreview").textContent = tr("common.play");
  TL.setHead(null);
  seekTo(S.start);
}
$("btnPreview").addEventListener("click", () => (preview ? stopPreview() : startPreview()));

/* ------------------------------------------------------------------ tracking */
async function run() {
  stopPlayback();
  setMode("running");
  const ac = new AbortController();
  S.abort = ac;
  const progress = (p, text) => { $("progBar").style.width = `${(100 * clamp(p, 0, 1)).toFixed(1)}%`; $("prog").setAttribute("aria-valuenow", String(Math.round(100 * p))); $("progText").textContent = text; };
  const kind = $("poseModel").value;
  let P;
  S.poseNote = "";
  progress(0, tr("run.loading"));
  try { P = await Pose.load(kind); } catch (e) {
    setMode("mark");
    $("markInstr").textContent = tr("run.loadFailed", { err: e?.message || e });
    return;
  }
  if (ac.signal.aborted) return setMode("mark");
  await V.seek(video, S.start);
  S.thumbFrame = snapshot();
  Pose.beginRun(S.start);
  const samples = [{ t: S.start, pose: Pose.detect(P, video, S.start, S.W, S.H) }];
  const end = endT();
  const began = performance.now();
  try {
    await V.runFrames(video, {
      start: S.start, end, fps: S.fps, signal: ac.signal,
      onFrame: (t) => {
        if (t <= samples[samples.length - 1].t + 1e-6) return;
        const pose = Pose.detect(P, video, t, S.W, S.H);
        samples.push({ t, pose });
        Ov.draw(overlay, { W: S.W, H: S.H, pose });
      },
      onProgress: (p) => progress(p, tr("run.tracking", { n: samples.length })),
    });
  } catch (e) {
    setMode("mark");
    if (e?.name !== "AbortError") $("markInstr").textContent = tr("run.stopped", { err: e?.message || e });
    shown();
    return;
  }
  S.samples = samples;
  S.runStats = { frames: samples.length, seconds: (performance.now() - began) / 1000, pose: tr("run.pose", { kind: P.kind, delegate: P.delegate }) };
  showResults(true);
  if (S.mode === "results") saveSet(true);
}
$("btnAnalyse").addEventListener("click", run);
$("btnCancel").addEventListener("click", () => S.abort?.abort());
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.mode === "running" && video.paused) video.play().catch(() => {}); });

/* ------------------------------------------------------------------ results */
/** a check's status in words: good, warning, serious */
const STATUS = (s) => tr(`status.${s}`);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
/** a rep against the standard: icon, class (the words for screen readers: tr(`valid.${r.valid}`)) */
const VALID = { pass: ["check", "ok"], unsure: ["maybe", "maybe"], no: ["x", "no"] };
const SVG = "http://www.w3.org/2000/svg";
/** an icon from the sprite in index.html (#i-<name>), hidden from screen readers: the text next to it says it */
function icon(name, cls = "") {
  const s = document.createElementNS(SVG, "svg"), u = document.createElementNS(SVG, "use");
  s.setAttribute("class", `i ${cls}`.trim());
  s.setAttribute("aria-hidden", "true");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}
/** a note above the results: a warning tint and icon */
const note = (text) => { const li = el("li"); li.append(icon("warning", "ico warning"), el("span", null, text)); return li; };
/** a value and its unit: no space before ° and % */
const withUnit = (v, unit) => (!unit ? v : /^[°%]/.test(unit) ? `${v}${unit}` : `${v} ${unit}`);
/** check groups, in this order, by what a check rests on (ids; the headings: tr(`checks.basis.${id}`)) */
const BASIS = ["standard", "physics", "coaching"];

function showResults(fresh = false) {
  const R = analyse(S.samples, opts());
  if (R.error) {
    setMode("mark");
    $("markInstr").textContent = R.error;
    shown();
    return;
  }
  S.R = R;
  setMode("results");
  if (fresh || S.cursor === null || S.cursor >= R.n) S.cursor = R.reps[0]?.top ?? 0;

  $("resTitle").textContent = R.title;
  const st = S.runStats, v = R.view;
  $("resSub").textContent = [
    tr(R.moveFrom === "you" ? "res.sub.you" : "res.sub.body"),
    tr(R.facing > 0 ? "res.sub.facesRight" : "res.sub.facesLeft"),
    tr("res.sub.camera", { deg: Math.round(v.alpha) }),
    R.kg ? tr("res.sub.kg", { kg: plain(R.kg) }) : null,
    R.slow > 1 ? tr("res.sub.slowed", { k: R.slow }) : null,
  ].filter(Boolean).join(" · ");
  $("runInfo").textContent = st ? tr("res.runInfo", { frames: st.frames, s: num(st.seconds, 0), pose: st.pose }) : "";

  const tiles = $("tiles");
  tiles.replaceChildren();
  for (const t of R.tiles) {
    const d = el("div", "tile");
    d.append(el("div", "label", t.label));
    const val = el("div", "value", t.value);
    val.append(el("small", null, t.unit));
    d.append(val, el("div", "note", t.note));
    tiles.append(d);
  }
  $("notes").replaceChildren(...[...R.notes, S.poseNote].filter(Boolean).map(note));

  // reps
  $("repsCard").hidden = !R.reps.length;
  if (R.reps.length) {
    const t = $("repsTable"), kip = R.kipping;
    t.replaceChildren();
    const head = el("tr");
    // name and unit in the header; what each means in the list under the table
    const cols = [[tr("reps.col.rep")], [tr("reps.col.std")], ...(kip ? [[tr("reps.col.kip"), "%"], [tr("reps.col.hipsArms"), "ms"]] : []), [tr("reps.col.peak"), tr("unit.bw")], [tr("reps.col.work"), "%"], [tr("reps.col.rise"), "cm"], [tr("reps.col.time"), "s"]];
    for (const [h, u] of cols) {
      const th = el("th", null, h);
      if (u) th.append(el("span", "u", u));
      head.append(th);
    }
    t.append(head);
    for (const r of R.reps) {
      const row = el("tr");
      row.dataset.rep = r.n;
      const [mark, cls] = VALID[r.valid];
      const std = el("td", cls);
      std.append(icon(mark), el("span", "vh", tr(`valid.${r.valid}`)));
      std.title = r.checks.map((c) => c.text).join(", ");
      const go = el("button", "go", String(r.n)); // the row is tappable; the button gives it a keyboard way in
      go.type = "button";
      go.setAttribute("aria-label", tr(R.best === r.n ? "reps.jumpBest" : "reps.jump", { n: r.n }));
      if (R.best === r.n) go.append(icon("star", "best"));
      const first = el("td");
      first.append(go);
      row.append(first, std);
      const cells = [...(kip ? [r.fromKip === null ? "–" : `${Math.round(100 * r.fromKip)}%`, `${Math.round(r.hipsFirst * 1000)}`] : []),
        `${num(r.peakForce, 1)}×`, r.workRatio === null ? "–" : `${Math.round(100 * r.workRatio)}%`, `${Math.round(r.rise * 100)}`, r.cycle === null ? "–" : num(r.cycle, 2)];
      for (const c of cells) row.append(el("td", null, c));
      row.addEventListener("click", () => setCursor(r.top, true));
      t.append(row);
    }
    const defs = [
      ...(R.best ? [[icon("star", "best"), tr("reps.def.best")]] : []),
      ...(kip ? [[tr("reps.col.kip"), tr("reps.def.kip")], [tr("reps.col.hipsArms"), tr("reps.def.hipsArms")]] : []),
      [tr("reps.col.peak"), tr("reps.def.peak")], [tr("reps.col.work"), tr("reps.def.work")],
      [tr("reps.col.rise"), tr("reps.def.rise")], [tr("reps.col.time"), tr("reps.def.time")],
    ];
    $("repsDefs").replaceChildren(...defs.flatMap(([k, v]) => { const dt = el("dt"); dt.append(k); return [dt, el("dd", null, v)]; }));
  }

  // checks, filming
  const fill = (ul, list) => {
    ul.replaceChildren();
    // checks with a basis come grouped under it (standard, physics, coaching), each group in the analysis's order
    const order = (c) => (c.basis ? BASIS.indexOf(c.basis) : -1);
    let group = null;
    for (const c of [...list].sort((a, b) => order(a) - order(b))) {
      if (c.basis && c.basis !== group) {
        group = c.basis;
        const g = el("li", "grp");
        g.append(el("h4", null, tr(`checks.basis.${group}`)));
        ul.append(g);
      }
      const li = el("li");
      const word = STATUS(c.status);
      const ico = icon(c.status, `ico ${c.status}`);
      const body = el("div");
      const ttl = el("div", "ttl");
      ttl.append(document.createTextNode(c.title), el("span", null, word));
      body.append(ttl, el("div", "txt", c.text));
      li.append(ico, body);
      ul.append(li);
    }
  };
  fill($("checks"), R.checks);
  fill($("filmChecks"), R.film);

  // every measurement
  const table = $("table");
  table.replaceChildren();
  let group = null;
  for (const m of R.metrics) {
    if (m.group !== group) {
      group = m.group;
      const row = el("tr"), th = el("th", null, group);
      th.colSpan = 2;
      row.append(th);
      table.append(row);
    }
    const row = el("tr"), a = el("td", null, m.label);
    if (m.note && !inWords(m)) a.append(el("span", "n", m.note));
    row.append(a, el("td", "v", inWords(m) ? fmtMetric(m) : withUnit(fmtMetric(m), m.unit)));
    table.append(row);
  }
  $("pathSub").textContent = tr("path.subGoal", { goal: tr(`goal.${GOAL[R.move] || GOAL.pullup}`) });

  drawCharts();
  setCursor(S.cursor, true);
  if (!fresh) queueSave();
}

function drawCharts() {
  if (!S.R || S.mode !== "results") return;
  const R = S.R, c = S.cursor;
  S.geo = {
    energy: drawSeries($("energyChart"), R, c, { lines: [{ v: R.kg ? R.Er.map((x) => x * R.kg) : R.Er, color: "--s1", width: 2.25 }, { v: R.kg ? R.PEr.map((x) => x * R.kg) : R.PEr, color: "--s3", width: 1.75 }], unit: R.kg ? "J" : "J/kg", d: R.kg ? 0 : 1, lo: 0 }),
    force: drawSeries($("forceChart"), R, c, { lines: [{ v: R.Fb, color: "--s2", width: 2.25 }], unit: tr("unit.bodyweight"), d: 1, ref: 1, lo: 0 }),
    shape: drawSeries($("shapeChart"), R, c, { lines: [{ v: R.hip, color: "--s2", width: 2 }, { v: R.shoulder, color: "--s5", width: 2 }], unit: "°", d: 0, ref: 0 }),
  };
  S.geoPath = drawPath($("pathChart"), R, c);
  $("rampKey").style.background = rampCss(S.geoPath.stops);
  $("rampMax").textContent = tr("path.speedMax", { v: num(S.geoPath.vTop, 1) });
  for (const row of $("repsTable").querySelectorAll("tr[data-rep]")) row.classList.toggle("on", +row.dataset.rep === R.repOf[c]);
}
function hud(i) {
  const R = S.R;
  const E = R.kg ? `${Math.round(R.Er[i] * R.kg)} J` : `${num(R.Er[i], 1)} J/kg`;
  $("hud").textContent = tr("res.hud", { where: where(R, i), f: num(R.Fb[i], 1), energy: E });
}
function setCursor(i, seek) {
  if (!S.R) return;
  S.cursor = clamp(i, 0, S.R.n - 1);
  drawCharts();
  hud(S.cursor);
  if (seek) { stopPlayback(); seekTo(S.R.tVideo(S.cursor)); }
}

/* the replay overlay at video time t */
function nearestSample(t) {
  const a = S.samples;
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid].t < t) lo = mid; else hi = mid; }
  return Math.abs(a[lo].t - t) <= Math.abs(a[hi].t - t) ? a[lo] : a[hi];
}
function redrawOverlay(t = video.currentTime) {
  if (!S.W) return;
  if (S.mode === "results" && S.R) {
    const R = S.R, i = R.indexAt(t), vTop = S.geoPath?.vTop || 2;
    const from = Math.max(0, i - Math.round(1.5 * R.fs)), trail = [];
    for (let j = from; j <= i; j++) trail.push({ x: R.comX[j], y: R.comY[j], k: R.speed[j] / vTop });
    // the body's pull on the bar (the bar's on the body, reversed): 0.25 m on screen per bodyweight
    const k = 0.25 * R.K[i];
    const force = { x: -R.facing * R.Ff[i] * R.c * k, y: R.Fu[i] * k };
    Ov.draw(overlay, { W: S.W, H: S.H, pose: nearestSample(t).pose, bar: { x: R.Bx[i], y: R.By[i] }, com: { x: R.comX[i], y: R.comY[i] }, trail, force });
    hud(i);
  } else if (S.mode === "mark") {
    Ov.draw(overlay, { W: S.W, H: S.H });
  }
}

function bindChart(canvas, hit) {
  const tip = canvas.parentElement.querySelector(".tip");
  const show = (i, p) => {
    if (!tip) return;
    fillTip(tip, S.R, i);
    tip.hidden = false;
    const W = canvas.clientWidth, tw = tip.offsetWidth;
    tip.style.left = `${clamp(p.x + 14 + tw > W ? p.x - 14 - tw : p.x + 14, 0, W - tw)}px`;
    tip.style.top = `${clamp(p.y - 40, 0, canvas.clientHeight - tip.offsetHeight)}px`;
  };
  scrub(canvas, (p) => { if (!S.R) return; const i = hit(p); setCursor(i, true); show(i, p); }, { hover: true });
  canvas.addEventListener("pointerleave", () => { if (tip) tip.hidden = true; });
  canvas.addEventListener("pointercancel", () => { if (tip) tip.hidden = true; });
  canvas.addEventListener("keydown", (e) => {
    if (!S.R || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    setCursor(S.cursor + (e.key === "ArrowRight" ? 1 : -1) * Math.max(1, Math.round(S.R.fs / 30)), true);
  });
}
for (const id of ["energy", "force", "shape"]) bindChart($(`${id}Chart`), (p) => seriesHit(S.geo[id], p.x));
bindChart($("pathChart"), (p) => pathHit(S.geoPath, S.R, p.x, p.y));

/* replay */
function stopPlayback() { if (S.playing) { S.playing = false; video.pause(); } $("btnPlay").textContent = tr("common.play"); }
async function play() {
  if (!S.R) return;
  const tEnd = S.R.tVideo(S.R.n - 1);
  if (video.currentTime >= tEnd - 0.02) await V.seek(video, S.R.tVideo(0));
  video.playbackRate = S.rate;
  S.playing = true;
  $("btnPlay").textContent = tr("common.pause");
  const frame = (t) => {
    if (!S.playing) return false;
    if (t >= tEnd) { stopPlayback(); return false; }
    S.cursor = S.R.indexAt(t);
    drawCharts();
    shown(t);
    return true;
  };
  if (V.hasRVFC) {
    const cb = (now, m) => { if (frame(m.mediaTime)) video.requestVideoFrameCallback(cb); };
    video.requestVideoFrameCallback(cb);
  } else {
    const loop = () => { if (frame(video.currentTime)) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  video.play().catch(() => stopPlayback());
}
$("btnPlay").addEventListener("click", () => (S.playing ? stopPlayback() : play()));
video.addEventListener("pause", () => { if (S.mode === "results") { S.playing = false; $("btnPlay").textContent = tr("common.play"); } });
for (const b of document.querySelectorAll("#rates button")) {
  b.addEventListener("click", () => {
    S.rate = +b.dataset.rate;
    for (const o of document.querySelectorAll("#rates button")) o.setAttribute("aria-pressed", String(o === b));
    if (S.playing) video.playbackRate = S.rate;
  });
}

/* result actions */
$("btnFlip").addEventListener("click", () => { S.facingOverride = -S.R.facing; showResults(); });
$("moveSel").addEventListener("change", () => { if (S.mode === "results") showResults(); });
let numTimer = 0;
const numDone = () => { numTimer = 0; saveAthlete(); if (S.mode === "results") showResults(); };
for (const id of ["kg", "heightCm"]) {
  $(id).addEventListener("input", () => { clearTimeout(numTimer); numTimer = setTimeout(numDone, 350); });
}
$("btnAgain").addEventListener("click", () => { stopPlayback(); setMode("mark"); TL.setRange(S.start, endT()); seekTo(S.start); });
for (const id of ["btnNew", "btnNew2"]) $(id).addEventListener("click", () => { stopPlayback(); setMode("start"); galleryCount(); });

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
$("btnCsv").addEventListener("click", () => {
  const R = S.R, rows = ["time_s,com_forward_m,com_up_m,speed_m_s,energy_j_per_kg,height_energy_j_per_kg,bar_force_bw,bar_force_forward_bw,bar_force_up_bw,power_w_per_kg,hip_deg,shoulder_deg,reach_m,rep"];
  for (let i = 0; i < R.n; i++) {
    rows.push([(i / R.fs).toFixed(4), R.comF[i].toFixed(4), R.comU[i].toFixed(4), R.speed[i].toFixed(3), R.Er[i].toFixed(3), R.PEr[i].toFixed(3), R.Fb[i].toFixed(3), R.Ff[i].toFixed(3), R.Fu[i].toFixed(3), R.P[i].toFixed(2), R.hip[i].toFixed(1), R.shoulder[i].toFixed(1), R.reach[i].toFixed(3), R.repOf[i] || ""].join(","));
  }
  download(new Blob([rows.join("\n")], { type: "text/csv" }), `${S.name}-kip.csv`);
});
$("btnJson").addEventListener("click", () => {
  const R = S.R, t = (i) => +(i / R.fs).toFixed(4);
  const out = {
    app: "Kip Lab", video: { name: S.name, width: S.W, height: S.H, fps: +S.fps.toFixed(2) }, settings: opts(),
    movement: R.move, title: R.title, recognised: R.moveFrom, kipping: R.kipping, facing: R.facing > 0 ? "right" : "left",
    camera: { angle_deg: +R.view.alpha.toFixed(1), range_deg: R.view.band.map((x) => +x.toFixed(1)), from: R.view.from, phone_moved: R.moving },
    reps: R.reps.map((r) => ({ rep: r.n, top_s: t(r.top), standard: r.valid, checks: r.checks, from_kip: r.fromKip === null ? null : +r.fromKip.toFixed(3), hips_before_arms_s: +r.hipsFirst.toFixed(3),
      peak_bar_force_bw: +r.peakForce.toFixed(3), work_vs_lift: r.workRatio === null ? null : +r.workRatio.toFixed(3), rise_m: +r.rise.toFixed(3), energy_kept: r.kept === null ? null : +r.kept.toFixed(3), cycle_s: r.cycle })),
    measurements: R.metrics.map((m) => ({ ...m, value: +m.value.toFixed(4) })), checks: R.checks, filming: R.film,
  };
  download(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), `${S.name}-analysis.json`);
});
$("btnSaveVideo").addEventListener("click", () => { if (S.blob) download(S.blob, `${S.name}.${S.blob.type.includes("mp4") ? "mp4" : "webm"}`); });

/* ------------------------------------------------------------------ the gallery: analysed sets kept on this phone */
/** the frame the analysis starts on, small, for the gallery's thumbnail */
function snapshot() {
  const k = Math.min(1, 720 / Math.max(S.W, S.H)), c = document.createElement("canvas");
  c.width = Math.round(S.W * k); c.height = Math.round(S.H * k);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return c;
}
/** a 3:4 crop of the start frame around the bar and the centre of mass's path, with the path drawn on it */
function thumbnail(R) {
  const f = S.thumbFrame;
  if (!f) return Promise.resolve(null);
  const pad = 0.35 * R.K[0];
  let x0 = R.Bx[0], x1 = R.Bx[0], y0 = R.By[0], y1 = R.By[0];
  for (let i = 0; i < R.n; i++) { x0 = Math.min(x0, R.comX[i]); x1 = Math.max(x1, R.comX[i]); y0 = Math.min(y0, R.comY[i]); y1 = Math.max(y1, R.comY[i]); }
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  let w = x1 - x0, h = y1 - y0;
  if (w / h < 0.75) { x0 -= (0.75 * h - w) / 2; w = 0.75 * h; } else { y0 -= (w / 0.75 - h) / 2; h = w / 0.75; }
  const fit = Math.min(1, S.W / w, S.H / h);
  x0 += (w - w * fit) / 2; y0 += (h - h * fit) / 2; w *= fit; h *= fit;
  x0 = clamp(x0, 0, S.W - w); y0 = clamp(y0, 0, S.H - h);
  const c = document.createElement("canvas"), g = c.getContext("2d"), k = f.width / S.W;
  c.width = 150; c.height = 200;
  g.drawImage(f, x0 * k, y0 * k, w * k, h * k, 0, 0, c.width, c.height);
  const s = c.width / w, path = () => { g.beginPath(); for (let i = 0; i < R.n; i++) g[i ? "lineTo" : "moveTo"]((R.comX[i] - x0) * s, (R.comY[i] - y0) * s); };
  g.lineJoin = g.lineCap = "round";
  g.lineWidth = 5; g.strokeStyle = "rgba(0,0,0,0.55)"; path(); g.stroke(); // on footage: the overlay's halo and blue
  g.lineWidth = 2.5; g.strokeStyle = "#3987e5"; path(); g.stroke();
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
}
const setOpts = () => ({ ...opts(), facing: +$("facing").value, facingOverride: S.facingOverride });
/** keep this analysis: fresh = just tracked (a new set, or a set analysed again); otherwise its settings changed */
async function saveSet(fresh) {
  if (!S.R || !S.samples || !Store.available() || (!fresh && !S.entryId)) return;
  const R = S.R, id = S.entryId ?? Store.newId(), isNew = !S.entryId;
  // `lift` holds the movement: the same card as Bar Path's gallery
  const card = { id, filmed: S.filmed, saved: Date.now(), name: S.name, title: R.title, lift: R.move, kg: kg(), tiles: R.tiles.slice(0, 2).map(({ label, value, unit }) => ({ label, value, unit })) };
  const data = { samples: S.samples, start: S.start, end: S.end, fps: S.fps, W: S.W, opts: setOpts(), runStats: S.runStats, poseNote: S.poseNote };
  try {
    if (fresh) {
      card.thumb = await thumbnail(R);
      await Store.put(card, data, isNew ? S.file : null);
      S.entryId = id;
      galleryCount();
      updateTrim();
    } else await Store.update(id, card, { opts: data.opts });
    $("resSaved").textContent = tr("res.saved");
    $("btnDelete").hidden = false;
  } catch (e) {
    $("resSaved").textContent = tr("res.saveFailed", { err: e?.message || e });
  }
}
let saveTimer = 0;
const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = 0; saveSet(false); }, 400); };
/** a queued save done now, with a bodyweight or height still being typed: before something reads the saved set back
 * (keeping only the analysed part) */
const flushSave = async () => {
  if (numTimer) { clearTimeout(numTimer); numDone(); }
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  await saveSet(false);
};

const GAL = new Gallery(
  { list: $("galList"), filters: $("galFilters"), summary: $("galSummary"), status: $("galStatus"), empty: $("galEmpty"), bar: $("galBar"), barText: $("galBarText"), remove: $("btnGalDelete"), trim: $("btnGalTrim") },
  { open: (id) => openSaved(id) },
);
let howtoSet = false;
async function galleryCount() {
  const n = await GAL.count();
  $("btnGallery").hidden = n === 0;
  $("btnGallery").textContent = tr("start.galleryCount", { n });
  // the filming guide: open on the first visit, folded away once there are sets (Record comes first then)
  if (!howtoSet) { howtoSet = true; $("howto").open = n === 0; }
}

/* screens you can go back from with the phone's Back: each gets a history entry */
function push(screen) {
  history.replaceState({ ...history.state, screen: history.state?.screen ?? S.mode }, "");
  history.pushState({ screen }, "");
}
async function showGallery(fromHistory = false) {
  if (!fromHistory && S.mode !== "gallery") push("gallery");
  setMode("gallery");
  await GAL.refresh();
}
async function openSaved(id) {
  const got = await Store.get(id).catch(() => null);
  if (!got) { GAL.refresh(); return; }
  push("lift");
  const type = got.video.type || "video/mp4";
  await openVideo(new File([got.video], got.card.name, { type }), got.card.name, false, got);
}
window.addEventListener("popstate", (e) => {
  const to = e.state?.screen ?? "start";
  if (S.mode === "running") S.abort?.abort();
  if (to === "gallery") return showGallery(true);
  if ((to === "results" || to === "lift") && S.R) { setMode("results"); drawCharts(); return seekTo(video.currentTime); }
  if (to === "mark" && S.src) { setMode("mark"); return seekTo(S.start); }
  stopPlayback();
  setMode("start");
  galleryCount();
});
for (const id of ["btnGallery", "btnGallery2"]) $(id).addEventListener("click", () => showGallery());
$("btnGalBack").addEventListener("click", () => history.back());
$("btnDelete").addEventListener("click", async () => {
  if (!S.entryId || !confirm(tr("res.confirmDelete"))) return;
  await Store.remove(S.entryId).catch(() => {});
  S.entryId = null;
  $("btnDelete").hidden = true;
  hideTrim();
  $("resSaved").textContent = tr("res.deleted");
  galleryCount();
});

/* keeping only the analysed part of the saved video (js/clip.js, store.js): offered when it frees at least 5% */
let trimPlan = null;
function hideTrim() { trimPlan = null; $("trimRow").hidden = true; }
async function updateTrim() {
  hideTrim();
  const id = S.entryId;
  if (!id) return;
  try {
    const p = await Store.planTrim(id);
    if (!p || p.card.trimmed || S.entryId !== id || p.r.after > 0.95 * p.r.before) return;
    trimPlan = p;
    $("trimInfo").textContent = tr("res.trimInfo", { before: mb(p.r.before), after: mb(p.r.after) });
    $("btnTrim").disabled = false;
    $("trimRow").hidden = false;
  } catch { /* not an MP4 (a WebM recording), or no video track: nothing to offer */ }
}
$("btnTrim").addEventListener("click", async () => {
  const p = trimPlan;
  if (!p || p.card.id !== S.entryId) return;
  const ask = tr("res.confirmTrim", { before: mb(p.r.before), after: mb(p.r.after) }) + (S.blob ? `\n\n${tr("res.confirmTrimRecorded")}` : "");
  if (!confirm(ask)) return;
  $("btnTrim").disabled = true;
  try {
    await flushSave(); // settings changed a moment ago go with it
    await Store.applyTrim(p);
    const got = await Store.get(p.card.id);
    // open it again on the shorter video (its times moved with it); no new history entry
    await openVideo(new File([got.video], got.card.name, { type: got.video.type || "video/mp4" }), got.card.name, false, got);
    $("resSaved").textContent = tr("res.trimmed", { size: mb(p.r.after) });
    galleryCount();
  } catch (e) {
    $("trimInfo").textContent = tr("res.trimFailed", { err: e?.message || e });
    $("btnTrim").disabled = false;
  }
});

/* ------------------------------------------------------------------ getting a video */
$("fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, f.name.replace(/\.\w+$/, ""), false); });
$("captureInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, f.name ? f.name.replace(/\.\w+$/, "") : stamp(), false); });
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `set-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

// Record hands over to the camera app (60 fps; a page gets 30 at most on a Galaxy S23). The in-app camera, with
// framing marks and a level, stays one tap away.
$("btnRecord").addEventListener("click", () => $("captureInput").click());
$("btnCamLevel").addEventListener("click", () => openCam());
async function openCam() {
  setMode("camera");
  $("camInfo").textContent = tr("cam.opening");
  try {
    S.cam = await Rec.openCamera($("camVideo"));
  } catch (e) {
    setMode("start");
    $("recordHint").textContent = tr("cam.failed", { err: e?.message || e });
    return;
  }
  const cv = $("camVideo"), st = S.cam.settings;
  const fps = st.frameRate ? Math.round(st.frameRate) : null;
  $("camInfo").textContent = [tr(fps ? "cam.infoFps" : "cam.info", { w: cv.videoWidth, h: cv.videoHeight, fps }), fps && fps < 50 ? tr("cam.lowFps") : null].filter(Boolean).join(" ");
  let seen = false;
  S.stopLevel = Rec.watchLevel(({ roll, pitch }) => {
    seen = true;
    const ok = Math.abs(roll) < 1.5 && Math.abs(pitch) < 6;
    $("level").dataset.ok = ok ? "1" : "0";
    $("level").querySelector(".bubble").style.transform = `rotate(${(-roll).toFixed(1)}deg)`;
    $("levelRead").textContent = ok ? tr("cam.level") : tr(pitch > 0 ? "cam.tiltUp" : "cam.tiltDown", { roll: `${roll > 0 ? "+" : "−"}${num(Math.abs(roll), 1)}`, pitch: num(Math.abs(pitch), 0) });
  });
  setTimeout(() => { if (!seen) $("levelRead").textContent = tr("cam.noSensor"); }, 1500);
}
function closeCam() {
  S.stopLevel?.(); S.stopLevel = null;
  Rec.closeCamera($("camVideo"), S.cam?.stream);
  S.cam = null; S.recorder = null;
  clearInterval(S.recTimer);
  $("recBadge").hidden = true;
  const b = $("btnRecToggle");
  b.dataset.on = "0"; b.textContent = tr("cam.start");
}
$("btnRecToggle").addEventListener("click", async () => {
  const b = $("btnRecToggle");
  if (!S.recorder) {
    S.recorder = Rec.startRecording(S.cam.stream);
    b.dataset.on = "1"; b.textContent = tr("common.stop");
    const t0 = performance.now();
    $("recBadge").hidden = false;
    S.recTimer = setInterval(() => { $("recTime").textContent = num((performance.now() - t0) / 1000, 1); }, 100);
  } else {
    b.disabled = true;
    const blob = await S.recorder.stop();
    b.disabled = false;
    closeCam();
    openVideo(blob, stamp(), true);
  }
});
$("btnCamClose").addEventListener("click", () => { closeCam(); setMode("start"); });

/* ------------------------------------------------------------------ settings changes */
$("slowmo").addEventListener("change", () => { saveSettings(); if (S.mode === "results") showResults(); });
$("facing").addEventListener("change", () => { S.facingOverride = null; if (S.mode === "results") showResults(); });
$("poseModel").addEventListener("change", () => { saveSettings(); if (S.mode === "results") $("notes").append(note(tr("res.poseLater"))); });

/* the language: a choice only once there's more than one catalog; the page reloads in it */
{
  const sel = $("langSel"), langs = Object.entries(LANGS);
  sel.replaceChildren(...langs.map(([k, name]) => Object.assign(document.createElement("option"), { value: k, textContent: name })));
  sel.value = document.documentElement.lang;
  sel.closest("label").hidden = langs.length < 2;
  sel.addEventListener("change", () => {
    try { localStorage.setItem("kiplab.lang", sel.value); } catch { /* not kept: the phone's language next time */ }
    location.reload();
  });
}

/* ------------------------------------------------------------------ redraw on resize / theme */
let rz = 0;
const redraw = () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { drawCharts(); redrawOverlay(); }); };
window.addEventListener("resize", redraw);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
new ResizeObserver(redraw).observe(viewer);

/* ------------------------------------------------------------------ installable app (PWA) */
const standalone = matchMedia("(display-mode: standalone)").matches;
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* still works online without it */ });
  navigator.storage?.persist?.().catch(() => {});
}
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("btnInstall").hidden = false; });
window.addEventListener("appinstalled", () => { installPrompt = null; $("btnInstall").hidden = true; });
$("btnInstall").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $("btnInstall").hidden = true;
});
$("shareHint").hidden = !standalone;
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
$("installHint").hidden = !iOS || standalone || navigator.standalone === true;
initShare({ dialog: $("shareDlg"), open: $("btnShareApp"), qr: $("shareQr"), link: $("shareLink"), note: $("shareNote"), send: $("btnShareSend"), copy: $("btnShareCopy"), close: $("btnShareClose") });

/** a video shared to the app (manifest share_target): the service worker keeps it, the app opens it */
async function takeShared() {
  if (!new URLSearchParams(location.search).has("shared")) return false;
  history.replaceState(null, "", location.pathname);
  try {
    const c = await caches.open("kiplab-share"), res = await c.match("shared-video");
    if (!res) return false;
    await c.delete("shared-video");
    const blob = await res.blob(), name = decodeURIComponent(res.headers.get("X-File-Name") || "shared-video");
    openVideo(new File([blob], name, { type: blob.type || "video/mp4" }), name.replace(/\.\w+$/, ""), false);
    return true;
  } catch { return false; }
}

/* for tests: results from given samples, without tracking (the video must be open) */
S.useSamples = (samples) => { S.samples = samples; S.runStats = { frames: samples.length, seconds: 0, pose: tr("run.given") }; showResults(true); if (S.mode === "results") saveSet(true); };

loadSettings();
$("btnCamLevel").hidden = !Rec.canRecordInApp();
setMode("start");
galleryCount();
takeShared();
export { MOVES };
