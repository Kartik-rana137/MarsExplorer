#!/usr/bin/env bash
# Install the Android app on a running emulator, start it, and check that the planner inside it answers:
# the site, a plan of the default walk, and the drive mode's elevation grid. Used by .github/workflows/build-apps.yml.
#     bash android/smoke-test.sh path/to/app.apk [output-folder]
set -euo pipefail
APK="$1"
OUT="${2:-smoke}"
PACKAGE=org.marsexplorer.evaplanner
PORT=41801
mkdir -p "$OUT"

adb install -r "$APK"
adb logcat -c
adb shell am start -W -n "$PACKAGE/.MainActivity"
adb forward tcp:$PORT tcp:$PORT

started=""
for _ in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" -o "$OUT/health.json"; then started=1; break; fi
  sleep 3
done
adb logcat -d > "$OUT/logcat.txt" || true
if [ -z "$started" ]; then
  echo "The planner did not start within 5 minutes. Python and app messages from the log:"
  grep -E "python|MarsEVAPlanner|AndroidRuntime|chaquopy" "$OUT/logcat.txt" | tail -120 > "$OUT/errors.txt" || true
  cat "$OUT/errors.txt"
  python3 "$(dirname "$0")/../.github/annotate.py" "Android app on the emulator" "$OUT/errors.txt"
  exit 1
fi
echo "health: $(cat "$OUT/health.json")"

python3 - "$PORT" 2> "$OUT/check-errors.txt" <<'EOF' || { cat "$OUT/check-errors.txt"; python3 "$(dirname "$0")/../.github/annotate.py" "Android app on the emulator" "$OUT/check-errors.txt"; exit 1; }
import json, sys, urllib.request
base = f"http://127.0.0.1:{sys.argv[1]}/"
site = json.load(urllib.request.urlopen(base + "api/site", timeout=60))
camp = {"lat": site["default_camp"]["lat"], "lon": site["default_camp"]["lon"]}
body = json.dumps({"camp": camp, "stops": site["default_stops"]}).encode()
request = urllib.request.Request(base + "api/plan", data=body, headers={"Content-Type": "application/json"})
plan = json.load(urllib.request.urlopen(request, timeout=300))
grid = urllib.request.urlopen(base + site["elevation_grid"]["url"].lstrip("/"), timeout=60).read()
page = urllib.request.urlopen(base, timeout=60).read()
print(f"plan on the phone: {plan['verdict']}, {plan['route']['totals']['dist_m']} m, "
      f"{plan['route']['totals']['eva_min']} min; drive grid {len(grid)} bytes; page {len(page)} bytes")
assert plan["verdict"] in ("go", "marginal", "no-go") and b"Mars EVA Planner" in page and len(grid) > 100_000
EOF

sleep 30  # let the page draw the map before taking a picture of the screen
adb exec-out screencap -p > "$OUT/screen.png"
adb logcat -d > "$OUT/logcat.txt" || true
echo "Android app works: the planner started and planned a walk on the device."
