#!/usr/bin/env bash
set -uo pipefail
# selftest.sh — runnable lane-3 check for the audition job protocol.
#
# Boots nothing: it requires a running audition stack (`audition-ctl start`).
# It then (1) submits a real scene, waits for done, and asserts every frozen
# report field is present with sane shapes; (2) submits a deliberately broken
# scene and asserts it ends ok:false / state failed rather than stuck running;
# (3) prints `jobs`; (4) proves no audition job touched the live stack by
# checking the live sc log mtimes are unchanged across the run.
#
#   usage: tools/audition/selftest.sh [scene.tidal]
#   exit 0 = all checks passed; 1 = a check failed; 2 = stack not running.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTL="$HERE/audition-ctl"
SCENE="${1:-/home/erik/livecode/159.tidal}"
# a bare filename is resolved against the repo root, not the caller's cwd
if [ ! -f "$SCENE" ] && [ -f "/home/erik/livecode/$SCENE" ]; then SCENE="/home/erik/livecode/$SCENE"; fi
LIVE_SC="/home/erik/livecode/sc"
pass=0; fail=0
ok()   { printf 'PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf 'FAIL  %s\n' "$*"; fail=$((fail+1)); }

status_out="$("$CTL" status 2>&1)"
case "$status_out" in
  *'scsynth: up'*) ;;
  *) echo "SKIP: audition stack not running — run 'audition-ctl start'"; exit 2 ;;
esac

# Live-stack log baseline (must be untouched by any audition job).
# master-meter.log is deliberately EXCLUDED: the live stack's own ceiling meter
# rewrites it every 2s while it runs, so its mtime proves nothing either way.
# Including it made this check flaky - it passed only when the live stack was
# idle. (Verified: with no audition job running the file still grows ~165 B/6s.)
LIVE_LOGS="$LIVE_SC/boot.log $LIVE_SC/engine.log $LIVE_SC/spectrum.log $LIVE_SC/ctl.log $LIVE_SC/state.scd"
before="$(stat -c '%n %Y %s' $LIVE_LOGS 2>/dev/null)"

# poll a job to a terminal state (report exits 0) with a timeout
wait_terminal() { # <id> <timeout_s>
  local id="$1" limit="${2:-90}" i=0
  while [ "$i" -lt "$limit" ]; do
    if "$CTL" report "$id" >/tmp/selftest-report.json 2>/dev/null; then return 0; fi
    sleep 2; i=$((i+2))
  done
  return 1
}
field() { python3 -c "import json,sys; r=json.load(open('/tmp/selftest-report.json')); print(r$1)" 2>/dev/null; }

echo "=== 1. real scene report ==="
id="$("$CTL" submit "$SCENE" --slot 0 --cycles 4)"
[ -n "$id" ] && ok "submit printed a job id ($id)" || bad "submit printed no id"
if wait_terminal "$id" 120; then ok "job reached a terminal report"; else bad "job did not finish"; fi
[ "$(field "['ok']")" = "True" ] && ok "ok=true" || bad "ok is not true: $(field "['error']")"
miss=""
for f in id ok error state startedMs finishedMs cps slot renderCycles withLive \
         master bands dominantHz chroma key dissonance decks diffVsLive; do
  python3 -c "import json; r=json.load(open('/tmp/selftest-report.json')); assert '$f' in r" 2>/dev/null || miss="$miss $f"
done
[ -z "$miss" ] && ok "all frozen report fields present" || bad "missing fields:$miss"
python3 - <<'PY' && ok "bands/chroma/decks shapes are sane" || bad "bands/chroma/decks shapes are wrong"
import json
r=json.load(open('/tmp/selftest-report.json'))
b=r['bands']; assert abs(sum(b.values())-1.0) < 1e-3, b
assert len(r['chroma'])==12 and abs(sum(r['chroma'])-1.0) < 1e-3
assert isinstance(r['key'], str) and ' ' in r['key']
assert isinstance(r['decks'], list) and r['decks'] and r['decks'][0]['slot']==r['slot']
for d in r['decks']: assert abs(sum(d['bands'].values())-1.0) < 1e-3
assert 'available' in r['diffVsLive']
PY

echo "=== 2. broken scene ==="
broken="$(mktemp /tmp/audition-broken-XXXX.tidal)"
printf '%s\n' '-- @scene {"cps":0.5}' 'd1 $ this is not valid haskell ++++' > "$broken"
bid="$("$CTL" submit "$broken" --slot 0 --cycles 4)"
if wait_terminal "$bid" 90; then ok "broken scene reached a terminal report"; else bad "broken scene stuck"; fi
[ "$(field "['ok']")" = "False" ] && ok "broken scene ok=false" || bad "broken scene ok is not false"
[ "$(field "['state']")" = "failed" ] && ok "broken scene state=failed" || bad "broken scene state not failed"
[ -n "$(field "['error']")" ] && ok "broken scene carries an error message" || bad "broken scene has no error"
rm -f "$broken"

echo "=== 3. non-zero channel slot measures signal ==="
# The scene mixer installs with gains [1,0,...]. If the runner does not raise the
# slot under test, slots 1+ render into a MUTED channel and the job reports
# all-zero metrics as ok:true - a false "this deck is silent" verdict. Testing
# only slot 0 hid that; audit into a real destination slot here.
sid="$("$CTL" submit "$SCENE" --slot 1 --cycles 4)"
if wait_terminal "$sid" 180; then ok "slot-1 job reached a terminal report"; else bad "slot-1 job did not finish"; fi
s1="$(python3 -c "import json;r=json.load(open('/tmp/selftest-report.json'));b=r['bands'];print('measured' if abs(sum(b.values())-1.0)<1e-3 else 'silent')" 2>/dev/null)"
[ "$s1" = "measured" ] && ok "slot 1 measured real bands" || bad "slot 1 measured NO signal (bands do not sum to 1) - the slot gain was never raised"

# a second job that also proved the live snapshot is consulted
python3 -c "import json;r=json.load(open('/tmp/selftest-report.json'));assert 'available' in r['diffVsLive']" 2>/dev/null && ok "slot-1 report carries diffVsLive" || bad "slot-1 report has no diffVsLive"

echo "=== 4. jobs ==="
"$CTL" jobs --limit 5

echo "=== 5. live stack untouched ==="
after="$(stat -c '%n %Y %s' $LIVE_LOGS 2>/dev/null)"
[ "$before" = "$after" ] && ok "live boot/engine/spectrum/ctl/state unchanged" || bad "live sc files changed: $before -> $after"
# Positive check: the audition wrote its OWN private graph log instead.
if [ -s "/home/erik/livecode/sc/audition/boot.log" ]; then ok "audition wrote its own private graph log"; else bad "audition private graph log missing/empty"; fi

echo
echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
