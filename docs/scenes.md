# Scene decks: patterns and SC modulation in one `.tidal`

Scene decks are named `A` through `Z`. **N channels** hold the rendered decks;
**N defaults to 2**, the backward-compatible A/B **active pair**. Each channel
owns K local orbits (**K defaults to 6**). Every other loaded letter is *parked*:
its source is validated and remembered, but runs no patterns, SC nodes or DSP.
Letters never allocate render chains: at most N decks render, however many are
loaded. The default project needs 12 Dirt orbits, exactly as before.

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
requested, not on a quantized bar. Both deck-local phases follow the global clock
while muted — reaching a mix endpoint never stops a clock, and a
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
**not** start it. Use explicit restart to reset the phase. Decks in active channels share ONE global clock and effective cps. Outside an
explicit `morph`, changing declared cps requires a restart and stopping the other
active decks first. A parked deck may keep a different declared cps, but cannot
be selected while another active channel runs at an incompatible effective tempo.

## N-channel configuration and faders

Set `PI_TIDAL_SCENE_CHANNELS=2..26` and `PI_TIDAL_SCENE_ORBITS=1..16` before
loading the extension; defaults are **2** and **6**. A project can declare the
same geometry in `sc/scene-mixer.json` (`{"channels":4,"orbits":6}`), which is
read from the project directory when the environment is unset — that is the
recommended way here, because the value must equal the orbit list SuperDirt is
given at boot (`~dirt.start(57120, 0 ! (channels * orbits))`). The plugin
refuses to install the mixer when the running server has fewer orbits than the
configuration claims, instead of silently mis-routing notes past the end of the
list. Extra orbits add per-orbit global FX (three synths each), so 4 x 6 = 24
orbits is already 72 FX nodes.

Channels initially hold
A, B, C, ... up to N letters, even when unloaded. Initial power weights are
`[1, 0, ...]`. Loading any assigned letter activates it; other letters park.
`select` keeps its legacy `slot` parameter, now an integer `0..N-1`.

With N=3, K=6 (requires 18 project orbits):

```
/tidal scene load C 161.tidal
/tidal scene gain 2 0.25 2       # channel 2, power weight, seconds
/tidal scene select Z 2         # requires a loaded Z; parks C
```

The tool uses `{action:"gain", channel:2, gain:0.25, seconds:2}`. Weights are
0..1; actual mixer amplitude is **sqrt(weight)**, so 0.25 means half amplitude.
Legacy `mix x cycles` still sets channels 0/1 to `[1-x, x]`, leaving other
channels alone. This is precisely the existing equal-power crossfade, not a
new fade law. Independent faders are not normalized; many open channels can
clip the shared master. Muting never stops phase or frees resources.

SC installs exactly N buses/mixers and N context slots. Its install signature
is `install(token, channelCount=2, orbitsPerChannel=6)`; configuration arguments
are appended, **not inserted before token**. `prepare(slot, epoch, restart,
source, token, deck)` is unchanged: token remains argument five. Default A/B
commands and snapshot shape stay unchanged. Old controller/new runtime and new
controller/old runtime retain default A/B compatibility. Configurable channels
and new faders need the new runtime; an old runtime is explicitly rejected for
nondefault configuration. Leave scene mode and load the updated runtime, rather
than restarting a live interpreter merely for a plugin reload.

### Project startup proposal (not applied)

The plugin cannot create extra Dirt orbits after startup. The installed
SuperDirt constructor is **`SuperDirt(numChannels, server)`**, not
`SuperDirt(numOrbits, numChannels)`: keep `SuperDirt(2, s)`. Its `start` output-bus
list determines orbit count. In `/home/erik/livecode/superdirt_startup.scd`, the
parent must expand today's `~dirt.start(57120, 0 ! 12)` output list to **N*K**
entries, preserving the project's `0` bus convention. For 3 channels x 6 orbits,
that means 18 entries. No project startup file was edited for this change.

Plugin configuration and startup must agree; installation checks
`~dirt.orbits.size >= N*K` and errors with the required count before routing.
Extra existing orbits are not claimed; only the first N*K belong to scene mode.
The default N=2,K=6 still requires the same 12-orbit output list. Each orbit adds
its own global FX instances (`name ++ numChannels`, including dub delay/reverb/
monitor); these are siblings of orbit groups, not reclaimed by group-free alone.
More channels add buses, mixers and modulation plus **K more FX chains per
channel**. Keep N modest; above 6 channels the extension emits a loud CPU warning.
Changing these settings on an installed scene runtime requires leaving scene
mode first. Changes to Dirt startup itself require a separately authorized
project restart; do not attempt that during an ordinary scene action.

## Tempo-riding transition

```
/tidal scene morph 0 1 0.4 8     # source, destination, target cps, wall seconds
/tidal scene cancel
```

Tool: `{action:"morph", from:0, to:1, toCps:0.4, seconds:8, stepHz:4}`.
Both channels must be loaded and distinct. CPS must be >0..4, duration >0..300
seconds, and stepHz 1..10 (default 4). The action returns immediately; `status`
reports running/completed/cancelled/failed. Starting another ride supersedes it.

Tidal has **one clock**, and `setcps = once . cps` does **not** ramp. The controller
samples `getcps` first, then schedules a bounded linear sequence of `setcps`
steps over wall time, acknowledging each REPL write and SC gain request. From
0.3 to 0.6 cps over 1 second at 4 Hz: 0.375, 0.45, 0.525, 0.6. Every rendered
channel follows that tempo, including muted ones. No origin, setCycle, scene
pattern or phase bus is reset. This is a deliberate global-tempo action, never
a side effect of moving a normal fader.

The source power weight falls from its current value to zero; destination rises
from its current weight to one. Other channels retain their weights. For the
standard `[1,0]` endpoints this is the same equal-power law as `mix`. SC smooths
each target over 20ms. This is a stepped transition, not an independent,
sample-accurate pair of clocks; an already-open destination need not conserve
pair power throughout the ride.

Each step and cancellation run on the same scene lifecycle queue. Only one
timer exists at a time. `cancel`, mix/gain, load/edit/restart, select, stop,
leave and transport reset invalidate the ride; queued stale callbacks do nothing.
Cancel keeps the last acknowledged cps and gain **targets** (SC may still be
settling to them), frees the timer and reports those targets. On mid-ride error,
the controller attempts to restore both transports to those targets and reports
failure. If rollback cannot be acknowledged, status explicitly says **transport
state unconfirmed; recovery required**; stored targets remain the last good
ones, not a false claim of audible state. Shutdown also cancels the scheduler.

Look-ahead and repeated clock mutations can produce **Tidal scheduling jitter**
(including events scheduled earlier in the normal stream), and transport latency
can desynchronize gain/tempo changes. Rates are capped at 10 Hz and never burst
to catch up: slow acknowledgements can extend the requested duration. The exact
sequence is bounded by max(1, floor(seconds*stepHz)) steps. No audible smoothness
or SC graph health has been proven by offline tests.

A separate **effective tempo override** is persisted after a ride, including
cancellation/failure; `.tidal` headers and source snapshots are never rewritten.
Status distinguishes declared cps from effective cps. Unchanged edits/restarts
with other active channels retain the override; newly loaded/selected source
must match effective tempo. Recovery replays the override, not the old header
tempo, from local zero; it does not resume a partially completed ride. A lone
explicit load/restart may legitimately set its declared tempo and clear the
override; `leave` clears it without changing the current Tidal tempo.

## Routing and ownership

The **channel index** owns its fixed orbit block: physical orbit = channel*K
+ local orbit. By default position 0 owns 0–5, position 1 owns 6–11. Which letter
sits there changes with `select`; the block never moves. Scene files always use
**local** literal `# orbit 0` through `# orbit (K-1)` (write the actual integer,
not an expression); the plugin remaps to physical orbits. Dynamic orbit
expressions are rejected. Default d1–d5 use 0–4 and d6–d16 share orbit 5; with
custom K, the default lane orbit is min(lane-1, K-1). There are still 16 logical lanes *per file*, but the plugin stacks
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

Scene mode claims the first N*K orbits (twelve by default). Entering it hushes legacy streams once;
parking alone does not — only audible decks claim the orbits, so legacy
eval/edit still works while every loaded deck is parked. Legacy eval/edit and
project-routing reload are blocked while scene mode is active. `leave` frees
all channel slots and parked records and restores the previous orbit routes;
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
channels, gain vector, effective tempo override and legacy pair/mix position — are persisted on the active Pi session branch.
Stack/REPL recovery replays those snapshots—including SC—from local zero:
the channel decks restart with their saved gains, parked decks are re-committed without
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
positions and a third channel with K=3), rebased clock events beginning at zero,
and generated setcps steps against the installed Tidal types. Its tempo test
never instantiates a Stream; `once` only queries patterns offline. Pure controller
fixtures additionally cover 26 loaded/parked decks without 26 render chains,
pair/N-channel selection, K-block routing, select rollback, parked stops,
shared effective tempo, ride sequence/cancellation/failure and snapshot recovery. For this project's twelve-orbit custom dub graph, run the
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
Fade continuity at channel handover (especially sustained nodes and FX tails),
Tidal cps-step scheduling jitter and per-orbit FX CPU growth remain unverified.
