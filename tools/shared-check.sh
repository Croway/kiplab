#!/usr/bin/env bash
# How Kip Lab's shared files stand against Bar Path's (../barpath, or $BARPATH): identical, adapted (with how many
# changed lines), or extracted. Run it before changing a shared file, and when merging the two apps.
#   tools/shared-check.sh [-v]     (-v: show the diffs of adapted files)
set -uo pipefail
cd "$(dirname "$0")/.."
B=${BARPATH:-../barpath}
[ -d "$B" ] || { echo "Bar Path not found at $B (set BARPATH)"; exit 1; }
verbose=${1:-}
# identical: change them in both apps, or not at all
SAME="js/video.js js/pose.js js/trim.js js/qr.js js/recorder.js tools/render-icons.mjs test/qr.test.mjs .editorconfig .github/workflows/pages.yml"
# adapted: the same file with app-specific changes (see CLAUDE.md, "Shared with Bar Path")
ADAPTED="js/store.js js/share.js js/gallery.js js/overlay.js sw.js manifest.webmanifest tools/phone.sh tools/fetch-vendor.sh .gitignore css/app.css js/app.js index.html"
bad=0
for f in $SAME; do
  if cmp -s "$f" "$B/$f"; then echo "identical  $f"; else echo "DRIFTED    $f (should be identical)"; bad=1; [ -n "$verbose" ] && diff -u "$B/$f" "$f"; fi
done
for f in $ADAPTED; do
  n=$(diff "$B/$f" "$f" | grep -c '^[<>]')
  echo "adapted    $f ($n lines differ)"
  [ -n "$verbose" ] && diff -u "$B/$f" "$f"
done
# extracted: Bar Path has these inline; a merge moves them into these files
echo "extracted  js/signal.js   ← the top of Bar Path's js/analysis.js (median, resample, filtfilt, deriv, argmax, argmin, angle, fmtSigned)"
echo "extracted  js/chartkit.js ← the top of Bar Path's js/charts.js and js/compare.js (tok, ramp, setup, ticks, fmt, dot, label)"
exit $bad
