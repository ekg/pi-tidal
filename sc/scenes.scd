/* N rendered scene channels, K orbits each (defaults: 2 x 6); decks A..Z map
   onto the channels, never allocate per-letter render chains. Loaded on demand, never at boot.
   Tick synths and note events share SuperDirt's timestamped server bundles.
   The phase bus is extrapolated between 1/16-cycle ticks, not a wall-clock LFO.
   Scene code is a trusted closure |scene|; use scene[\mod] and scene[\own].
   This is ownership/routing, NOT a sandbox for arbitrary SuperCollider code. */
(
var manager, releaseContext, makeContext, acknowledge, pruneRetired;
// Optional project cleanup for global FX that auto-pause before release ends.
pruneRetired = ~pruneDirtFX ? {};
if(~piSceneAPI.notNil) { Error("scene runtime already installed").throw };
manager = (installed: false, active: Array.newClear(2), pending: Array.newClear(2),
    mixes: Array.newClear(2), buses: Array.newClear(2), mix: 0, channelCount: 2, orbitsPerChannel: 6, gains: [1, 0]);
acknowledge = { |token, ok = true, error = ""|
    (token ++ if(ok) { ":ok" } { ":error:" ++ error }).postln;
};
releaseContext = { |context, delay = 0|
    if(context.notNil and: { context[\released] != true }) {
        context[\released] = true;
        context[\owned].do { |item|
            if(item.isKindOf(Routine) or: { item.isKindOf(Task) }) { item.stop } { item.free };
        };
        context[\group].free;
        // Language-side allocator must not recycle a bus until scheduled node
        // frees have actually reached the server. Phase buses may be shared by
        // edit generations; each context owns only its own control bus.
        SystemClock.sched(delay.max(0) + 0.5, {
            context[\controls].free;
            context[\defs].do { |name| s.sendMsg("/d_free", name); SynthDescLib.global.removeAt(name) };
            nil;
        });
    };
};
makeContext = { |slot, epoch, restart|
    var old = manager[\active][slot];
    var phase = if(old.notNil and: { restart.not }) { old[\phase] } { Bus.control(s, 1).set(0) };
    var context = (slot: slot, epoch: epoch, phase: phase, controls: Bus.control(s, 4),
        owned: List.new, defs: List.new, builds: List.new);
    context[\group] = Group.head(manager[\group]);
    context[\clockGroup] = Group.head(context[\group]);
    context[\modGroup] = Group.tail(context[\group]);
    context[\controls].setn([9500, 0.1, 0.08, 1]);
    // Own a node or stoppable routine. Nodes are moved into the scene group.
    context[\own] = { |item|
        if(item.isKindOf(Node)) { item.moveToTail(context[\modGroup]) };
        context[\owned].add(item); item;
    };
    // One control writer per scene: [tone Hz, saturation 0..1, wet 0..1, gain].
    context[\mod] = { |function|
        var name = ("piSceneMod_" ++ slot ++ "_" ++ epoch).asSymbol;
        if(context[\defs].notEmpty) { Error("one scene.mod writer is allowed").throw };
        SynthDef(name, {
            var cycles = In.kr(phase.index, 1);
            var values = function.value(cycles);
            if(values.size != 4) { Error("scene.mod must return [tone, sat, wet, gain]").throw };
            ReplaceOut.kr(context[\controls].index, values);
        }).add;
        context[\defs].add(name);
        context[\builds].add(name);
    };
    context;
};
SynthDef(\piSceneTick, { |phaseBus = 0, phase = 0, rate = 0.3, duration = 0.2|
    ReplaceOut.kr(phaseBus, Line.kr(phase, phase + rate * duration,
        duration.max(ControlDur.ir), doneAction: 2));
}).add;
SynthDef(\piSceneMixer, { |inBus = 0, outBus = 0, controlBus = 0, mix = 0, fadeSeconds = 0.02|
    var controls = In.kr(controlBus, 4);
    var dry = In.ar(inBus, 2);
    var tone = controls[0].clip(100, 20000).lag(0.02);
    var sat = controls[1].clip(0, 1).lag(0.02);
    var wet = controls[2].clip(0, 0.6).lag(0.02);
    var gain = controls[3].clip(0, 2).lag(0.02);
    var level = VarLag.kr(mix.clip(0, 1), fadeSeconds.max(0.001), warp: \lin).sqrt;
    var signal = LPF.ar(dry, tone);
    signal = (signal * (1 + sat * 3)).tanh / (1 + sat);
    signal = signal + (FreeVerb2.ar(signal[0], signal[1], 1, 0.65, 0.6) * wet);
    Out.ar(outBus, signal * gain * level);
}).add;
~piSceneAPI = (
    install: { |token, channelCount = 2, orbitsPerChannel = 6|
        Routine({
            try {
                if(channelCount.inclusivelyBetween(2, 26).not or: { orbitsPerChannel.inclusivelyBetween(1, 16).not }) {
                    Error("invalid scene channel/orbit configuration").throw;
                };
                if(manager[\installed] and: { manager[\channelCount] != channelCount or: { manager[\orbitsPerChannel] != orbitsPerChannel } }) {
                    Error("leave scene mode before changing channel/orbit configuration").throw;
                };
                if(manager[\installed].not) {
                    if(~dirt.orbits.size < (channelCount * orbitsPerChannel)) {
                        Error("scene mixer needs % SuperDirt orbits (% channels x % local orbits); update project startup".format(channelCount * orbitsPerChannel, channelCount, orbitsPerChannel)).throw;
                    };
                    manager[\channelCount] = channelCount; manager[\orbitsPerChannel] = orbitsPerChannel;
                    [\active, \pending, \mixes, \buses].do { |key| manager[key] = Array.newClear(channelCount) };
                    manager[\gains] = Array.fill(channelCount, { |slot| if(slot == 0) { 1 } { 0 } });
                    s.sync;
                    manager[\savedRoutes] = ~dirt.orbits.collect(_.outBus);
                    manager[\output] = if(~masterBus.notNil) { ~masterBus.index } { 0 };
                    manager[\group] = if(~masterBus.notNil) {
                        Group.before(Ndef(\dubMaster).group)
                    } { Group.tail(s.defaultGroup) };
                    manager[\channelCount].do { |slot|
                        var initial = Bus.control(s, 4).setn([9500, 0.1, 0.08, 1]);
                        manager[\buses][slot] = Bus.audio(s, 2);
                        manager[("initial" ++ slot).asSymbol] = initial;
                        manager[\mixes][slot] = Synth.tail(manager[\group], \piSceneMixer,
                            [\inBus, manager[\buses][slot].index, \outBus, manager[\output],
                             \controlBus, initial.index, \mix, manager[\gains][slot]]);
                        manager[\orbitsPerChannel].do { |local|
                            var orbit = ~dirt.orbits[slot * manager[\orbitsPerChannel] + local];
                            orbit.outBus = manager[\buses][slot];
                            orbit.freeSynths;
                        };
                    };
                    // No audio node/gate/effects for ticks; bind sends a dedicated
                    // control synth in the SAME timestamp domain as note events.
                    ~dirt.soundLibrary.addSynth(\piSceneTick, (play: { |event|
                        var slot = ~sceneSlot.asInteger;
                        var epoch = ~sceneEpoch.asInteger;
                        var phase = ~scenePhase;
                        var rate = ~cps;
                        var duration = ~delta;
                        var latency = ~latency;
                        var active, pending, retiredPhase;
                        if(slot.inclusivelyBetween(0, manager[\channelCount] - 1)) {
                            active = manager[\active][slot]; pending = manager[\pending][slot];
                            if(pending.notNil and: { pending[\epoch] == epoch }) {
                                manager[\active][slot] = pending; manager[\pending][slot] = nil;
                                event.bind {
                                    manager[\mixes][slot].set(\controlBus, pending[\controls].index);
                                    releaseContext.value(active, latency);
                                };
                                if(active.notNil and: { active[\phase] !== pending[\phase] }) {
                                    // Capture the OLD bus, not the mutable active
                                    // variable (which becomes pending below).
                                    retiredPhase = active[\phase];
                                    SystemClock.sched(latency + 0.5, { retiredPhase.free; nil });
                                };
                                active = pending;
                            };
                            if(active.notNil and: { active[\epoch] == epoch }) {
                                event.bind {
                                    Synth.tail(active[\clockGroup], \piSceneTick,
                                        [\phaseBus, active[\phase].index, \phase, phase,
                                         \rate, rate, \duration, duration]);
                                };
                            };
                        };
                        true;
                    }));
                    s.sync;
                    manager[\installed] = true;
                    SystemClock.sched(s.latency + 0.5, { pruneRetired.value; nil });
                };
                acknowledge.value(token);
            } { |error| acknowledge.value(token, false, error.errorString) };
        }).play(SystemClock);
    },
    // Keep token in its original position: either version of the controller
    // must work during a plugin reload without restarting the SC process.
    prepare: { |slot, epoch, restart, source, token, deck|
        Routine({
            var function, context, pending, old;
            try {
                if(manager[\installed].not) { Error("scene runtime is not installed").throw };
                // SC 3.13 CHANGED String:compile: it now returns a THUNK that evaluates the
                // string, so `(...).compile` hand back the closure WITHOUT RUNNING IT.
                // `function.value(context)` then returned that closure as a value and the
                // scene's SC block never executed - silently, with a SUCCESS acknowledgement,
                // which made every scene[\mod] body inert (no error, no modulation).
                // String:interpret evaluates the expression and yields the closure itself.
                // Verified on SC 3.13.0: "{ |x| \"ran\".postln }".interpret.value(nil) runs it;
                // the same string .compile.value(nil) returns a Function and runs nothing.
                function = ("{ |scene|\n" ++ source ++ "\n}").interpret;
                if(function.isNil or: { function.isKindOf(Function).not }) {
                    Error("scene SC did not yield a function").throw
                };
                context = makeContext.value(slot, epoch, restart);
                context[\deck] = deck; // logical deck letter, for status only
                function.value(context);
                s.sync;
                context[\builds].do { |name| Synth.tail(context[\modGroup], name) };
                s.sync;
                pending = manager[\pending][slot]; old = manager[\active][slot];
                releaseContext.value(pending);
                if(pending.notNil and: { old.isNil or: { pending[\phase] !== old[\phase] } }) { pending[\phase].free };
                manager[\pending][slot] = context;
                acknowledge.value(token);
            } { |error|
                releaseContext.value(context);
                old = manager[\active][slot];
                if(context.notNil and: { old.isNil or: { context[\phase] !== old[\phase] } }) { context[\phase].free };
                acknowledge.value(token, false, error.errorString);
            };
        }).play(SystemClock);
    },
    mix: { |position, seconds = 0.02|
        manager[\mix] = position.clip(0, 1);
        manager[\gains][0] = 1 - manager[\mix]; manager[\gains][1] = manager[\mix];
        s.bind {
            manager[\mixes][0].set(\fadeSeconds, seconds, \mix, 1 - manager[\mix]);
            manager[\mixes][1].set(\fadeSeconds, seconds, \mix, manager[\mix]);
        };
    },
    // Values are power weights; the mixer applies sqrt, exactly as legacy mix.
    gains: { |values, seconds = 0.02|
        if(values.size != manager[\channelCount] or: { values.any { |gain| gain < 0 or: { gain > 1 } } }) {
            Error("one power weight 0..1 is required per scene channel").throw;
        };
        s.bind {
            values.do { |gain, slot|
                // Do not shorten another channel's in-progress fader movement.
                if(gain != manager[\gains][slot]) {
                    manager[\mixes][slot].set(\fadeSeconds, seconds, \mix, gain);
                };
            };
        };
        manager[\gains] = values.copy;
    },
    cancel: { |slot|
        var pending = manager[\pending][slot], active = manager[\active][slot];
        manager[\pending][slot] = nil;
        releaseContext.value(pending);
        if(pending.notNil and: { active.isNil or: { pending[\phase] !== active[\phase] } }) {
            SystemClock.sched(0.5, { pending[\phase].free; nil });
        };
    },
    stop: { |slot|
        var active = manager[\active][slot], pending = manager[\pending][slot];
        var initial = manager[("initial" ++ slot).asSymbol];
        manager[\active][slot] = nil; manager[\pending][slot] = nil;
        manager[\mixes][slot].set(\controlBus, initial.index);
        releaseContext.value(active); releaseContext.value(pending);
        if(active.notNil) { SystemClock.sched(0.5, { active[\phase].free; nil }) };
        if(pending.notNil and: { active.isNil or: { pending[\phase] !== active[\phase] } }) {
            SystemClock.sched(0.5, { pending[\phase].free; nil });
        };
        // True deck stop: free sustained sample/instrument nodes and FX tails.
        manager[\orbitsPerChannel].do { |i| ~dirt.orbits[slot * manager[\orbitsPerChannel] + i].freeSynths };
        SystemClock.sched(s.latency + 0.5, { pruneRetired.value; nil });
    },
    status: {
        manager[\active].do { |context, slot|
            var name = if(context.notNil and: { context[\deck].notNil })
                { context[\deck] } { "slot" ++ slot };
            if(context.notNil) {
                context[\phase].get { |phase|
                    "scene % epoch % local-cycle %".format(name, context[\epoch], phase).postln;
                };
            } { "scene % inactive".format(name).postln };
        };
        ("scene mix: " ++ manager[\mix] ++ " gains: " ++ manager[\gains]).postln;
    },
    dispose: {
        manager[\channelCount].do { |slot| ~piSceneAPI[\stop].value(slot) };
        if(manager[\installed]) {
            ~dirt.orbits.do { |orbit, i| orbit.outBus = manager[\savedRoutes][i]; orbit.freeSynths };
            SystemClock.sched(s.latency + 0.5, { pruneRetired.value; nil });
            manager[\group].free;
            SystemClock.sched(0.5, {
                manager[\buses].do(_.free);
                manager[\channelCount].do { |slot| manager[("initial" ++ slot).asSymbol].free };
                nil;
            });
        };
        ~piSceneAPI = nil;
    }
);
~piSceneManager = manager; // diagnostics only, not a second control writer
"pi-tidal scene runtime defined".postln;
)
