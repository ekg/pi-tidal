# Scene decks: patterns and SC modulation in one `.tidal`

A scene opts in with a JSON header. SC is inside valid Haskell block comments:

```haskell
-- @scene {"title":"Window Seat","cps":0.30833333333333335,"quantize":1}
{- @sc
scene[\mod].value({ |cycles|
    var movement = (cycles * (2pi / 16)).sin;
    [2600 + movement * 650, 0.12, 0.10, 0.95];
});
-}
d1 $ s "bd ~ bd ~" # orbit 0 # gain 0.5
d6 $ n "<[f4,a4,c5,e5] [e4,g4,b4,d5]>" # s "hoRhodes" # orbit 5
```

`hoRhodes` is a project voice, not a plugin dependency. Use an installed sound
or instrument in your project. The scene mixer itself uses stock SC UGens.

## Play and mix

```
/tidal scene load A 159.tidal
/tidal scene load B 160.tidal
/tidal scene mix 1 4
/tidal scene restart A
/tidal scene stop B
/tidal scene leave
```

The `tidal_scene` tool exposes the same operations plus `edit` and `status`.
`mix=0` is A; `mix=1` is B; intermediate positions use equal-power gains.
`cycles` is converted to seconds at the current tempo when the fade starts.
A tempo change during that fade does not change its duration. Fade starts when
requested, not on a quantized bar. Both scene clocks keep advancing while muted.
Stop an unused deck explicitly; reaching a mix endpoint does not free it.

Load/restart picks a future quantized shared cycle and rebases both patterns
and SC ticks so that this scene starts at **local cycle zero**. It does not
reset Tidal's shared clock. `quantize` is an integer number of cycles (1–64),
not beats. Start is at least one second ahead to accommodate look-ahead.

Saving a loaded file auto-edits its deck(s) with phase preserved. Saving an
inactive scene does **not** start it. Use explicit restart to reset the phase.
Tempo changes require explicit restart, and both decks must have the same cps.
Stop the other deck before changing tempo.

## Routing and ownership

Deck A owns physical orbits 0–5; B owns 6–11. Scene files use **local** literal
`# orbit 0` through `# orbit 5`; the plugin remaps these on B. Dynamic orbit
expressions are rejected. Without an explicit orbit, d1–d5 use 0–4 and d6–d16
share orbit 5. There are still 16 logical lanes *per file*, but the plugin stacks
these into independent named Tidal streams instead of letting one deck's d1
replace the other's d1.

Each deck has its own phase bus, modulation group, controls, mixer, and wet tail.
Both feed the existing master bus when available (hardware out otherwise).
The final master is shared: **do not modulate global master controls per scene**.
Custom orbit-global SynthDefs must honor SuperDirt's `gate` release protocol
with `doneAction:2`. FX live beside orbit groups, not inside them: merely freeing
an orbit group cannot reclaim ungated effects. If an effect can auto-pause during
release, the project must also reclaim its retired nodes. The runtime calls an
optional captured `~pruneDirtFX` project hook after rebuild/release grace.

Scene mode claims all twelve orbits. Entering it hushes legacy streams once.
Legacy eval/edit and project-routing reload are blocked while scene mode is
active. `leave` frees both decks and restores the previous orbit routes; it
does not resume the earlier legacy music automatically.

`stop` silences the deck's note/tick streams, frees sustained nodes and modulation,
and rebuilds its orbit chains to clear effect tails. Hush/panic also leave scene
mode, so scene-owned routines cannot keep running under apparent silence.

## SC API

Multiple `{- @sc ... -}` blocks are combined into one closure with argument
`scene`. They execute before activation. Syntax/runtime failure in setup does
not replace a running scene. There is one `scene[\mod]` writer per deck:

```supercollider
scene[\mod].value({ |cycles| [toneHz, saturation, reverbWet, gain] });
```

`cycles` is a control-rate UGen synchronized by timestamped SuperDirt ticks
at 16 ticks/cycle. It ramps between ticks and follows Tidal tempo; it is not
an independent wall-clock Routine. Phase is held at zero before first activation.
The mixer clamps tone to 100–20000 Hz, saturation to 0–1, wet to 0–0.6, gain to
0–2. Use arithmetic on `cycles` for repeatable motion, rather than free-running
`SinOsc.kr` if its phase must reset with the scene.

For additional nodes/routines, register ownership explicitly:

```supercollider
scene[\own].value(aNodeOrRoutine);
```

Nodes are moved into the scene's modulation group. Routines/Tasks are stopped on
replacement/stop. This is **trusted code, not a sandbox**: an arbitrary `Ndef`,
OSC responder, file write, or unregistered Routine is not automatically owned.
Avoid those in scene blocks. SynthDefs created through `mod` are also retired.

The file parser accepts d1–d16 pattern lanes and simple local `let name = expr`
bindings. Haskell continuations must be indented. Scene headers replace embedded
`setcps`; `hush`, do blocks, and arbitrary top-level IO are not scene statements.

## Recovery and inspection

Last successfully activated source snapshots are persisted on the active Pi
session branch. Stack/REPL recovery replays those snapshots—including SC—from
local zero, preserving mix position. It does not silently read unsent disk edits.
Recovery cannot preserve an uninterrupted timeline across a dead audio server.

`tidal_state` reports named streams and tracked deck files; `tidal_scene status`
reports origin/epoch/mix. For real SC state:

```supercollider
~piSceneAPI[\status].value;
```

Read `sc/boot.log` for DSP self-tests. Read the project's engine log if its
startup installs an engine logging wrapper. Console banners are latched across
stdout fragments, boot logs must be fresh, and a failed startup is not retried
as a second overlapping boot just because one caller timed out.

## Tests

```
node --test tests/*.test.mjs
TIDAL_HASKELL_TESTS=1 node --test tests/repl-command.test.mjs
```

The optional test invokes the installed Tidal library with **no audio boot**.
It checks actual Haskell command sequencing and that rebased clock events begin
at zero. For this project's twelve-orbit custom dub graph, run the read-only live check:

```supercollider
this.executeFile("/home/erik/pi-tidal/tests/scenes-live-check.scd");
```

It requires exactly 12 live dub delays/reverbs/monitors, a finite nonzero master,
and reports real deck phases and CPU. It intentionally fails without the
project's custom FX/master meter; it is not a generic stock-SuperDirt test.

Pure controller fixtures cover edits, replacement, errors, routing,
stop/leave, tempo conflicts, and replay. Live audio/CPU/cleanup checks remain
necessary: mocked transport tests cannot establish that an SC graph is healthy.
