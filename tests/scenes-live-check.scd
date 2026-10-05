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
