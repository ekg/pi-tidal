import fs from 'node:fs';
import path from 'node:path';

// Injected transports let the same lifecycle run against real SC/GHCi or a
// deterministic fixture. No subprocesses or timers are started by this module.
// Decks A..Z are logical: only the two decks in the active pair get Tidal
// streams, an SC context and the six orbits of their pair position. Loading
// any other letter parks it (source kept, Haskell checked, no DSP).
export function createSceneController({ registry, runtimePath, ensure, ready,
  writeRepl, queryRepl, sc, hush, label, deckIndex, deckSlot, patternExpression, sceneCommands, stopCommands }) {
  let runtimeReady = false;
  let tempoSet = false; // this REPL has received setcps for the loaded scene tempo
  async function install() {
    if (runtimeReady) return;
    hush();
    await sc(token => `if(~piSceneAPI.isNil) { this.executeFile(${JSON.stringify(runtimePath)}) }; if(~piSceneAPI.isNil) { Error("scene runtime failed to compile").throw }; ~piSceneAPI[\\install].value(${token})`, true);
    runtimeReady = true;
  }
  async function compileCheck(record, pair) {
    const candidate = `piSceneCandidate${record.deck}${record.epoch}`;
    writeRepl(`let ${candidate} = ${patternExpression(record.scene, record.deck, pair)}`);
    const checked = await queryRepl([`print (length (queryArc ${candidate} (Arc 0 1)))`]);
    if (!/^\d+$/.test(checked.trim())) throw Error(`Tidal scene did not compile: ${checked}`);
  }
  async function activate(record, { check = true } = {}) {
    const { deck, scene, epoch, restart } = record;
    if (!registry.pair.includes(deck)) {
      // Parked deck: commit the validated source, claim no orbits or runtime.
      if (check) await compileCheck(record, [deck, deck === 'A' ? 'B' : 'A']);
      registry.commit(record);
      label(`${path.basename(record.file)} deck ${deck} parked; not audible until selected into the pair`);
      return record;
    }
    const slot = deckSlot(deck, registry.pair);
    if (check) await compileCheck(record, registry.pair);
    await install();
    await sc(token => `~piSceneAPI[\\prepare].value(${slot}, ${epoch}, ${restart ? 'true' : 'false'}, ${JSON.stringify(scene.sc)}, ${token}, ${JSON.stringify(deck)})`, true);
    const previous = registry.get(deck);
    try {
      const partner = registry.entries().some(([other]) => other !== deck && registry.pair.includes(other));
      // Parked decks loaded first must not leave the REPL on its boot tempo.
      if (!tempoSet || !partner) writeRepl(`setcps ${scene.cps}`);
      tempoSet = true;
      const commands = sceneCommands(scene, deck, epoch, { restart, pair: registry.pair });
      if (restart) writeRepl(commands.shift());
      const reply = await queryRepl([...commands, `print (fromRational piSceneOrigin${deck} :: Double)`]);
      if (!/^\d+(?:\.\d+)?$/.test(reply.trim())) throw Error(`Scene activation was not acknowledged: ${reply}`);
      record.origin = Number(reply.trim());
      registry.commit(record);
      label(`${path.basename(record.file)} deck ${deck} ${restart ? 'restart' : 'edit'}; origin ${record.origin}`);
    } catch (error) {
      await sc(() => `~piSceneAPI[\\cancel].value(${slot})`);
      if (previous) {
        writeRepl(`let piSceneOrigin${deck} = ${previous.origin} :: Rational`);
        for (const command of sceneCommands(previous.scene, deck, previous.epoch, { restart: false, pair: registry.pair })) writeRepl(command);
      } else for (const command of stopCommands(deck)) writeRepl(command);
      throw error;
    }
  }
  // Silence a deck's streams and free its pair-slot runtime; the record stays.
  async function release(deck) {
    for (const command of stopCommands(deck)) writeRepl(command);
    const slot = registry.pair.indexOf(deck);
    if (runtimeReady && slot >= 0) await sc(() => `~piSceneAPI[\\stop].value(${slot})`);
  }
  async function stop(deck) {
    deckIndex(deck);
    await release(deck);
    registry.stop(deck);
  }
  // Bring a parked deck into one half of the crossfade pair, parking whatever
  // deck it displaces. Nothing audible is touched until the newcomer compiles.
  async function select(deck, slot, cwd) {
    if (!Number.isInteger(slot) || (slot !== 0 && slot !== 1)) throw Error('select needs a pair position: 0 or 1');
    deckIndex(deck);
    const pair = registry.pair;
    if (pair[slot] === deck) return `deck ${deck} already holds mix position ${slot}`;
    if (pair[1 - slot] === deck) throw Error(`deck ${deck} is already audible at mix position ${1 - slot}; select a different deck into that position before moving ${deck}`);
    const saved = registry.get(deck);
    if (!saved) throw Error(`Load deck ${deck} before selecting it into the pair`);
    const targetPair = pair.map((d, i) => (i === slot ? deck : d));
    const partner = registry.get(targetPair[1 - slot]);
    if (partner && Math.abs(partner.scene.cps - saved.scene.cps) > 1e-9) {
      throw Error(`deck ${deck} runs at ${saved.scene.cps} cps but audible ${targetPair[1 - slot]} runs at ${partner.scene.cps}; stop ${targetPair[1 - slot]} or match the tempo first`);
    }
    const record = registry.plan(deck, saved.file, saved.text, true);
    const status = await ensure(cwd);
    if (!ready(status)) throw Error(status);
    // Fail before parking the audible deck that select would displace.
    await compileCheck(record, targetPair);
    const displaced = pair[slot];
    const displacedRecord = registry.get(displaced);
    try {
      if (displacedRecord) await release(displaced);
      registry.setPair(slot, deck);
      await activate(record);
      return `${path.basename(record.file)} on deck ${deck}: selected into mix position ${slot}; ${displaced} parked; local cycle 0 at shared cycle ${record.origin}`;
    } catch (error) {
      registry.setPair(slot, displaced);
      if (displacedRecord) {
        try {
          await activate(registry.plan(displaced, displacedRecord.file, displacedRecord.text, true));
        } catch (restoreError) {
          throw Error(`select failed (${error}); restoring ${displaced} also failed (${restoreError}); deck ${displaced} stays parked`);
        }
      }
      throw error;
    }
  }
  async function leave() {
    for (const [deck] of registry.entries()) for (const command of stopCommands(deck)) writeRepl(command);
    if (runtimeReady) await sc(() => '~piSceneAPI[\\dispose].value');
    runtimeReady = false; tempoSet = false;
    registry.clear();
  }
  return {
    get runtimeReady() { return runtimeReady; },
    resetTransport() { runtimeReady = false; tempoSet = false; },
    activate, stop, leave, select,
    async restore() {
      const saved = registry.entries(), position = registry.mix, pair = registry.pair;
      registry.clear();
      // Keep unrecovered records on failure so another recovery can be attempted.
      let audible = 0;
      try {
        registry.restorePair(pair);
        for (const [deck, record] of saved) {
          const planned = registry.plan(deck, record.file, record.text, true);
          if (registry.pair.includes(deck)) { await activate(planned); audible++; }
          else await activate(planned, { check: false });
        }
        if (saved.length) registry.setMix(position);
        if (audible) await sc(() => `~piSceneAPI[\\mix].value(${position}, 0.02)`);
      } catch (error) {
        for (const [deck, record] of saved) if (!registry.get(deck)) registry.commit(record);
        throw error;
      }
    },
    async action(params, cwd) {
      const deck = params.deck ?? 'A';
      deckIndex(deck);
      if (params.action === 'select') return select(deck, params.slot, cwd);
      if (params.action === 'status') {
        const pair = registry.pair;
        const describe = ([letter, record]) => `${letter}: ${path.basename(record.file)}, epoch ${record.epoch}` +
          (record.origin !== undefined ? `, origin ${record.origin}` : '') + (pair.includes(letter) ? '' : ' (parked)');
        return `scene pair ${pair[0]} (mix 0) / ${pair[1]} (mix 1): ${registry.entries().map(describe).join('; ') || 'none loaded'}; mix ${registry.mix}`;
      }
      let record;
      if (['load', 'restart', 'edit'].includes(params.action)) {
        const file = params.file ? path.resolve(cwd, params.file) : registry.get(deck)?.file;
        if (!file) throw Error('Supply a scene .tidal file');
        record = registry.plan(deck, file, fs.readFileSync(file, 'utf8'), params.action !== 'edit');
      }
      const status = await ensure(cwd);
      if (!ready(status)) throw Error(status);
      if (record) {
        const parked = !registry.pair.includes(deck);
        await activate(record);
        if (parked) return `${path.basename(record.file)} parked on deck ${deck}; select it into the pair to hear it`;
        return `${path.basename(record.file)} on deck ${deck}: ${record.restart ? `local cycle 0 at shared cycle ${record.origin}` : 'edited with phase preserved'}`;
      }
      if (params.action === 'mix') {
        const mix = params.mix, cycles = params.cycles ?? 0;
        if (!Number.isFinite(mix) || mix < 0 || mix > 1) throw Error('mix must be 0..1');
        if (!Number.isFinite(cycles) || cycles < 0 || cycles > 128) throw Error('cycles must be 0..128');
        if (!runtimeReady) throw Error('Load a scene first');
        const pair = registry.pair;
        if ((mix < 1 && !registry.get(pair[0])) || (mix > 0 && !registry.get(pair[1]))) throw Error('Load the deck(s) you want to hear before mixing');
        const cps = Number(await queryRepl(['getcps >>= print . (fromRational :: Rational -> Double)']));
        if (!(cps > 0)) throw Error('Could not read the Tidal tempo');
        await sc(() => `~piSceneAPI[\\mix].value(${mix}, ${Math.max(0.02, cycles / cps)})`);
        registry.setMix(mix);
        return `mix ${mix} (${pair[0]}=0, ${pair[1]}=1), fade ${cycles} cycles; clocks keep running`;
      }
      if (params.action === 'stop') { await stop(deck); return `deck ${deck} stopped; owned runtime freed`; }
      if (params.action === 'leave') { await leave(); return 'scene mode left; legacy orbit routing restored'; }
      throw Error(`Unknown scene action: ${params.action}`);
    },
  };
}
