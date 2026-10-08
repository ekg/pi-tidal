# tools/stream — low-latency Tidal audio stream (lane 1)

Implements the *stream* half of `docs/stream-audition.md` (contract v0):

```
scsynth ──► tidal_stream (virtual Audio/Sink, monitor, NOT routed to hardware)
                 │  pw-record --target tidal_stream --format s16 --rate 48000 --channels 2 -
                 ▼
             streamd (Node, no npm deps)  ── WS binary, 20 ms frames, drop-oldest
                 ▼
             browser player.html: AudioWorklet ring buffer + adaptive fill controller
```

## Files

| File | Role |
|---|---|
| `streamd.mjs` | Node daemon: capture, framing, WS broadcast, watchdog, `/status` |
| `stream-ctl` | CLI: `enable\|disable\|start\|stop\|status\|url` |
| `player.html` | self-contained browser player (served at `/` by streamd) |
| `sink-setup.sh` | idempotent `create` (detached, returns once up) / `create-fg` (foreground, for systemd) / `destroy` of the `tidal_stream` sink |
| `../../systemd/tidal-stream-sink.service` | runs `sink-setup.sh create-fg` |
| `../../systemd/tidal-stream.service` | runs `streamd.mjs` |

## Config

`~/.config/tidal-stream/config.json` (missing file = all off). Every field can
be overridden by env `PI_TIDAL_STREAM_<NAME>` (e.g. `PI_TIDAL_STREAM_PORT`),
and the config path by `PI_TIDAL_STREAM_CONFIG`.

```json
{
  "enabled": false,
  "bind": "0.0.0.0",
  "port": 8787,
  "token": "",
  "format": "s16",
  "rate": 48000,
  "channels": 2,
  "frameMs": 20,
  "sink": "tidal_stream",
  "sourceNode": "tidal_stream"
}
```

`enabled:false` ⇒ both units stopped/disabled, nothing created, no port bound.

## Enable / disable

```sh
tools/stream/stream-ctl enable    # write enabled:true, enable --now both units
tools/stream/stream-ctl disable   # stop+disable units, destroy sink, enabled:false
tools/stream/stream-ctl start|stop
tools/stream/stream-ctl status    # parseable status lines
tools/stream/stream-ctl url       # WS URL (+ tailnet hostname, best-effort)
```

`status` prints exactly (parseable, one per line):

```
sink: present|absent
source linked: yes|no
listeners: <n>
frames/sec: <n>
dropped: <n>
source: up|down
```

Schema mirror: each field is `key: value` with a single space, so
`awk -F': ' '$1=="source"{print $2}'` works.

## Outputs

One capture feeds N outputs; each is enabled in config and togglable at
runtime. `ws-pcm` (the browser WS/PCM path) is on by default; `icecast`,
`hls` and `ws-opus` are off by default and cost nothing until enabled (no
process spawned).

```json
{
  "outputs": {
    "ws-pcm": { "enabled": true },
    "icecast": {
      "enabled": false, "host": "127.0.0.1", "port": 8000,
      "mount": "/stream.ogg", "sourceUser": "source",
      "sourcePassword": "hackme", "bitrate": 96
    },
    "hls": {
      "enabled": false, "dir": "/tmp/tidal-stream-hls",
      "segmentMs": 2000, "listSize": 6, "bitrate": 128, "codec": "aac"
    },
    "ws-opus": { "enabled": false, "bitrate": 96 }
  }
}
```

- **icecast** — `icecast.mjs` spawns ffmpeg reading s16le PCM on stdin and
  pushing Ogg/Opus to `icecast://<user>:<pass>@<host>:<port><mount>`. If the
  server is unreachable/refused (ffmpeg exits) or ffmpeg is missing, the error
  shows in `status()` and the output retries on a bounded backoff. A stalled
  server drops frames rather than growing latency (same philosophy as ws-pcm's
  drop-oldest). Listen with `ffplay`:
  `ffplay -i http://<host>:8000/stream.ogg` (VLC: Network → the same URL).
- **hls** — `hls.mjs` spawns ffmpeg writing an fMP4/AAC playlist + segments
  into `dir`, served by streamd at `/hls/index.m3u8` (playlist no-store). It
  also serves a player page at **`/hls.html`** and the vendored hls.js at
  `/hls.min.js`, so a browser needs nothing installed and no internet:

      http://<host>:8787/hls.html           # browser (Chrome/Firefox/Safari)
      ffplay http://<host>:8787/hls/index.m3u8
      vlc    http://<host>:8787/hls/index.m3u8

  Give the player the PLAYLIST, never a bare `.m4s`: an fMP4 segment is not a
  standalone file and needs the `init.mp4` init segment (`#EXT-X-MAP`), so
  probing one fails with "no tfhd was found". Measured in Chrome via hls.js
  1.7.3: playing, 12 segments loaded, 0 errors, **13 s behind live** — that is
  HLS's structural floor (7 buffered 2 s segments), not a defect.
- **ws-opus** — `ws-opus.mjs` spawns ffmpeg reading s16le PCM on stdin and
  writing an Ogg/Opus bitstream to stdout, parses that Ogg bitstream back into
  raw Opus packets, and fans them out over a WebSocket on the daemon's own
  port at path **`/opus`** (ws-pcm keeps `/`). It is the bandwidth-thin path
  for **our** player (~96 kbps vs ~1.5 Mbps for s16le stereo PCM); it is NOT a
  replacement for icecast, which exists for third-party players (VLC, phones)
  that cannot speak this protocol. `bitrate` sets libopus `-b:a` (default 96).
  Same drop-oldest anti-drift rule as ws-pcm (at most 2 packets per
  connection). See *Opus path* below.

Runtime toggle (no restart — the capture and the other outputs keep running):

```sh
tools/stream/stream-ctl output on icecast
tools/stream/stream-ctl output off icecast
tools/stream/stream-ctl output on ws-opus
tools/stream/stream-ctl outputs      # name enabled active listeners dropped bytesOut error
```

`output on|off` drives `POST /control?token=<token>`
`{"output":"<name>","action":"on|off"}` when the daemon is up, and falls
back to editing `config.json` when it is down.

## Wire protocol

One WS message = one frame, 3853 bytes, all integers little-endian:

| offset | type | meaning |
|---|---|---|
| 0 | uint32 | `seq`, monotonic, wraps at 2^32 |
| 4 | float64 | `sentMs` (`Date.now()` at read) |
| 12 | uint8 | `flags`, bit0 = discontinuity |
| 13 | bytes | s16le interleaved stereo, 960 samples/ch = 3840 bytes |

Server queue per connection: **at most 2 frames, drop-oldest**. A slow reader
loses audio, never latency. A 1-byte client ping is answered with a 5-byte
control frame `[0x01, uint32 seq LE]`.

### Opus path (`/opus`, `?codec=opus`)

The `ws-opus` output reuses the same 13-byte header but replaces the PCM
payload with one raw Opus packet, and adds one control message:

| message | bytes | meaning |
|---|---|---|
| CONFIG | `0x02` + raw OpusHead | sent once when a client connects and again whenever ffmpeg (re)starts; the OpusHead is `AudioDecoderConfig.description` for WebCodecs |
| AUDIO | 13-byte header + one Opus packet | same header layout as PCM (`seq` is the output's own packet seq) |
| ping reply | `[0x01, uint32 seq LE]` | unchanged, `seq` is the current packet seq |

Open the player with `?codec=opus` to force the Opus path; otherwise the page
auto-selects Opus when ws-pcm is inactive and ws-opus is active (and falls back
to PCM when the browser has no `AudioDecoder`). The pmode line shows the codec
in use. The Opus path is decoded with WebCodecs (`AudioDecoder`) and converted
to interleaved s16, then fed to the SAME AudioWorklet frame message as PCM, so
the fill controller, jitter estimate, drop-oldest and slow-convergence logic
are reused unchanged.

**Browser caveat:** WebCodecs `AudioDecoder` support for Opus is required
(Chrome/Edge and Safari 16.4+ expose it; Firefox does not as of this writing).
When it is missing the page logs it and uses the PCM path — it never silently
plays nothing.

**How it differs from icecast:** icecast pushes Ogg/Opus to an external Icecast
server for any third-party player (VLC, a phone browser); `ws-opus` speaks our
own WS framing on streamd's port and is consumed by `player.html`. icecast is
for interoperability, ws-opus is for our low-bandwidth player.

### Capture binding (required property)

On this PipeWire/WirePlumber setup, plain `pw-record --target tidal_stream`
links the record stream to the **default source (the mic)**, not the sink
monitor. streamd therefore spawns:

```
pw-record --target tidal_stream --format s16 --rate 48000 --channels 2 \
          -P '{"stream.capture.sink":true}' -
```

`stream.capture.sink=true` makes WirePlumber bind the record stream to the
named sink's monitor ports. streamd additionally (1) waits for the sink node to
exist before spawning, and (2) re-verifies the linkage against `pw-dump` every
2 s, restarting capture if it ever drifts off the sink monitor.

## Tailscale usage

1. Bind: streamd binds `bind` (default `0.0.0.0:8787`).
2. Token: set `"token"` in config; clients must connect to
   `ws://host:8787/?token=<token>`. With an empty token, no auth (tailnet-only).
3. Serve (HTTPS, no client install):

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:8787
   ```

   Then open `https://<host>.<tailnet>.ts.net/?token=<token>`. `stream-ctl url`
   prints the direct WS URL plus the tailnet hostname when available.

## Measuring from the listener

`stream-ctl status` is the SERVER's view: frames/sec, listeners, bytes. It
cannot tell you whether a remote client will glitch, and "the source is pushing
bytes" is not evidence a listener can keep up.

```
node tools/stream/probe.mjs [host] [port] [seconds]
node tools/stream/probe.mjs puppost.tail334fe6.ts.net 8787 60
```

Run it from the machine you will actually listen on. It reports frame rate, lost
frames, jitter, the arrival tail (p95/p99/p99.9/max), and predicts underruns for
several buffer targets by replaying the observed arrivals through the player's
fill policy.

**Reading it:** the exposure is the arrival TAIL, not the average. Measured over
Tailscale from a remote host (~140 ms RTT, direct IPv6): 50 fps, 7.6 ms jitter,
~0 drift — but one 60 s window contained a 450 ms stall, predicting ~4
underruns/min at any target from 60 to 260 ms (a longer target only shortens each
silence gap). A separate 30 s window was clean (max 120 ms), so path quality
varies. A stall longer than the buffer cannot be buffered away without paying
that latency permanently. See `docs/stream-audition.md` field note 10.

## Verification procedure

```sh
# (a) sink exists and is unrouted
./tools/stream/stream-ctl enable        # links units, starts sink + daemon
wpctl status                             # tidal_stream [Audio/Sink] under Filters
pw-link -l | grep tidal_stream_unrouted  # expect: no link to any hardware sink

# (b) known tone -> frames with monotonic seq
#     pw-play is the reliable feeder here; ffmpeg's pulse muxer on this build
#     silently ignores -device and never reaches the virtual sink (see caveats).
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" -ac 2 /tmp/tone.wav -y
node -e 'const s=new WebSocket("ws://127.0.0.1:8787/");s.binaryType="arraybuffer";let n=0,prev=-1,ok=true;s.onmessage=e=>{const q=new DataView(e.data).getUint32(0,true);if(prev>=0&&q!==(prev+1)>>>0)ok=false;prev=q;n++};setTimeout(()=>{console.log("frames",n,"monotonic",ok,"lastSeq",prev);process.exit(0)},4000)' &
sleep 0.6; pw-play --target tidal_stream /tmp/tone.wav

# (c) status
./tools/stream/stream-ctl status         # source: up

# (d) teardown leaves nothing bound
./tools/stream/stream-ctl stop
ss -ltnp | grep 8787                     # expect: empty
wpctl status | grep tidal_stream         # expect: empty
./tools/stream/stream-ctl disable        # stop+disable units, remove sink
```

## Notes / caveats

- The sink is a `pw-loopback` whose playback side is `node.passive` +
  `node.autoconnect=false`, so it never reaches physical output. This mirrors
  `tools/tidal-main-loopback.sh` minus the auto-routing.
- `pw-record --target tidal_stream` requires `stream.capture.sink=true` to
  capture the sink monitor (see above); without it WirePlumber routes to the
  default mic.
- ffmpeg's `-f pulse -device tidal_stream` does **not** reach the virtual sink
  on this build (the option is silently ignored and it plays to the default
  sink). Use `pw-play --target tidal_stream <file>` to feed the tap.
- `systemctl --user disable` removes the symlinked unit files as well as the
  `default.target.wants` links; `stream-ctl enable` re-links them.
- The daemon never exits when the source is down; it reports `source: down`.
