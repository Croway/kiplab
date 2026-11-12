# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Kip Lab: bar gymnastics (kipping/strict pull-ups, chest-to-bar, toes-to-bar, bar muscle-ups, kip swings) from one
phone video, as an installable PWA. Bar Path's sibling (`../barpath`), built to merge with it later: same layout,
conventions and shared code. Single target device: Galaxy S23, Chrome on Android. Plain ES modules, no build step,
no runtime dependencies besides the bundled MediaPipe in `vendor/` (fetched by `tools/fetch-vendor.sh`,
gitignored). Everything runs on the device; nothing is uploaded. Publishing (when set up): GitHub Pages by
`.github/workflows/pages.yml`, canonical link https://croway.github.io/kiplab/.

## Commands

```bash
npm run vendor && npm run serve          # dev server on :8766 (Bar Path uses :8765)
npm test                                 # analysis vs the simulator + QR read-back (must pass)
npm run shared                           # shared files vs ../barpath: identical / adapted / extracted
node test/track.mjs clip.mp4 out/clip    # MediaPipe over a real clip → out/clip.samples.json + contact sheet
node test/run.mjs out/clip.samples.json --from 0.5 --to 9 [--height 175] [--metrics]
node test/real.mjs <folder with clips.json>   # real clips vs what a person saw (local only)
node test/e2e.mjs clip.mp4 out --end 8.6 --expect pullup --reps 3
```

## Architecture

`trim.js` (timeline) chooses the set: the user cuts the walk-in and the drop; the analysis uses exactly that part.
`video.js` hands frames over in order → `pose.js` (MediaPipe, 33 landmarks) on every frame → samples
`{t, pose}` → `kip.js` `analyse(samples, opts)` (pure; re-runs instantly when movement, height, bodyweight or facing
change) → `app.js` renders (tiles, reps table, checks, filming card, `kipcharts.js` charts, `overlay.js` replay).

`body.js`: left/right pairs averaged into the body's middle plane (`bodies()`; filmed side-on, the hidden side's
points are dropped, decided once per clip); the 7-segment model (Winter) for the centre of mass; facing; the
camera's angle (`viewAngle`); the scale from segment lengths and the athlete's height; `toPlane` (perspective).

`kip.js`: grid + filtering (6 Hz positions, 5 Hz accelerations) → the bar (median grip point; followed frame by
frame when it drifts, i.e. the phone moved) → plane coordinates (m, bar at 0, f forward, u up) → centre of mass,
segment velocities → energy, force through the bar (× bw), muscle power, angular momentum check → angles (hip and
shoulder as + hollow / − arch) → reps (`findReps`) → standards, recognition, tiles, checks, film checks, metrics
(`report`). The result's shape for the UI: `title, tiles, reps, checks, film, metrics, stages, repOf, best`.

Signal helpers are in `signal.js` and chart basics in `chartkit.js` (extracted from Bar Path, see below).

### Decisions that matter (each was a real failure)
- **The hidden side**: side-on, MediaPipe guesses the far wrist/elbow, sometimes at the hip (visibility 0.2–0.4).
  Averaging it in dragged "the bar" 30–45 cm. Side-on clips (median min-visibility of the pairs < 0.6) use the
  visible side when the other is hidden; turned clips always average (frame-by-frame switching broke the angle fit
  on a front-ish muscle-up clip: 53° → 14°).
- **Arms pulling = reach** (shoulders' distance from the bar), not the elbow angle: an overhand pull bends the
  elbows sideways, towards a side-on camera; tracked elbow angles stayed ~165° through pulls. A pull rep needs the
  reach under 0.78 of a full hang (a bent-arm kipping pull ends near 0.65; a straight-arm swing stays above 0.9),
  otherwise the kip swing's shoulder rise counted as reps.
- **Pull start** = going back from the fastest shortening of the reach to under a fifth of that speed (a fixed
  "reach −10%" read every pull ~0.15 s late). Hips-before-arms is good to ~80 ms; checks only call a lead beyond
  0.1 s (three frames at 30 fps).
- **Camera angle**: median polish of log segment lengths (frame × segment) removes the body's size changing on
  screen; perspective is modelled (`CAMERA`: 4 m, lens 1.2 m below the bar, which side from the face's depth).
  Without perspective a camera 4.5 m away read 30° as 40°. Report the band, not just the number.
- **Phone moved** = the grip point's slow drift (0.4 Hz) over 8% of stature; the hands turning on the bar moves the
  grip point at the swing's frequency, and that isn't the phone moving.
- **Kipping vs strict** by the hip range in the drive (> 30°). Horizontal travel of the centre of mass doesn't tell:
  a strict rep moves it ~35 cm (the head has to clear the bar).
- **Energy-into-height at the top** was dropped: it's ~100% for every rep (the centre of mass is slowest at its
  peak). "From the kip" and "work per rep" replaced it. "Pump alignment" (tension × shortening) was dropped too:
  it penalised the shoulders' natural stretch under the snap's force spike and contradicted hips-before-arms.
- **The gravity check** (angular momentum about the bar changes only by gravity's torque) reads 63–93% on simulated
  swings with tracking noise but 10–50% on handheld 30 fps clips: a measurement, a warning only under 10%.
- **Chin over the bar** is good to ±4 cm from one video (bar from the grip point, chin from nose and mouth):
  pass > +3 cm, no-rep < −6 cm, too close to call in between.

### The simulator (`test/sim.mjs`)
Planar chain from the bar (hand+forearm, upper arm, trunk+head, thigh, shank+foot) with body.js's masses. The shape
is prescribed (keys of elbow, shoulder, hip, knee), the swing integrated from dH/dt = gravity's torque (+ an
optional grip torque: `damp` for strict reps, which a free grip would pump into a swing). Truth: points, centre of
mass, energy, bar force, grip torque. `film()` projects with a perspective camera at any angle and adds
MediaPipe-like noise. Keyframes must not repeat a time (a jump in shape is an infinite force).

## Shared with Bar Path (the merge plan)

`tools/shared-check.sh` keeps this honest. Today:
- **Identical** (change in both or neither): `js/video.js`, `js/pose.js`, `js/trim.js`, `js/qr.js`,
  `js/recorder.js`, `tools/render-icons.mjs`, `test/qr.test.mjs`, `.editorconfig`, the Pages workflow.
- **Adapted**: `js/store.js` (database name), `js/share.js` (share text), `js/gallery.js` (movements; compare
  optional), `js/overlay.js` (bar and centre of mass instead of the plate), `sw.js` (file list; cache prefix, and
  it deletes only its own old caches: Bar Path's deletes every other cache on the origin, which would wipe Kip
  Lab's offline copy on croway.github.io: fix there when merging or publishing both), `manifest.webmanifest`,
  `tools/phone.sh` (port 8766), `tools/fetch-vendor.sh` (+ the heavy model), `css/app.css` (Bar Path's plus a Kip
  Lab section at the end), `js/app.js`, `index.html`.
- **Extracted**: `js/signal.js` (Bar Path has these at the top of `analysis.js`), `js/chartkit.js` (the top of
  `charts.js` and `compare.js`).
- Gallery cards keep Bar Path's schema (`lift` holds the movement), so one gallery can hold both.
A merge: one app with two families (barbell: plate tracking + `analysis.js`; bar: body only + `kip.js`), the
shared files once, app name/texts from one place.

## Conventions
- Colours only via the CSS tokens in `css/app.css`; the guide diagram uses them too.
- Text into the DOM via `textContent`, never `innerHTML` with data.
- New app files must be added to `SHELL_FILES` in `sw.js`; bump `SHELL` when caching behaviour changes.
- Every analysis change keeps `npm test` passing and is checked on real clips (`test/real.mjs`); clips of people
  and their landmark files never go in the repo.
- Commits as `34543311+Croway@users.noreply.github.com` (set in this repo); no Claude attribution.
