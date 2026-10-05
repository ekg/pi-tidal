# Scene decks: patterns and SC modulation in one `.tidal`

Scene decks are named `A` through `Z`. Two of those letters form the
**active pair** — the two decks that are actually rendered and crossfaded;
the default pair is `A`/`B`. Every other loaded letter is *parked*: its source
is validated and remembered, but it runs no patterns, no SC nodes and no DSP.
The project has only 12 Dirt orbits (six per rendered pair position), so
letters beyond the pair never allocate audio resources.

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
/tidal scene load C 161.tidal     # parks C: saved, not audible
/tidal scene select C 1           # C takes mix position 1; B parks
/tidal scene restart A
/tidal scene stop B
/tidal scene leave
```

The `tidal_scene` tool exposes the same operations plus `edit` and `status`
(`action: select` takes `deck` and `slot: 0|1`). `mix=0` is the pair's first
position; `mix=1` is its second; intermediate positions use equal-power gains.
Loading a letter that is in the pair (with the default pair, `A` or `B`) makes
it audible exactly as before. Loading any other letter parks it — loading
never silently steals an audible deck. `select deck slot` is the explicit
swap: the deck holding that position is parked first, then the selected deck
is activated into the same position, so two decks never share orbits or
buses, and a failed select rolls the pair back. A deck cannot hold both
positions. To move a pair member to the opposite side, first select another
loaded deck into its old position, parking it; then select it into the new
position. Stopping a deck deletes its record but does not change the pair.

`cycles` is converted to seconds at the current tempo when the fade starts.
A tempo change during that fade does not change its duration. Fade starts when
requested, not on a quantized bar. Both clocks of the current pair keep
advancing while muted — reaching a mix endpoint never stops a clock, and a
muted deck keeps its orbits and effects until it is parked, stopped or left.

### Parked, muted, stopped

* **Parked** (loaded, not in the pair): source snapshot kept, Haskell
  compile-checked at load/edit time, no Tidal streams, no SC context, no
  orbits. Saving its file updates the snapshot without starting it. It comes
  back through `select`, always restarted from local cycle zero.
* **Muted** (in the pair, at the far end of the mix): fully running — clock,
  orbits, effects and mixer are alive; only its mix gain sits at an endpoint.
* **Stopped** (`stop`): record deleted; note/tick streams silenced, sustained
  nodes and modulation freed, orbit chains rebuilt to clear effect tails,
  the slot's mixer reset. Stopping a parked deck frees nothing on the audio
  server because it never owned anything.

Load/restart picks a future quantized shared cycle and rebases both patterns
and SC ticks so that this scene starts at **local cycle zero**. It does not
reset Tidal's shared clock. `quantize` is an integer number of cycles (1–64),
not beats. Start is at least one second ahead to accommodate look-ahead.

Saving a loaded file auto-edits its deck(s) with phase preserved — audible
decks stay audible, parked decks stay parked. Saving an inactive scene does
**not** start it. Use explicit restart to reset the phase. Decks in the active
pair must share one cps; tempo changes require an explicit scene restart, and
you must stop the other pair deck first. A parked deck may keep a different
cps, but it cannot be selected into the pair while the other audible deck
runs at another tempo.

## Routing and ownership

The **pair position** (mix 0 or mix 1) owns the orbits: position 0 owns
physical orbits 0–5, position 1 owns 6–11. Which letter sits at a position
changes with `select`; the six-orbit block itself never moves. Scene files
always use **local** literal `# orbit 0` through `# orbit 5`; the plugin
remaps them onto the owning position's physical orbits. Dynamic orbit
expressions are rejected. Without an explicit orbit, d1–d5 use 0–4 and d6–d16
share orbit 5. There are still 16 logical lanes *per file*, but the plugin stacks
these into independent named Tidal streams (`piScene<letter>`,
`piSceneClock<letter>`) instead of letting one deck's d1
replace the other's d1.

Each rendered deck has its own phase bus, modulation group, controls, mixer,
and wet tail, owned by its pair slot. Both feed the existing master bus when
available (hardware out otherwise).
The final master is shared: **do not modulate global master controls per scene**.
Custom orbit-global SynthDefs must honor SuperDirt's `gate` release protocol
with `doneAction:2`. FX live beside orbit groups, not inside them: merely freeing
an orbit group cannot reclaim ungated effects. If an effect can auto-pause during
release, the project must also reclaim its retired nodes. The runtime calls an
optional captured `~pruneDirtFX` project hook after rebuild/release grace.

Scene mode claims all twelve orbits. Entering it hushes legacy streams once;
parking alone does not — only audible decks claim the orbits, so legacy
eval/edit still works while every loaded deck is parked. Legacy eval/edit and
project-routing reload are blocked while scene mode is active. `leave` frees
both pair slots and all parked records and restores the previous orbit routes;
it does not resume the earlier legacy music automatically.

`stop` silences the deck's note/tick streams, frees sustained nodes and modulation,
and rebuilds its orbit chains to clear effect tails. Hush/panic also leave scene
mode, so scene-owned routines cannot keep running under apparent silence.
A `select` that fails (bad SC, no REPL acknowledgement) rolls back: the pair is
restored and the displaced deck is re-activated, restarted from local zero.

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

Last successfully activated source snapshots — all loaded letters, the active
pair and the mix position — are persisted on the active Pi session branch.
Stack/REPL recovery replays those snapshots—including SC—from local zero:
the two pair decks restart audibly, parked decks are re-committed without
allocating any runtime, and the mix position is restored. Snapshots written
before the A–Z expansion (no pair field) still recover as the default A/B
pair. The pair is restored atomically before checking deck tempos, so swapped
pairs (B/A) and unrelated parked A/B tempos also survive recovery. Recovery does not silently read unsent disk edits, and it cannot
preserve an uninterrupted timeline across a dead audio server.

`tidal_state` reports named streams and tracked deck files; `tidal_scene status`
reports the pair, each loaded letter with origin/epoch, which decks are parked,
and the mix. For real SC state:

```supercollider
~piSceneAPI[\status].value;
```

It prints per-slot context by **deck letter** (e.g. `scene C epoch 4 ...`),
not by slot number.

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
It checks actual Haskell command sequencing for decks A, C and Z (both pair
positions) and that rebased clock events begin at zero. Pure controller
fixtures additionally cover 26 loaded/parked decks without 26 render chains,
pair selection, routing isolation, select rollback, parked stops, shared
tempo and recovery. For this project's twelve-orbit custom dub graph, run the
read-only live check:

```supercollider
this.executeFile("/home/erik/pi-tidal/tests/scenes-live-check.scd");
```

It requires exactly 12 live dub delays/reverbs/monitors, a finite nonzero master,
and reports real deck phases and CPU. It intentionally fails without the
project's custom FX/master meter; it is not a generic stock-SuperDirt test.

Pure controller fixtures cover edits, replacement, errors, routing,
stop/leave, tempo conflicts, and replay. Live audio/CPU/cleanup checks remain
necessary: mocked transport tests cannot establish that an SC graph is healthy.
