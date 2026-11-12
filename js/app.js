/* Kip Lab: the screens and the flow. Get a video (record or pick), choose the set on the timeline, track the body
 * on every frame, analyse, show the replay and the charts. Everything runs on the device. Bar Path's app.js with
 * the plate marking taken out (the hands give the bar) and the results of js/kip.js. */
import { analyse, fmtMetric, MOVES } from "./kip.js";
import * as V from "./video.js";
import * as Pose from "./pose.js";
import * as Rec from "./recorder.js";
import * as Ov from "./overlay.js";
import { Timeline } from "./trim.js";
import { initShare } from "./share.js";
import * as Store from "./store.js";
import { Gallery } from "./gallery.js";
import { drawPath, pathHit, drawSeries, seriesHit, fillTip, where, GOAL } from "./kipcharts.js";
import { rampCss } from "./chartkit.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const video = $("video"), overlay = $("overlay"), viewer = $("viewer");

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
  $("btnSaveVideo").hidden = !recorded;
  $("btnAnalyse").disabled = true;
  $("markInstr").replaceChildren(
    "Drag the handles under the video to ", Object.assign(document.createElement("b"), { textContent: "just the set" }),
    ": from the hang before the first kip to the last rep, without jumping up or dropping off. Then Analyse.");
  TL.setVideo(0, 30);
  setMode("mark");
  $("videoInfo").textContent = "Opening the video…";
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
  $("resSaved").textContent = "From the gallery on this phone. Choose again to change the part.";
  $("btnDelete").hidden = false;
}
function videoInfo() {
  const parts = [`${S.W}×${S.H}`, `${Math.round(S.fps)} fps`, `${S.duration.toFixed(1)} s`];
  $("videoInfo").textContent = parts.join(" · ") + (S.fps < 50 ? ". 60 fps catches the kip's snap better." : "");
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
    ? `${S.start.toFixed(2)}–${endT().toFixed(2)} s · ${(endT() - S.start).toFixed(2)} s`
    : `${t.toFixed(2)} s`;
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
  $("btnPreview").textContent = "Stop";
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
  $("btnPreview").textContent = "Play";
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
  progress(0, "Loading body tracking…");
  try { P = await Pose.load(kind); } catch (e) {
    setMode("mark");
    $("markInstr").textContent = `Body tracking couldn't load (${e?.message || e}). It needs the internet the first time.`;
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
      onProgress: (p) => progress(p, `Tracking the body… ${samples.length} frames`),
    });
  } catch (e) {
    setMode("mark");
    if (e?.name !== "AbortError") $("markInstr").textContent = `Tracking stopped: ${e?.message || e}`;
    shown();
    return;
  }
  S.samples = samples;
  S.runStats = { frames: samples.length, seconds: (performance.now() - began) / 1000, pose: `${P.kind} on ${P.delegate}` };
  showResults(true);
  if (S.mode === "results") saveSet(true);
}
$("btnAnalyse").addEventListener("click", run);
$("btnCancel").addEventListener("click", () => S.abort?.abort());
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.mode === "running" && video.paused) video.play().catch(() => {}); });

/* ------------------------------------------------------------------ results */
const STATUS = { good: ["✓", "Good"], warning: ["!", "Watch"], serious: ["!!", "Work on"] };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const VALID = { pass: ["✓", "ok"], unsure: ["?", "maybe"], no: ["✗", "no"] };

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
    `${R.moveFrom === "you" ? "chosen by you" : "recognised from the body"}`,
    `faces ${R.facing > 0 ? "right" : "left"}`,
    `camera ~${Math.round(v.alpha)}° from side-on`,
    R.kg ? `${R.kg} kg` : null,
    R.slow > 1 ? `slowed ${R.slow}×` : null,
    st ? `${st.frames} frames in ${st.seconds.toFixed(0)} s, ${st.pose}` : null,
  ].filter(Boolean).join(" · ");

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
  $("notes").replaceChildren(...[...R.notes, S.poseNote].filter(Boolean).map((n) => el("li", null, n)));

  // reps
  $("repsCard").hidden = !R.reps.length;
  if (R.reps.length) {
    const t = $("repsTable"), kip = R.kipping;
    t.replaceChildren();
    const head = el("tr");
    const cols = ["Rep", "Std", ...(kip ? ["Kip", "Hips→arms"] : []), "Peak", "Work", "Rise", "Time"];
    for (const h of cols) head.append(el("th", null, h));
    t.append(head);
    for (const r of R.reps) {
      const tr = el("tr");
      tr.dataset.rep = r.n;
      const [mark, cls] = VALID[r.valid];
      const std = el("td", cls, mark);
      std.title = r.checks.map((c) => c.text).join(", ");
      tr.append(el("td", null, String(r.n) + (R.best === r.n ? " ★" : "")), std);
      const cells = [...(kip ? [r.fromKip === null ? "–" : `${Math.round(100 * r.fromKip)}%`, `${Math.round(r.hipsFirst * 1000)}`] : []),
        `${r.peakForce.toFixed(1)}×`, r.workRatio === null ? "–" : `${Math.round(100 * r.workRatio)}%`, `${Math.round(r.rise * 100)}`, r.cycle === null ? "–" : r.cycle.toFixed(2)];
      for (const c of cells) tr.append(el("td", null, c));
      tr.addEventListener("click", () => setCursor(r.top, true));
      t.append(tr);
    }
    $("repsNote").textContent = [R.best ? "★ cost the least work." : null,
      kip ? "Kip: the rep's energy already there when the arms start to pull. Hips→arms: ms from the hip snap to the pull." : null,
      "Peak: force through the bar, × bodyweight. Work: the muscles' work over the rep, against lifting the body that high. Rise: cm the centre of mass went up. Time: s, top to top."].filter(Boolean).join(" ");
  }

  // checks, filming
  const fill = (ul, list) => {
    ul.replaceChildren();
    for (const c of list) {
      const li = el("li");
      const [icon, word] = STATUS[c.status];
      const ico = el("span", `ico ${c.status}`, icon);
      ico.setAttribute("aria-hidden", "true");
      const body = el("div");
      const ttl = el("div", "ttl");
      if (c.basis) ttl.append(el("span", "basis", c.basis));
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
      const tr = el("tr"), th = el("th", null, group);
      th.colSpan = 2;
      tr.append(th);
      table.append(tr);
    }
    const tr = el("tr"), a = el("td", null, m.label);
    if (m.note && m.label !== "Style" && m.label !== "Hip snap") a.append(el("span", "n", m.note));
    tr.append(a, el("td", "v", `${fmtMetric(m)} ${m.label === "Style" || m.label === "Hip snap" ? "" : m.unit}`.trim()));
    table.append(tr);
  }
  $("pathSub").textContent = `The centre of mass, coloured by speed, and the ${(GOAL[R.move] || GOAL.pullup)[1].toLowerCase()} (thin), around the bar. True scale. Drag across it to scrub.`;

  drawCharts();
  setCursor(S.cursor, true);
  if (!fresh) queueSave();
}

function drawCharts() {
  if (!S.R || S.mode !== "results") return;
  const R = S.R, c = S.cursor;
  S.geo = {
    energy: drawSeries($("energyChart"), R, c, { lines: [{ v: R.kg ? R.Er.map((x) => x * R.kg) : R.Er, color: "--s1", width: 2.25 }, { v: R.kg ? R.PEr.map((x) => x * R.kg) : R.PEr, color: "--s3", width: 1.75 }], unit: R.kg ? "J" : "J/kg", d: R.kg ? 0 : 1, lo: 0 }),
    force: drawSeries($("forceChart"), R, c, { lines: [{ v: R.Fb, color: "--s2", width: 2.25 }], unit: "× bodyweight", d: 1, ref: 1, lo: 0 }),
    shape: drawSeries($("shapeChart"), R, c, { lines: [{ v: R.hip, color: "--s2", width: 2 }, { v: R.shoulder, color: "--s5", width: 2 }], unit: "°", d: 0, ref: 0 }),
  };
  S.geoPath = drawPath($("pathChart"), R, c);
  $("rampKey").style.background = rampCss(S.geoPath.stops);
  $("rampMax").textContent = `${S.geoPath.vTop.toFixed(1)} m/s`;
  for (const tr of $("repsTable").querySelectorAll("tr[data-rep]")) tr.classList.toggle("on", +tr.dataset.rep === R.repOf[c]);
}
function hud(i) {
  const R = S.R;
  const E = R.kg ? `${Math.round(R.Er[i] * R.kg)} J` : `${R.Er[i].toFixed(1)} J/kg`;
  $("hud").textContent = `${where(R, i)} · ${R.Fb[i].toFixed(1)}× bw · ${E}`;
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
  const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const show = (i, p) => {
    if (!tip) return;
    fillTip(tip, S.R, i);
    tip.hidden = false;
    const W = canvas.clientWidth, tw = tip.offsetWidth;
    tip.style.left = `${clamp(p.x + 14 + tw > W ? p.x - 14 - tw : p.x + 14, 0, W - tw)}px`;
    tip.style.top = `${clamp(p.y - 40, 0, canvas.clientHeight - tip.offsetHeight)}px`;
  };
  const move = (e) => { if (!S.R) return; const p = at(e), i = hit(p); setCursor(i, true); show(i, p); };
  canvas.addEventListener("pointerdown", move);
  canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) move(e); });
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
function stopPlayback() { if (S.playing) { S.playing = false; video.pause(); } $("btnPlay").textContent = "Play"; }
async function play() {
  if (!S.R) return;
  const tEnd = S.R.tVideo(S.R.n - 1);
  if (video.currentTime >= tEnd - 0.02) await V.seek(video, S.R.tVideo(0));
  video.playbackRate = S.rate;
  S.playing = true;
  $("btnPlay").textContent = "Pause";
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
video.addEventListener("pause", () => { if (S.mode === "results") { S.playing = false; $("btnPlay").textContent = "Play"; } });
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
for (const id of ["kg", "heightCm"]) {
  $(id).addEventListener("input", () => { clearTimeout(numTimer); numTimer = setTimeout(() => { saveAthlete(); if (S.mode === "results") showResults(); }, 350); });
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
    } else await Store.update(id, card, { opts: data.opts });
    $("resSaved").textContent = "Saved in the gallery, on this phone.";
    $("btnDelete").hidden = false;
  } catch (e) {
    $("resSaved").textContent = `Couldn't keep it in the gallery (${e?.message || e}).`;
  }
}
let saveTimer = 0;
const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveSet(false), 400); };

const GAL = new Gallery(
  { list: $("galList"), filters: $("galFilters"), summary: $("galSummary"), empty: $("galEmpty"), bar: $("galBar"), barText: $("galBarText"), remove: $("btnGalDelete") },
  { open: (id) => openSaved(id) },
);
async function galleryCount() {
  const n = await GAL.count();
  $("btnGallery").hidden = n === 0;
  $("btnGallery").textContent = `Gallery · ${n}`;
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
  if (!S.entryId || !confirm("Delete this set from Kip Lab's gallery? A video in your phone's Gallery app isn't affected.")) return;
  await Store.remove(S.entryId).catch(() => {});
  S.entryId = null;
  $("btnDelete").hidden = true;
  $("resSaved").textContent = "Deleted from the gallery.";
  galleryCount();
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
  $("camInfo").textContent = "Opening the camera…";
  try {
    S.cam = await Rec.openCamera($("camVideo"));
  } catch (e) {
    setMode("start");
    $("recordHint").textContent = `Couldn't open the camera here (${e?.message || e}). Record opens the camera app instead.`;
    return;
  }
  const cv = $("camVideo"), st = S.cam.settings;
  const fps = st.frameRate ? Math.round(st.frameRate) : null;
  $("camInfo").textContent = `${cv.videoWidth}×${cv.videoHeight}${fps ? ` at ${fps} fps` : ""}. Hold the phone upright, about 4 m away: the bar near the top mark, the feet at the back of the swing above the bottom one.` +
    (fps && fps < 50 ? " The browser gives 30 fps here; for 60, use Record (the camera app)." : "");
  let seen = false;
  S.stopLevel = Rec.watchLevel(({ roll, pitch }) => {
    seen = true;
    const ok = Math.abs(roll) < 1.5 && Math.abs(pitch) < 6;
    $("level").dataset.ok = ok ? "1" : "0";
    $("level").querySelector(".bubble").style.transform = `rotate(${(-roll).toFixed(1)}deg)`;
    $("levelRead").textContent = ok ? "Level ✓" : `Tilt ${roll > 0 ? "+" : "−"}${Math.abs(roll).toFixed(1)}° · ${pitch > 0 ? "up" : "down"} ${Math.abs(pitch).toFixed(0)}°`;
  });
  setTimeout(() => { if (!seen) $("levelRead").textContent = "Level: no motion sensor"; }, 1500);
}
function closeCam() {
  S.stopLevel?.(); S.stopLevel = null;
  Rec.closeCamera($("camVideo"), S.cam?.stream);
  S.cam = null; S.recorder = null;
  clearInterval(S.recTimer);
  $("recBadge").hidden = true;
  const b = $("btnRecToggle");
  b.dataset.on = "0"; b.textContent = "Start recording";
}
$("btnRecToggle").addEventListener("click", async () => {
  const b = $("btnRecToggle");
  if (!S.recorder) {
    S.recorder = Rec.startRecording(S.cam.stream);
    b.dataset.on = "1"; b.textContent = "Stop";
    const t0 = performance.now();
    $("recBadge").hidden = false;
    S.recTimer = setInterval(() => { $("recTime").textContent = ((performance.now() - t0) / 1000).toFixed(1); }, 100);
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
$("poseModel").addEventListener("change", () => { saveSettings(); if (S.mode === "results") $("notes").append(el("li", null, "Body tracking changes apply the next time you analyse (Choose again → Analyse).")); });

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
S.useSamples = (samples) => { S.samples = samples; S.runStats = { frames: samples.length, seconds: 0, pose: "given" }; showResults(true); if (S.mode === "results") saveSet(true); };

loadSettings();
$("btnCamLevel").hidden = !Rec.canRecordInApp();
setMode("start");
galleryCount();
takeShared();
export { MOVES };
