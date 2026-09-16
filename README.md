# pi-tidal

Agent-driven live coding with [TidalCycles](https://tidalcycles.org) inside [pi](https://github.com/earendil-works/pi-coding-agent).

You talk to the agent in one line of musical direction — *"darker"*, *"drop the hats"*, *"bass in 8 bars"* — and the agent writes the patterns, saves them, and they start playing. You never touch an editor unless you want to. The agent can't hear; you're the ears.

## The loop

```
you: "more like 25.tidal but half speed"
agent: edits .tidal chunk  →  save  →  chunk auto-evaluates  →  sound changes
       ↑                                                        |
       └────── [tidal] error messages flow back automatically ──┘
```

- **Auto-eval**: `write`/`edit` on `*.tidal` files sends the changed chunk (blank-line separated blocks — the standard Tidal file convention) straight to the running GHCi REPL, wrapped in `:{ :}` so multi-line `do` blocks always parse.
- **Error feedback**: REPL compile errors (`parse error`, `Variable not in scope`, …) are injected into the agent's context as `[tidal]` messages, so the agent fixes its own mistakes mid-session.
- **Tools** the agent can call: `tidal_eval` (fire ad-hoc chunks), `tidal_hush` (emergency stop), `tidal_status` (synth count via OSC `/status`).
- **`/tidal` command** for the human: `status | hush | restart`.
- **Self-healing stack**: a watchdog revives SuperDirt if the audio server dies and re-fires the recent chunks so the music resumes. On suspend-capable machines the sclang process runs under `systemd-inhibit` (block mode) so suspend can't kill audio mid-set.
- **`/jam` prompt template**: one command that boots the stack and puts the agent into "expecting musical direction" mode.

## Install

### 1. Prerequisites (once per machine)

- [pi](https://github.com/earendil-works/pi-coding-agent)
- **SuperCollider** (>= 3.13) with the **SuperDirt** quark installed, and a SuperDirt startup file (see step 3)
- **GHC + cabal**, then the Tidal library:

  ```bash
  cabal update && cabal install tidal --lib
  ```

- Linux with PipeWire is the tested path (see [Troubleshooting](#troubleshooting) for why). macOS should mostly work; the PipeWire-specific workarounds are skipped automatically there.

### 2. Install the package

```bash
pi install git:github.com/ekg/pi-tidal
```

(or `pi -e git:github.com/ekg/pi-tidal` to try it without installing).

### 3. SuperDirt startup file

The extension spawns a bare `sclang`, which loads `~/.config/SuperCollider/startup.scd`. Put the bundled fixed startup there:

```bash
mkdir -p ~/.config/SuperCollider
cp <package-dir>/sc/superdirt_startup.scd ~/.config/SuperCollider/startup.scd
```

(If you already have a startup file that boots SuperDirt, you can keep it — but the bundled one includes two fixes worth having: `waitForBoot` instead of `s.reboot` — which can double-boot and kill the server — and `useSystemClock = false`, which avoids scsynth exits under PipeWire.)

It loads sample banks from `~/sounds/*` if present; edit the paths to your own library. The default Dirt-Samples are always loaded.

### 4. Per-project files

Nothing is required in your music repo. If `BootTidal.hs` exists in the project it is used; otherwise the copy bundled with the package is used. `.tidal` files just need to follow the chunk convention: **patterns separated by blank lines, no empty lines inside a `do` block**.

## Usage

```bash
cd ~/my-music-repo
pi
/jam dark dnb 170      # boots the stack (~1-2 min first boot: samples load), then take direction
```

or just talk normally and the stack boots lazily on the first Tidal action. `hush` stops everything; say "stop" and the agent will send it.

## Troubleshooting (field notes)

Everything below was hit in production on a Framework laptop, Ubuntu 24.04, PipeWire 1.0.5, SC 3.13.0, tidal 1.10.1.

- **scsynth SIGABRT at boot** — scsynth links `libjack.so.0` from jackd2, which auto-spawns a `jackd` that fights PipeWire for the ALSA device (`hw:0`). The extension points `LD_LIBRARY_PATH` at PipeWire's own libjack (`/usr/lib/x86_64-linux-gnu/pipewire-0.3/jack`) when that directory exists. Symptom in the wild: `jackdmp ... ALSA: Cannot open PCM device alsa_pcm` right before the abort.
- **`Server 'localhost' exited with exit code 0`** — a *clean* scsynth exit with no `/quit` received. On this setup the common cause is a **suspend/resume cycle**: PipeWire drops the JACK client on resume and scsynth exits(0). Mitigations: `systemd-inhibit` around sclang (built in), and the watchdog revives the stack + re-fires recent chunks.
- **scsynth silent to UDP for 30–90s after spawn** — while sclang churns through class compile + ~450MB of sample reads, scsynth's stdout pipe backs up into the busy interpreter and its network replies stall. Don't health-check the server with OSC during that window; watch sclang's own post output (`SuperDirt: listening on port 57120`) instead — that's what the extension does.
- **`Could not open UDP port 57120`** — another sclang process is still alive and holding the language/SuperDirt port. `pkill -x sclang; pkill -x scsynth` and retry. The extension does this before spawning.
- **Ambiguous module `Sound.Tidal.Context`** — two copies of the same tidal version registered in the cabal store (e.g. after a reinstall without cleanup). Remove the stale `.conf` from `~/.cabal/store/ghc-*/package.db/` and fix `~/.ghc/*/environments/default`.
- **`s.reboot` in a startup file** — on a fresh sclang the server is never booted, and `s.reboot` can produce a boot race that cleanly kills the freshly booted server. Use `s.waitForBoot`.
- **GHCi output is chunk-fragmented over pipes** — never match boot banners per `data` event; use a rolling buffer (the extension does).

## Layout

```
extensions/tidal.ts   the pi extension (one file, ~400 lines, stdlib only)
prompts/jam.md        /jam session starter
BootTidal.hs          Tidal REPL boot script (bundled fallback)
sc/superdirt_startup.scd  battle-tested SuperDirt boot (waitForBoot, no s.reboot)
```

## License

MIT
