#!/usr/bin/env bash
set -euo pipefail
# Create/destroy the `tidal_stream` virtual sink used as the tap for streamd.
#
# Contract (docs/stream-audition.md):
#   - node.name == tidal_stream, media.class Audio/Sink
#   - exposes a monitor capturable by `pw-record --target tidal_stream`
#   - MUST NOT auto-link to any physical output
#
# It mirrors the proven tools/tidal-main-loopback.sh pattern (pw-loopback with a
# capture-side Audio/Sink) but with node.autoconnect=false on both sides and a
# passive, unrouted playback side, so nothing is ever linked to speakers.
#
# Usage: sink-setup.sh create|create-fg|destroy
#   create    : idempotently ensure the sink exists, DETACHED (returns once up)
#   create-fg : same, but foreground and exec'd — for systemd Type=simple
#   destroy   : idempotently remove the sink
#
# NOTE: `create` used to exec pw-loopback, which never returns, so running it
# directly in a shell (or from an agent tool call) blocked forever. `create`
# now detaches into its own session and waits only for the node to appear.
# systemd uses `create-fg`.

CONFIG="${PI_TIDAL_STREAM_CONFIG:-$HOME/.config/tidal-stream/config.json}"

cfg() { # key default
  local key="$1" def="$2" v=""
  if [ -f "$CONFIG" ] && command -v jq >/dev/null 2>&1; then
    v=$(jq -r --arg k "$key" 'if has($k) then (.[$k] | tostring) else empty end' "$CONFIG" 2>/dev/null || true)
  fi
  printf '%s' "${v:-$def}"
}

SINK="${PI_TIDAL_STREAM_SINK:-$(cfg sink tidal_stream)}"
SINK="${SINK:-tidal_stream}"

# pidfile for the detached pw-loopback; destroy falls back to a scoped pgrep
# if it is missing or stale.
PIDFILE="${PI_TIDAL_STREAM_PIDFILE:-${XDG_RUNTIME_DIR:-/tmp}/tidal-stream-${SINK}.pid}"

# capture side = the Audio/Sink apps (scsynth/JACK) play into.
# playback side is passive + autoconnect=false, so it never reaches hardware.
CAPTURE_PROPS="{\"node.name\":\"$SINK\",\"node.description\":\"Tidal Stream tap (virtual)\",\"media.class\":\"Audio/Sink\",\"audio.position\":[\"FL\",\"FR\"],\"priority.session\":1,\"node.autoconnect\":false}"
PLAYBACK_PROPS="{\"node.name\":\"${SINK}_unrouted\",\"node.description\":\"Tidal Stream (not routed to hardware)\",\"media.class\":\"Stream/Output/Audio\",\"audio.position\":[\"FL\",\"FR\"],\"node.passive\":true,\"node.autoconnect\":false,\"stream.dont-remix\":true}"

cmd="${1:-create}"

sink_node_ids() {
  # Emit the PipeWire global ids of any node whose node.name == $SINK.
  if command -v pw-dump >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    pw-dump 2>/dev/null | jq -r --arg n "$SINK" \
      '.[] | select(.type=="PipeWire:Interface:Node" and .info.props["node.name"]==$n) | .id' 2>/dev/null || true
  fi
}

case "$cmd" in
  create)
    if [ -n "$(sink_node_ids)" ]; then
      echo "sink '$SINK' already present"
      exit 0
    fi
    echo "creating sink '$SINK' (detached pw-loopback)"
    # setsid + stdio to /dev/null: detach into a new session, so this script can
    # return and a caller's process-group teardown cannot reap the sink.
    setsid /usr/bin/pw-loopback --name "$SINK" --channels 2 \
      --capture-props "$CAPTURE_PROPS" \
      --playback-props "$PLAYBACK_PROPS" \
      >/dev/null 2>&1 </dev/null &
    for _ in $(seq 1 50); do
      if [ -n "$(sink_node_ids)" ]; then break; fi
      sleep 0.1
    done
    if [ -z "$(sink_node_ids)" ]; then
      echo "error: sink '$SINK' did not appear" >&2
      exit 1
    fi
    pid="$(pgrep -f "^/usr/bin/pw-loopback --name ${SINK} " | head -1 || true)"
    if [ -n "$pid" ]; then printf '%s\n' "$pid" > "$PIDFILE"; fi
    echo "sink '$SINK' present${pid:+ (pid $pid)}"
    ;;

  create-fg)
    if [ -n "$(sink_node_ids)" ]; then
      echo "sink '$SINK' already present"
      exit 0
    fi
    echo "creating sink '$SINK' (foreground; for systemd)"
    exec /usr/bin/pw-loopback --name "$SINK" --channels 2 \
      --capture-props "$CAPTURE_PROPS" \
      --playback-props "$PLAYBACK_PROPS"
    ;;
  destroy)
    # 1) stop the detached pw-loopback via its pidfile, if it is still ours
    if [ -f "$PIDFILE" ]; then
      pid="$(cat "$PIDFILE" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$PIDFILE"
    fi
    # 2) stop a pw-loopback that owns this sink, if any
    if pgrep -f "^/usr/bin/pw-loopback --name ${SINK} " >/dev/null 2>&1; then
      echo "stopping pw-loopback for '$SINK'"
      pkill -f "^/usr/bin/pw-loopback --name ${SINK} " || true
      for _ in $(seq 1 20); do
        pgrep -f "^/usr/bin/pw-loopback --name ${SINK} " >/dev/null 2>&1 || break
        sleep 0.1
      done
    fi
    # 3) destroy any remaining node(s) with this name (e.g. created manually)
    ids="$(sink_node_ids)"
    if [ -n "$ids" ]; then
      echo "destroying lingering node(s): $ids"
      for id in $ids; do
        pw-cli destroy "$id" >/dev/null 2>&1 || true
      done
    fi
    if [ -z "$(sink_node_ids)" ]; then
      echo "sink '$SINK' absent"
    else
      echo "warning: sink '$SINK' still present" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 create|destroy" >&2
    exit 2
    ;;
esac
