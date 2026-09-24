# SuperCollider effects, routing and instruments (the DSP layer)

**Status: implemented and verified. 2026-09-24.**

## Feasibility verdict

The question was whether music-grade effects, grouping/routing and a broader
synth repertoire are possible with the current stack, or whether the pi-tidal
plugin needs extending. Answer: **almost all of it works with SuperDirt as-is**,
because SuperDirt was built for exactly this and we simply weren't using it.

| want | mechanism | needs plugin change? |
|------|-----------|----------------------|
| group layers | **orbits** — 12 available, each its own bus + effect chain (`# orbit N`) | no |
| per-group effects | replace/add `GlobalDirtEffect`s on an orbit (we install dub delay + dub reverb) | no |
| master bus + chain | set `orbit.outBus` to an audio bus, post-process with an `Ndef` | no |
| Tidal-reachable FX params | a global effect that ferries event params into control buses | no |
| new instruments | any `SynthDef`; SuperDirt resolves `s "name"` via SynthDescLib | no |
| per-event effects | `~dirt.addModule(\name, ..., test)` | no |
| live-patch the DSP layer | **`tidal_sc` tool** — evaluates SC through sclang's stdin | yes (small, added) |
| VST plugins | needs the `VSTPlugin` UGen (not installed) or JACK → external host | yes (or install) |

Files: `~/livecode/sc/dub_fx.scd` (effects + instruments), `sc/dub_master.scd`
(master bus and chain), `sc/selftest.scd` (boot-time level check),
`sc/init.scd` (installs everything; called from `superdirt_startup.scd`).
`sc/boot.log` records every boot, including measured instrument levels.

## Architecture

```
each orbit:  dryBus ──┬─> dirt_dubdelay (send) ─┐
                      ├─> dirt_dubverb  (send) ─┤
                      └────────────────────────┬─> dirt_masterctl ─> dirt_monitor
                                               │        (params)
                                               v
                            orbit.outBus = ~masterBus
                                               │
                                    Ndef(\dubMaster):
             hpf -> glue comp (ducked by orbit 0 = kick) -> tape saturation
                 -> tone filter -> limiter -> hardware
```

**Orbit convention** (`# orbit N`): 0 drums (dry; kick is the master sidechain) ·
1 bass (dry) · 2 chords (delay + short reverb) · 3 pads (long reverb, wide) ·
4 voices (heavy delay).

**Why the old reverb was mush.** Stock `dirt_reverb` feeds the whole dry signal
into an allpass/lowpass reverb with no high-pass on the send and no pre-delay,
and everything sends to it by default. Every hit's low end piles into one
undamped tail on a shared bus. The replacement (`dirt_dubverb`) HPFs the send at
320 Hz, pre-delays the wet 30 ms so transients stay dry, uses JPverb with a
short *low band* multiplier (`verbLow 0.35`) so bass decays fast, damps the tail,
and is per-orbit so groups can be wet differently. The delay
(`dirt_dubdelay`) filters and saturates its feedback loop, so repeats darken
instead of accumulating, and ducks under new hits (`ddDuck`).

**Tidal params added** (all optional, lagged):
- delay: `ddSend ddLp ddHp ddDrive ddWow ddCross ddDuck` (+ stock `delaytime`,
  `delayfeedback`, `delaySend`, `lock`, `cps` still work)
- reverb: `verbSend verbT60 verbDamp size verbEarly verbHp verbPre verbLow
  verbHigh verbLowcut verbHighcut verbTone verbMod verbWidth` (+ stock `room`)
- master: `mGain mGlue mSat mCut mDuck mHpf mThresh mWidth`
- tape (per-event module): `tape tapeWow tapeHf tapeHiss`
- instruments: `dubchord dubsub tapestab`

## SuperCollider gotchas this work uncovered

1. **`if` cannot take a UGen condition inside a SynthDef.** `if(lock > 0, {a}, {b})`
   fails at build time with *"Non Boolean in test"*. Use `Select.kr(cond, [a, b])`.
2. **Mono `In.ar` / `LocalIn.ar` return a bare UGen, not an array.** Any array
   operation then dies (*"Message 'reverse' not understood ... an OutputProxy"*).
   Normalise with `.asArray` first.
3. **Wait for SynthDefs before playing them.** `.add` sends defs asynchronously;
   installing an effect chain immediately afterwards yields
   *"SynthDef dirt_masterctl2 not found"*. Put `s.sync` between define and play.
4. **Pass bus *indices* to Synth args, not `Bus` objects.** A Bus object silently
   gives a wrong bus index — perfect silence, no error. (SuperDirt passes indices.)
5. **Custom synths take pitch in `n`, not `note`.** With `# note "c4"` our
   instruments were silent; `# n "c4"` works. Stock synths like `superpiano`
   accept both. Samples use `note` for pitch shift (a different mechanism).
6. **Global effect names are suffixed with the channel count** (`dirt_dubverb2`),
   while instruments played via `s "name"` resolve by the bare name — define both.

## Verification

`sc/selftest.scd` runs at boot: it plays each instrument into a private bus,
meters it, and logs the peak. First run: `dubchord=0.2345 dubsub=0.7738
tapestab=0.3622 superpiano=0.4225` — all alive. That check is what proved the
instrument defs were fine and sent the search into the event path (gotcha 5)
instead of the DSP graph.

The master chain is self-verifying in a different way: because every orbit writes
into `~masterBus`, *hearing anything at all* means the chain is in the path.

## Still open

- **VST plugins**: install `VSTPlugin` (Spacechild1) to host VSTs inside scsynth,
  or route via JACK (`jackd`/`pw-jack` are present) to an external host such as
  Carla. The `LadspaUGen` is compiled but `/usr/lib/ladspa` is empty.
- **Untapped native repertoire**: SC3plugins ships MdaUGens (Mda instruments),
  DWGUGens (waveguide strings), Distortion/Betablocker, JoshUGens (vocoder, grain),
  GlitchUGens, ATK ambisonics, Blackrain (MoogFF), DEINDUGens (JPverb, Greyhole,
  DFM1) — a large synth/FX library we have barely touched.
- Greyhole (dub-style modulated delay-verb) is available and would be a good third
  send for "shimmer" once the core setup is familiar.

## Two workflow traps found while wiring this up

7. **Tidal must know every custom parameter.** SuperDirt's "adding effects" recipe
   has three steps and we had done two: define the SynthDef, register the module —
   but not *declare the parameter in Tidal*. Without it an eval dies with
   `Variable not in scope: ddSend` and never reaches the audio server. All the
   params this layer uses are declared in **`livecode/BootTidal.hs`** (the plugin
   prefers a project-local boot file), so they are in scope on every REPL start.

8. **In a ghci script, put each `let` binding on its own line.** A multi-line
   `let` block in `BootTidal.hs` (first binding on the `let` line, the rest
   indented underneath) is parsed as separate commands when loaded via
   `-ghci-script`: the continuations fail, every following binding is dropped,
   and the REPL comes up looking completely healthy while none of the custom
   params exist. Symptom: `Variable not in scope: ddSend`, with no indication
   that the boot file was the problem. One `let x = ...` per line, always.

9. **After restarting the audio stack, restart the Tidal REPL too.** Killing
   sclang/scsynth and letting the plugin respawn them leaves ghci's OSC path
   dead: `tidal_state` still reports streams as active and evals appear to work,
   but no events arrive (`/g_queryTree` shows no new nodes) and there is total
   silence. A direct `/dirt/play` OSC message from outside still makes sound,
   which is how we localised it to Tidal's side. `pkill -x ghci` and the plugin
   respawns a clean REPL on the next eval.

Also learned: with the master gain exposed to Tidal, a stray event could zero the
whole mix (silence, no error). The chain now clamps it (`0.25..2`), and the boot
self-test measures the master chain itself (`synth → ~masterBus → Ndef → bus 0`)
so a dead chain is reported as a number in `sc/boot.log` rather than as mystery
silence.
