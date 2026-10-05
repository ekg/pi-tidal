import fs from 'node:fs';
import path from 'node:path';

// Injected transports let the same lifecycle run against real SC/GHCi or a
// deterministic fixture. No subprocesses or timers are started by this module.
export function createSceneController({ registry, runtimePath, ensure, ready,
  writeRepl, queryRepl, sc, hush, label, deckIndex, patternExpression, sceneCommands, stopCommands }) {
  let runtimeReady = false;
  async function install() {
    if (runtimeReady) return;
    hush();
    await sc(token => `if(~piSceneAPI.isNil) { this.executeFile(${JSON.stringify(runtimePath)}) }; if(~piSceneAPI.isNil) { Error("scene runtime failed to compile").throw }; ~piSceneAPI[\\install].value(${token})`, true);
    runtimeReady = true;
  }
  async function activate(record) {
    const { deck, scene, epoch, restart } = record;
    const candidate = `piSceneCandidate${deck}${epoch}`;
    writeRepl(`let ${candidate} = ${patternExpression(scene, deck)}`);
    const checked = await queryRepl([`print (length (queryArc ${candidate} (Arc 0 1)))`]);
    if (!/^\d+$/.test(checked.trim())) throw Error(`Tidal scene did not compile: ${checked}`);
    await install();
    await sc(token => `~piSceneAPI[\\prepare].value(${deckIndex(deck)}, ${epoch}, ${restart ? 'true' : 'false'}, ${JSON.stringify(scene.sc)}, ${token})`, true);
    const previous = registry.get(deck);
    try {
      if (!registry.entries().length) writeRepl(`setcps ${scene.cps}`);
      const commands = sceneCommands(scene, deck, epoch, { restart });
      if (restart) writeRepl(commands.shift());
      const reply = await queryRepl([...commands, `print (fromRational piSceneOrigin${deck} :: Double)`]);
      if (!/^\d+(?:\.\d+)?$/.test(reply.trim())) throw Error(`Scene activation was not acknowledged: ${reply}`);
      record.origin = Number(reply.trim());
      registry.commit(record);
      label(`${path.basename(record.file)} deck ${deck} ${restart ? 'restart' : 'edit'}; origin ${record.origin}`);
    } catch (error) {
      await sc(() => `~piSceneAPI[\\cancel].value(${deckIndex(deck)})`);
      if (previous) {
        writeRepl(`let piSceneOrigin${deck} = ${previous.origin} :: Rational`);
        for (const command of sceneCommands(previous.scene, deck, previous.epoch, { restart: false })) writeRepl(command);
      } else for (const command of stopCommands(deck)) writeRepl(command);
      throw error;
    }
  }
  async function stop(deck) {
    for (const command of stopCommands(deck)) writeRepl(command);
    if (runtimeReady) await sc(() => `~piSceneAPI[\\stop].value(${deckIndex(deck)})`);
    registry.stop(deck);
  }
  async function leave() {
    for (const [deck] of registry.entries()) await stop(deck);
    if (runtimeReady) await sc(() => '~piSceneAPI[\\dispose].value');
    runtimeReady = false;
    registry.clear();
  }
  return {
    get runtimeReady() { return runtimeReady; },
    resetTransport() { runtimeReady = false; },
    activate, stop, leave,
    async restore() {
      const saved = registry.entries(), position = registry.mix;
      registry.clear();
      // Keep unrecovered records on failure so another recovery can be attempted.
      try {
        for (const [deck, record] of saved) await activate(registry.plan(deck, record.file, record.text, true));
        if (saved.length) { await sc(() => `~piSceneAPI[\\mix].value(${position}, 0.02)`); registry.setMix(position); }
      } catch (error) {
        for (const [deck, record] of saved) if (!registry.get(deck)) registry.commit(record);
        throw error;
      }
    },
    async action(params, cwd) {
      const deck = params.deck ?? 'A';
      deckIndex(deck);
      if (params.action === 'status') return `scene decks: ${registry.entries().map(([d, r]) => `${d}: ${path.basename(r.file)}, epoch ${r.epoch}, origin ${r.origin}`).join('; ') || 'none'}; mix ${registry.mix}`;
      let record;
      if (['load', 'restart', 'edit'].includes(params.action)) {
        const file = params.file ? path.resolve(cwd, params.file) : registry.get(deck)?.file;
        if (!file) throw Error('Supply a scene .tidal file');
        record = registry.plan(deck, file, fs.readFileSync(file, 'utf8'), params.action !== 'edit');
      }
      const status = await ensure(cwd);
      if (!ready(status)) throw Error(status);
      if (record) {
        await activate(record);
        return `${path.basename(record.file)} on deck ${deck}: ${record.restart ? `local cycle 0 at shared cycle ${record.origin}` : 'edited with phase preserved'}`;
      }
      if (params.action === 'mix') {
        const mix = params.mix, cycles = params.cycles ?? 0;
        if (!Number.isFinite(mix) || mix < 0 || mix > 1) throw Error('mix must be 0..1');
        if (!Number.isFinite(cycles) || cycles < 0 || cycles > 128) throw Error('cycles must be 0..128');
        if (!runtimeReady) throw Error('Load a scene first');
        if ((mix < 1 && !registry.get('A')) || (mix > 0 && !registry.get('B'))) throw Error('Load the deck(s) you want to hear before mixing');
        const cps = Number(await queryRepl(['getcps >>= print . (fromRational :: Rational -> Double)']));
        if (!(cps > 0)) throw Error('Could not read the Tidal tempo');
        await sc(() => `~piSceneAPI[\\mix].value(${mix}, ${Math.max(0.02, cycles / cps)})`);
        registry.setMix(mix);
        return `mix ${mix} (A=0, B=1), fade ${cycles} cycles; clocks keep running`;
      }
      if (params.action === 'stop') { await stop(deck); return `deck ${deck} stopped and owned nodes freed`; }
      if (params.action === 'leave') { await leave(); return 'scene mode left; legacy orbit routing restored'; }
      throw Error(`Unknown scene action: ${params.action}`);
    },
  };
}
