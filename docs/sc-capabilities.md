# What SuperCollider gives us, and what the plugin should do about it

Written after wiring the DSP layer (`livecode/sc/`) and hitting every friction
point first-hand. Answers three questions: what can we do in SuperCollider, what
is missing in pi-tidal to make it comfortable, and what does *hardcore soundscape*
work actually require.

## 1. What we can do in SC today (installed, on this machine)

Not aspirational — these are the compiled UGens/extensions present in
`/usr/lib/SuperCollider/plugins` and `SC3plugins`:

**Synthesis**
- SuperDirt's own synths (`superpiano`, `superfm`, `supersaw`, `superpwm`,
  `superreese`, `superzow`, `supertron`, `supergong`, `supervibe`, `superchip`,
  `superprimes`, `supercomparator`, `superstatic`, `superwavemechanics`, …)
- **Physical models**: `DWGPlucked`, `DWGBowed`, `Membrane`, `StkInst`/`StkUGens`
  (the whole STK instrument set), `OteyPiano`, `VOSIM`
- **FM/noise/chaos**: `FM7`, `Gendyn`, `DynNoise`, `Chaos`, `PredPrey`,
  `NoiseRing`, `DiodeRingMod`
- **Generative/analysis-driven**: `SCMIR` (music information retrieval),
  `Chromagram`, `KeyClarity`, `PitchDetection`, `OnsetStatistics`,
  `BeatStatistics`, `SensoryDissonance` — i.e. the mix can *listen to itself*

**Soundscape / spatial**
- **ATK** (Ambisonic Toolkit) + `AmbisonicUGens` + `JoshAmbiUGens` + **VBAP** —
  first-order ambisonics, binaural decoding, vector-based panning over arrays
- `PanAz`, `Pan2`/`Pan4`, `BFEncode*` style encoders via ATK

**Time, texture, spectral**
- Reverbs: **JPverb**, **Greyhole** (modulated delay-verb with feedback),
  `ReverbUGens` (FreeVerb/GVerb)
- `LoopBuf` (granular playback), `GrainUGens`, `BhobGrain`, `JoshGrainUGens`
- FFT family: `FFT_UGens`, `PV_ThirdParty`, `JoshPVUGens`, `BhobFFT`,
  `BatPVUgens`, `UnpackFFTUGens`, `MCLDFFTUGens` — spectral freeze, smear, morph
- `BBCut2` — breakbeat cutting engine

**Dynamics, colour, dirt**
- `BetablockerUGens` (compressors/limiters), `SummerUGens`,
  `DistortionUGens`, `MCLDDistortion`, `Blackrain` (MoogFF), `DFM1` (TJUGens),
  `RFWUGens`, `RMEQSuite`

**Hosting other DSP**
- `LadspaUGen` — hosts LADSPA plugins (but `/usr/lib/ladspa` is empty: nothing to
  host yet; Guix/Nix has plenty)
- **VSTPlugin is NOT installed** — this is the one real gap. It is the standard
  way to host VSTs *inside* scsynth; otherwise route out via JACK.
- `jackd` and `pw-jack` **are** installed → scsynth can be patched into other
  processes (Carla/REAPER/Pure Data/Phonon), and their audio into ours

## 2. What is missing in pi-tidal (and what I added)

The plugin could drive Tidal but had **no way to touch SuperCollider at all**,
which is where all of the above lives. Added (they activate on the next pi
reload):

| tool | what it does |
|---|---|
| `tidal_sc` | evaluate SC code in the running sclang (define SynthDefs, patch effects, read state) |
| `tidal_param` | declare SuperDirt parameters in Tidal live (`ddSend:f mSat:f lock:i`) |
| `tidal_repl` | restart the Tidal REPL correctly — its binary is `ghc-9.4.7`, so `pkill -x ghci` silently matches nothing |

**Still missing, in priority order** (not yet written):

1. **`tidal_sc_reload`** — re-execute `sc/init.scd` without restarting the stack.
   Today any SC-side change costs a 60–90 s sclang restart. This is the single
   biggest comfort win: edit the file, reload, hear it.
2. **`tidal_sc_status`** — report SC-side state as text: which orbit has which
   effect chain, bus indices, running Ndefs/Synths, send levels. Right now the
   only way to see the routing is to read `sc/boot.log` after a restart.
3. **Surfacing sclang output** — `tidal_sc` returns a slice of sclang's stdout;
   it should return the *result* of the eval reliably (and SC errors should come
   back as first-class errors, as Tidal's already do).
4. **A convention for SC modules with hot reload** — `sc/*.scd` files plus a
   reload tool; `init.scd` already stages everything and logs to `boot.log`.
5. **Parameter manifest generation** — done: `sc/params.tsv` → `tools/sc_params.py`
   → `BootTidal.hs` + `sc/params_gen.scd`, so a param cannot exist on one side only.
6. **Rebuild the master-control bridge properly** (Tidal `m*` → SC): a plain
   `Synth` reading a control bus and writing `Ndef` controls, *not* a bus index
   baked into the Ndef's function. Currently `m*` is declared but inert.

## 3. What hardcore soundscape work needs (the routing layer)

A single master bus is one knob. A mixing desk has structure — and that is what
`sc/routing.scd` implements (loaded, opt-in via `~routingEnabled`):

```
orbit (source) -> GROUP bus -> group strip (hpf, comp, gain) -> master
                      |                     |
                      |                     +-> aux sends: delay / verb / shimmer
                      |                                       |
                      |                                       +-> returns -> master
                      +-> sidechain bus (kick) ducks the returns and the master
```

- **Groups**: `drums bass music fx` — move any orbit at runtime:
  `~route.orbit(2, \music)`
- **Aux sends per group**, post-fader, levels on control buses:
  `~route.send(\music, \delay, 0.6)`
- **Aux returns**: `delay` (greyhole-style filtered feedback, darkening repeats),
  `verb` (JPverb with fast low-band decay — the anti-mush setting), `shimmer`
  (Greyhole, modulated, long feedback → evolving tails)
- **Sidechain**: orbit 0 (kick) drives ducking of the returns and the master, so
  the mix breathes instead of piling up
- **Feedback network**: the shower's `LocalOut`/`Greyhole` loops are where
  "environment" comes from — filtered, saturated, never accumulating

**Next steps in that direction**, in the order I would do them:

1. Get `~routingEnabled` verified end to end (its start stage hung the boot once —
   `this` inside a Function is not the enclosing Event; now rewritten with an
   explicit map, but unverified).
2. **Spatial send**: encode the music group through ATK (FOA) and decode to
   binaural, so orbits can be placed in a room rather than panned L/R.
3. **Adaptive soundscape**: use `Chromagram`/`PitchDetection`/`Loudness` on the
   master bus to modulate send levels and filter cutoffs — the system reacting to
   its own material.
4. **Spectral treatments** on the shimmer path (`PV_Freeze`, `PV_Smear`) for
   sustained environments.
5. **Interface with Phonon** (see below) over JACK/PipeWire.

## 4. Phonon (`~/phonon`) — the other engine

Phonon is a **Rust livecoding system where patterns are signals**, with its own
pattern language (`.ph` files), SuperDirt-compatible synth names, sub-millisecond
latency, live reload on save, and WAV rendering. It is built
(`target/release/phonon`) and is *not* SuperCollider-based (its engine is cpal).

Consequences for "hardcore soundscape/routing":

- **Two viable engines, different strengths.** SC: huge DSP library, ambisonics,
  spectral tools, mature routing. Phonon: tighter latency, patterns-as-signals,
  everything modulatable by patterns, Rust code we can extend directly.
- **They can be patched together**: both can open JACK/PipeWire ports, so SC
  output can feed Phonon (or vice versa) for cross-engine processing.
- Phonon is **WG-managed** (`AGENTS.md`, work-graph tasks) but the WG store is not
  initialised on this machine (`wg` reports "not initialized"), so its task
  workflow is not active here.

The open question worth answering before building much more: **which engine is
the soundscape's home** — SC (rich, and now wired into our livecoding loop) or
Phonon (fast, ours to modify, but a smaller DSP world) — or both, patched through
JACK. I would keep SC as the live instrument (it is where the routing work has
gone) and treat Phonon as a source/processor on the JACK graph, unless you want
the soundscape itself built in Rust.
