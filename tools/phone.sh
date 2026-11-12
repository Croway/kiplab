#!/usr/bin/env bash
# Serve the app to the phone as http://localhost:8766 over adb (a secure origin: camera, service worker and
# PWA install all work without HTTPS) and open it in Chrome.
#   tools/phone.sh [device]      e.g. tools/phone.sh 192.168.1.19:45065 (adb connect first for wireless debugging)
set -euo pipefail
cd "$(dirname "$0")/.."
DEV=${1:+-s $1}
[ -d vendor/mediapipe ] || ./tools/fetch-vendor.sh
if ! curl -fs -o /dev/null http://localhost:8766/; then
  echo "starting the dev server on :8766"
  (python3 -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1 &)
  sleep 1
fi
adb $DEV reverse tcp:8766 tcp:8766
adb $DEV shell am start -a android.intent.action.VIEW -d "http://localhost:8766/" com.android.chrome >/dev/null
echo "open on the phone: http://localhost:8766  (Chrome menu → Install app, or the Install button)"
