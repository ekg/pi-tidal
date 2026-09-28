import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStereoSinkPorts } from '../lib/output-routing.mjs';

const laptop = 'alsa_output.pci-0000_c1_00.6.HiFi__hw_Generic_1__sink';
const glasses = 'alsa_output.usb-XREAL_XREAL_Air_2_Pro_A00015_28_15-00.analog-stereo';
const ports = `${laptop}:playback_FL\n${laptop}:playback_FR\nalsa_input.mic__source:capture_FL\n${glasses}:playback_FL\n${glasses}:playback_FR\n`;

test('prefers a complete XREAL analog stereo sink over the first laptop sink', () => {
  assert.deepEqual(selectStereoSinkPorts(ports, `node.name = "${laptop}"`), {
    FL: `${glasses}:playback_FL`, FR: `${glasses}:playback_FR`,
  });
});

test('prefers the virtual Tidal Main sink so output follows the UI selection', () => {
  const virtual = 'tidal_main';
  const all = `${ports}${virtual}:playback_FL\n${virtual}:playback_FR\n`;
  assert.deepEqual(selectStereoSinkPorts(all, `node.name = "${laptop}"`), {
    FL: `${virtual}:playback_FL`, FR: `${virtual}:playback_FR`,
  });
});

test('falls back to the configured default when glasses are absent', () => {
  const other = 'alsa_output.usb-DAC__sink';
  const noGlasses = `${laptop}:playback_FL\n${laptop}:playback_FR\n${other}:playback_FL\n${other}:playback_FR`;
  assert.deepEqual(selectStereoSinkPorts(noGlasses, `  * node.name = "${other}"`), {
    FL: `${other}:playback_FL`, FR: `${other}:playback_FR`,
  });
});

test('does not use incomplete pairs or capture ports', () => {
  assert.equal(selectStereoSinkPorts('mic:source:capture_FL\nXREAL:sink:playback_FL'), null);
});
