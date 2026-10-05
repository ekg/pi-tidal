import fs from 'node:fs';
import path from 'node:path';
import { validateMixerConfig } from './scenes.mjs';

// The scene mixer's geometry must match the orbit list in the project's
// SuperDirt startup file (`~dirt.start(57120, 0 ! (channels * orbits))`).
// SuperDirt fixes the orbit count at boot, so a mismatch means silently
// unusable channels — hence the project declares it instead of the plugin
// guessing:
//   1. PI_TIDAL_SCENE_CHANNELS / PI_TIDAL_SCENE_ORBITS environment variables
//   2. <project>/sc/scene-mixer.json  ({"channels": 4, "orbits": 6} kebab/alias
//      keys `channels`/`orbits` or `channelCount`/`orbitsPerChannel`)
//   3. the backward-compatible 2 x 6 default
export const DEFAULT_SCENE_MIXER = Object.freeze({ channelCount: 2, orbitsPerChannel: 6 });

export const SCENE_MIXER_CONFIG_FILES = ['sc/scene-mixer.json', '.pi/scene-mixer.json', 'scene-mixer.json'];

function parseConfig(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`scene mixer config ${source} must be a JSON object`);
  const channelCount = value.channels ?? value.channelCount;
  const orbitsPerChannel = value.orbits ?? value.orbitsPerChannel;
  const resolved = {
    channelCount: channelCount === undefined ? DEFAULT_SCENE_MIXER.channelCount : Number(channelCount),
    orbitsPerChannel: orbitsPerChannel === undefined ? DEFAULT_SCENE_MIXER.orbitsPerChannel : Number(orbitsPerChannel),
    source,
  };
  validateMixerConfig(resolved.channelCount, resolved.orbitsPerChannel);
  return resolved;
}

export function resolveSceneMixerConfig({ env = process.env, cwd = process.cwd(), readFile = fs.readFileSync } = {}) {
  if (env.PI_TIDAL_SCENE_CHANNELS !== undefined || env.PI_TIDAL_SCENE_ORBITS !== undefined) {
    return parseConfig({
      channels: env.PI_TIDAL_SCENE_CHANNELS,
      orbits: env.PI_TIDAL_SCENE_ORBITS,
    }, 'environment');
  }
  for (const relative of SCENE_MIXER_CONFIG_FILES) {
    const file = path.resolve(cwd, relative);
    let text;
    try { text = readFile(file, 'utf8'); }
    catch { continue; } // absent file is the normal case
    try { return parseConfig(JSON.parse(String(text)), file); }
    catch (error) {
      throw Error(`scene mixer config ${file} is invalid: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { ...DEFAULT_SCENE_MIXER, source: 'default' };
}
