import fs from 'node:fs';
import path from 'node:path';
import { tempoRideSteps as defaultTempoRideSteps } from './tempo-ride.mjs';

// Injected transports let the same lifecycle run against real SC/GHCi or a
// deterministic fixture. Only explicit morph starts a bounded timer scheduler.
// Decks A..Z are logical: only configured channels get Tidal streams, an SC
// context and a fixed local-orbit block. Loading
// any other letter parks it (source kept, Haskell checked, no DSP).
export function createSceneController({ registry, runtimePath, ensure, ready,
  writeRepl, queryRepl, sc, hush, label, deckIndex, deckSlot, patternExpression, sceneCommands, stopCommands,
  enqueue = fn => fn(), setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now(),
  tempoRideSteps = defaultTempoRideSteps }) {
  let runtimeReady = false;
  let tempoSet = false; // this REPL has received setcps for the loaded scene tempo
  let ride, rideStatus = 'idle', restoring = false;
  const channelCount = registry.channelCount, orbitsPerChannel = registry.orbitsPerChannel;
  const configuration = channelCount === 2 && orbitsPerChannel === 6 ? '' : `, ${channelCount}, ${orbitsPerChannel}`;
  const requireFaders = 'if(~piSceneAPI[\\gains].isNil) { Error("old SC scene runtime: leave scene mode and reload before using gain or morph").throw }';
  const gainCommand = (gains, seconds = 0.02) => `${requireFaders}; ~piSceneAPI[\\gains].value([${gains.join(', ')}], ${seconds})`;
  function cancelRide(reason = 'cancelled') {
    if (!ride) return `tempo ride ${rideStatus}`;
    clearTimer(ride.timer);
    rideStatus = `${reason}; effective cps ${registry.tempoOverride}, gains [${registry.gains.join(', ')}] (last acknowledged targets)`;
    ride = undefined;
    label(`tempo ride ${rideStatus}`);
    return `tempo ride ${rideStatus}`;
  }
  async function readCps() {
    const cps = Number(await queryRepl(['getcps >>= print . (fromRational :: Rational -> Double)']));
    if (!Number.isFinite(cps) || cps <= 0 || cps > 4) throw Error('Could not read the Tidal tempo');
    return cps;
  }
  function scheduleStep(state) {
    const step = state.steps[state.index];
    // Never catch up with a burst after a slow acknowledgement. Delays may
    // stretch the wall-clock ride rather than exceed the requested step rate.
    const delay = Math.max(0, state.started + step.at - now(), state.lastSent + state.interval - now());
    state.timer = setTimer(() => {
      state.timer = undefined;
      void enqueue(async () => {
        if (ride !== state) return; // cancellation also invalidates queued work
        const previousCps = registry.tempoOverride, previousGains = registry.gains;
        const gains = [...state.initialGains];
        gains[state.from] *= 1 - step.fraction;
        gains[state.to] += (1 - gains[state.to]) * step.fraction;
        try {
          state.lastSent = now();
          const reply = Number(await queryRepl([step.command, 'getcps >>= print . (fromRational :: Rational -> Double)']));
          if (ride !== state) return;
          if (!Number.isFinite(reply) || Math.abs(reply - step.cps) > 1e-8) throw Error('setcps was not acknowledged');
          await sc(() => gainCommand(gains));
          if (ride !== state) return;
          registry.setTempoOverride(step.cps); registry.setGains(gains);
          if (channelCount === 2 && Math.abs(gains[0] + gains[1] - 1) < 1e-9) registry.setMix(gains[1]);
          state.index++;
          if (state.index === state.steps.length) {
            ride = undefined;
            rideStatus = `completed; effective cps ${step.cps}, gains [${registry.gains.join(', ')}]`;
          } else scheduleStep(state);
          label(`tempo ride ${rideStatus}`);
        } catch (error) {
          if (ride !== state) return;
          // A request can have reached Tidal before its acknowledgement failed.
          // Compensate both transports to the previous acknowledged targets.
          let recovery = 'restored last acknowledged targets';
          try {
            const reply = Number(await queryRepl([`setcps ${previousCps}`, 'getcps >>= print . (fromRational :: Rational -> Double)']));
            if (!Number.isFinite(reply) || Math.abs(reply - previousCps) > 1e-8) throw Error('tempo rollback unacknowledged');
            await sc(() => gainCommand(previousGains));
          } catch (restoreError) { recovery = `transport state unconfirmed; recovery required (${restoreError})`; }
          cancelRide(`failed (${error}); ${recovery}`);
        }
      }).catch(error => { if (ride === state) cancelRide(`queue failed (${error}); transport state unconfirmed`); });
    }, delay);
  }
  async function morph(params) {
    if (!runtimeReady) throw Error('Load a scene first');
    const { from, to, toCps, seconds, stepHz = 4 } = params;
    if (![from, to].every(i => Number.isInteger(i) && i >= 0 && i < channelCount) || from === to) throw Error('morph needs two distinct channel indices');
    if (![from, to].every(i => registry.get(registry.channels[i]))) throw Error('Load both morph channels first');
    // Validate before even querying the live clock.
    tempoRideSteps(1, toCps, seconds, stepHz);
    // Nil.value in SC can silently succeed: reject old runtimes BEFORE a ride
    // mutates the global tempo, rather than acknowledge a nonexistent fader.
    await sc(() => requireFaders);
    const cps = await readCps();
    registry.setTempoOverride(cps);
    const steps = tempoRideSteps(cps, toCps, seconds, stepHz);
    ride = { from, to, steps, index: 0, initialGains: registry.gains,
      started: now(), lastSent: -Infinity, interval: 1000 / stepHz };
    rideStatus = `running ${from}->${to}, ${cps}->${toCps} cps over ${seconds}s`;
    scheduleStep(ride);
    label(`tempo ride ${rideStatus}`);
    return `tempo ride ${rideStatus}; cancel to hold last acknowledged targets; all channels follow the global clock`;
  }
  async function install() {
    if (runtimeReady) return;
    hush();
    await sc(token => `if(~piSceneAPI.isNil) { this.executeFile(${JSON.stringify(runtimePath)}) }; if(~piSceneAPI.isNil) { Error("scene runtime failed to compile").throw }; ${configuration ? 'if(~piSceneManager[\\channelCount].isNil) { Error("old SC scene runtime: leave scene mode and reload before using configurable channels").throw }; ' : ''}~piSceneAPI[\\install].value(${token}${configuration})`, true);
    runtimeReady = true;
  }
  async function compileCheck(record, pair) {
    const candidate = `piSceneCandidate${record.deck}${record.epoch}`;
    writeRepl(`let ${candidate} = ${patternExpression(record.scene, record.deck, pair, orbitsPerChannel)}`);
    const checked = await queryRepl([`print (length (queryArc ${candidate} (Arc 0 1)))`]);
    if (!/^\d+$/.test(checked.trim())) throw Error(`Tidal scene did not compile: ${checked}`);
  }
  async function activate(record, { check = true } = {}) {
    cancelRide('cancelled by activation');
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
    const previous = registry.get(deck), previousTempo = registry.tempoOverride;
    const partner = registry.entries().some(([other]) => other !== deck && registry.channels.includes(other));
    const replacesTempo = !partner && !restoring && restart;
    try {
      // Parked decks loaded first must not leave the REPL on its boot tempo.
      if (!tempoSet || !partner) writeRepl(`setcps ${replacesTempo ? scene.cps : registry.tempoOverride ?? scene.cps}`);
      tempoSet = true;
      const commands = sceneCommands(scene, deck, epoch, { restart, pair: registry.pair, orbitsPerChannel, cps: replacesTempo ? scene.cps : registry.tempoOverride ?? scene.cps });
      if (restart) writeRepl(commands.shift());
      const reply = await queryRepl([...commands, `print (fromRational piSceneOrigin${deck} :: Double)`]);
      if (!/^\d+(?:\.\d+)?$/.test(reply.trim())) throw Error(`Scene activation was not acknowledged: ${reply}`);
      record.origin = Number(reply.trim());
      if (replacesTempo) registry.setTempoOverride(undefined);
      registry.commit(record);
      label(`${path.basename(record.file)} deck ${deck} ${restart ? 'restart' : 'edit'}; origin ${record.origin}`);
    } catch (error) {
      if (replacesTempo && previousTempo !== undefined) writeRepl(`setcps ${previousTempo}`);
      await sc(() => `~piSceneAPI[\\cancel].value(${slot})`);
      if (previous) {
        writeRepl(`let piSceneOrigin${deck} = ${previous.origin} :: Rational`);
        for (const command of sceneCommands(previous.scene, deck, previous.epoch, { restart: false, pair: registry.pair, orbitsPerChannel })) writeRepl(command);
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
    cancelRide('cancelled by stop');
    deckIndex(deck);
    await release(deck);
    registry.stop(deck);
  }
  // Bring a parked deck into one half of the crossfade pair, parking whatever
  // deck it displaces. Nothing audible is touched until the newcomer compiles.
  async function select(deck, slot, cwd) {
    cancelRide('cancelled by select');
    if (!Number.isInteger(slot) || slot < 0 || slot >= channelCount) throw Error(`select needs a pair position / channel: 0..${channelCount - 1}`);
    deckIndex(deck);
    const pair = registry.pair;
    if (pair[slot] === deck) return `deck ${deck} already holds mix position ${slot}`;
    if (pair.includes(deck)) throw Error(`deck ${deck} is already audible at mix position ${pair.indexOf(deck)}; select a different deck into that position before moving ${deck}`);
    const saved = registry.get(deck);
    if (!saved) throw Error(`Load deck ${deck} before selecting it into the pair`);
    const targetPair = pair.map((d, i) => (i === slot ? deck : d));
    for (const other of targetPair.filter((_, i) => i !== slot)) {
      const partner = registry.get(other), effective = registry.tempoOverride ?? partner?.scene.cps;
      if (partner && Math.abs(effective - saved.scene.cps) > 1e-9) {
        throw Error(`deck ${deck} runs at ${saved.scene.cps} cps but audible ${other} runs at ${effective}; stop ${other} or match the tempo first`);
      }
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
    cancelRide('cancelled by leave');
    for (const [deck] of registry.entries()) for (const command of stopCommands(deck)) writeRepl(command);
    if (runtimeReady) await sc(() => '~piSceneAPI[\\dispose].value');
    runtimeReady = false; tempoSet = false;
    registry.clear(); rideStatus = 'idle';
  }
  return {
    get runtimeReady() { return runtimeReady; },
    resetTransport() { cancelRide('cancelled by transport reset'); runtimeReady = false; tempoSet = false; },
    activate, stop, leave, select,
    async restore() {
      cancelRide('cancelled by restore');
      const snapshot = registry.snapshot(), saved = registry.entries();
      registry.clear();
      registry.restoreChannels(snapshot.pair);
      registry.setTempoOverride(snapshot.tempoOverride);
      registry.setMix(snapshot.mix);
      if (snapshot.gains) registry.setGains(snapshot.gains);
      // Keep the last good records, including declared tempos, until each replay
      // succeeds. This also lets unchanged ridden metadata validate on recovery.
      for (const [, record] of saved) registry.commit(record);
      let audible = 0;
      restoring = true;
      try {
        for (const [deck, record] of saved) {
          const planned = registry.plan(deck, record.file, record.text, true);
          if (registry.channels.includes(deck)) { await activate(planned); audible++; }
          else await activate(planned, { check: false });
        }
        if (audible) {
          if (!snapshot.gains) await sc(() => `~piSceneAPI[\\mix].value(${snapshot.mix}, 0.02)`);
          else await sc(() => gainCommand(snapshot.gains));
        }
      } finally { restoring = false; }
    },
    async action(params, cwd) {
      if (params.action === 'cancel') return cancelRide();
      if (params.action !== 'status') cancelRide(`cancelled by ${params.action}`);
      const deck = params.deck ?? 'A';
      deckIndex(deck);
      if (params.action === 'select') return select(deck, params.slot, cwd);
      if (params.action === 'status') {
        const pair = registry.pair;
        const describe = ([letter, record]) => `${letter}: ${path.basename(record.file)}, epoch ${record.epoch}` +
          (record.origin !== undefined ? `, origin ${record.origin}` : '') + (pair.includes(letter) ? '' : ' (parked)') + (registry.tempoOverride === undefined ? '' : `, declared cps ${record.scene.cps}, effective cps ${registry.tempoOverride}`);
        if (channelCount !== 2) return `scene channels ${pair.join('/')}: ${registry.entries().map(describe).join('; ') || 'none loaded'}; gains [${registry.gains.join(', ')}]; tempo ride ${rideStatus}`;
        const independentGains = registry.gains[0] !== 1 - registry.mix || registry.gains[1] !== registry.mix;
        return `scene pair ${pair[0]} (mix 0) / ${pair[1]} (mix 1): ${registry.entries().map(describe).join('; ') || 'none loaded'}; mix ${registry.mix}` + (independentGains ? `; gains [${registry.gains.join(', ')}]` : '') + (rideStatus === 'idle' ? '' : `; tempo ride ${rideStatus}`);
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
      if (params.action === 'morph') return morph(params);
      if (params.action === 'gain') {
        const channel = params.channel, gain = params.gain, seconds = params.seconds ?? 0.02;
        if (!Number.isInteger(channel) || channel < 0 || channel >= channelCount) throw Error('invalid gain channel');
        if (!Number.isFinite(gain) || gain < 0 || gain > 1) throw Error('gain must be 0..1 (power weight)');
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) throw Error('gain seconds must be 0..300');
        if (!runtimeReady || (gain > 0 && !registry.get(registry.channels[channel]))) throw Error('Load the channel first');
        const gains = registry.gains; gains[channel] = gain;
        await sc(() => gainCommand(gains, Math.max(0.02, seconds)));
        registry.setGains(gains);
        return `channel ${channel} gain ${gain} (power weight), fade ${seconds}s; clock keeps running`;
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
