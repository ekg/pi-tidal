import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectStereoSinkPorts,
  selectStreamLinkPorts,
  streamLinkEnabled,
  planOutputLinks,
} from '../lib/output-routing.mjs';

// Same physical-port fixture as output-routing.test.mjs, plus the stream tap.
const laptop = 'alsa_output.pci-0000_c1_00.6.HiFi__hw_Generic_1__sink';
const glasses = 'alsa_output.usb-XREAL_XREAL_Air_2_Pro_A00015_28_15-00.analog-stereo';
const physicalPorts = `${laptop}:playback_FL\n${laptop}:playback_FR\nalsa_input.mic__source:capture_FL\n${glasses}:playback_FL\n${glasses}:playback_FR\n`;
const streamPorts = 'tidal_stream:playback_FL\ntidal_stream:playback_FR\ntidal_stream:capture_FL\ntidal_stream:capture_FR\n';
const allPorts = physicalPorts + streamPorts;

// What the boot link step issues: one pw-link per selected stereo pair, in order.
function linkCommands(plan) {
  const cmds = [];
  if (plan.physical) cmds.push(`SuperCollider:out_1 -> ${plan.physical.FL}`, `SuperCollider:out_2 -> ${plan.physical.FR}`);
  if (plan.stream) cmds.push(`SuperCollider:out_1 -> ${plan.stream.FL}`, `SuperCollider:out_2 -> ${plan.stream.FR}`);
  return cmds;
}

test('gate is off by default (config link:false, no env)', () => {
  assert.equal(streamLinkEnabled({}, {}), false);
  assert.equal(streamLinkEnabled({ link: false }, {}), false);
  assert.equal(streamLinkEnabled({ link: true }, {}), true);
  assert.equal(streamLinkEnabled({}, { PI_TIDAL_STREAM_LINK: '1' }), true);
  assert.equal(streamLinkEnabled({}, { PI_TIDAL_STREAM_LINK: 'true' }), true);
  assert.equal(streamLinkEnabled({ link: false }, { PI_TIDAL_STREAM_LINK: '0' }), false);
});

test('gate OFF: computed targets are byte-for-byte today\'s routing', () => {
  const today = selectStereoSinkPorts(allPorts, `node.name = "${laptop}"`);
  for (const [config, env] of [[{}, {}], [{ link: false }, {}], [{}, { PI_TIDAL_STREAM_LINK: '0' }]]) {
    const plan = planOutputLinks({ pwLinkInputs: allPorts, defaultSink: `node.name = "${laptop}"`, config, env });
    assert.deepEqual(plan.physical, today);            // identical physical choice
    assert.deepEqual(plan.physical, { FL: `${glasses}:playback_FL`, FR: `${glasses}:playback_FR` });
    assert.equal(plan.stream, null);                    // no extra link
    assert.deepEqual(linkCommands(plan), linkCommands({ physical: today, stream: null }));
  }
});

test('gate ON: the tidal_stream pair is appended and the physical link is untouched', () => {
  const plan = planOutputLinks({ pwLinkInputs: allPorts, defaultSink: `node.name = "${laptop}"`, config: {}, env: { PI_TIDAL_STREAM_LINK: '1' } });
  assert.deepEqual(plan.physical, { FL: `${glasses}:playback_FL`, FR: `${glasses}:playback_FR` });
  assert.deepEqual(plan.stream, { FL: 'tidal_stream:playback_FL', FR: 'tidal_stream:playback_FR' });
  // physical comes first and is unchanged; the stream link is additive only
  assert.deepEqual(linkCommands(plan), [
    `SuperCollider:out_1 -> ${glasses}:playback_FL`,
    `SuperCollider:out_2 -> ${glasses}:playback_FR`,
    'SuperCollider:out_1 -> tidal_stream:playback_FL',
    'SuperCollider:out_2 -> tidal_stream:playback_FR',
  ]);
  // config link:true is equivalent to the env gate
  const viaConfig = planOutputLinks({ pwLinkInputs: allPorts, defaultSink: `node.name = "${laptop}"`, config: { link: true }, env: {} });
  assert.deepEqual(viaConfig, plan);
});

test('gate ON but sink absent: nothing extra, physical still linked', () => {
  const plan = planOutputLinks({ pwLinkInputs: physicalPorts, defaultSink: `node.name = "${laptop}"`, config: { link: true }, env: {} });
  assert.deepEqual(plan.physical, { FL: `${glasses}:playback_FL`, FR: `${glasses}:playback_FR` });
  assert.equal(plan.stream, null);
});

test('never links a capture port, even when only capture ports exist for the sink', () => {
  const captureOnly = 'tidal_stream:capture_FL\ntidal_stream:capture_FR\n';
  assert.equal(selectStreamLinkPorts(captureOnly), null);
  assert.equal(selectStreamLinkPorts('tidal_stream:playback_FL'), null); // incomplete pair
  assert.equal(selectStreamLinkPorts(allPorts, 'not_the_sink'), null);
  assert.deepEqual(selectStreamLinkPorts(allPorts), { FL: 'tidal_stream:playback_FL', FR: 'tidal_stream:playback_FR' });
});
