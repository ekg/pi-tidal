// Run in an already playing scene via tidal_sc/executeFile. Does not boot,
// restart or change patterns. This validates REAL nodes, not mocked transports.
(
if(s.serverRunning.not) { Error("live check: audio engine is down").throw };
OSCFunc({ |msg|
    var index = 2, counts = IdentityDictionary.new, walk;
    var expected = ~dirt.orbits.size, channels = ~dirt.numChannels;
    walk = {
        var children = msg[index + 1];
        index = index + 2;
        if(children == -1) {
            var name = msg[index].asSymbol;
            counts[name] = (counts[name] ? 0) + 1;
            index = index + 1;
        } { children.do { walk.value } };
    };
    walk.value;
    ["dirt_dubdelay", "dirt_dubverb", "dirt_monitor"].do { |base|
        var name = (base ++ channels).asSymbol, actual = counts[name] ? 0;
        if(actual != expected) {
            Error("live check: % has % nodes, expected %".format(name, actual, expected)).throw;
        };
        "PASS %: % nodes".format(name, actual).postln;
    };
    ~meterBus.getn(3, { |values|
        if(values.every { |value| value.abs < 1e20 }.not) {
            Error("live check: non-finite master output").throw;
        };
        if(values[0] <= 0) { Error("live check: silent master").throw };
        "PASS finite, nonzero master: %".format(values).postln;
    });
    ~piSceneAPI[\status].value;
    "live check CPU avg % peak %, total synths %".format(s.avgCPU, s.peakCPU, s.numSynths).postln;
}, '/g_queryTree.reply', s.addr).oneShot;
s.sendMsg('/g_queryTree', 0, 0);
)

/* REGRESSION CHECK for a real bug found on 2026-10-06 (SC 3.13.0):
   String:compile no longer returns a runnable function of the source - it returns a
   THUNK that evaluates the string, so `(...).compile` gave back the scene closure
   WITHOUT RUNNING IT. prepare then acked SUCCESS while not one line of scene SC ran,
   which silently made every scene[\mod] body inert (162/163/166/167/168).

   This drives the real prepare with a source whose only job is to leave a trace, and
   asserts the trace is there: a scene SC body that does not run cannot pass this.
   Run it in a live session with the scene runtime installed. */
(
var nl = Char.nl.asString;
var src = "scene['defs'].add('LIVE-CHECK-SC-RAN');" ++ nl
    ++ "scene['controls'].set(0, 4321);";
var slot = 3;
"--- scene SC execution check ---".postln;
~piSceneAPI[\prepare].value(slot, 990990, false, src, "livecheck", "D");
SystemClock.sched(1.0, {
    var ctx = ~piSceneManager[\pending][slot] ? ~piSceneManager[\active][slot];
    var defs = ctx !? { |c| c[\defs] };
    var tone = ctx !? { |c| c[\controls].subBus(0).getSynchronous };
    if(defs.isNil or: { defs.includes('LIVE-CHECK-SC-RAN').not }) {
        ("FAIL: scene SC body did NOT run - defs = % (SC 3.13 String:compile thunk bug "
            ++ "is back?)").format(defs).postln;
    } {
        if(tone.round(0.1) == 4321.0) {
            "PASS scene SC body ran and wrote its control bus: defs = %, tone = %".format(defs, tone).postln;
        } {
            ("FAIL: defs present but control bus not written (tone = % - the SC block may "
                ++ "not have run its side effects)").format(tone).postln;
        };
    };
    nil;
});
)
