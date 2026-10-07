import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStreamArgs, parseStreamStatus, parseStreamUrl, STREAM_ACTIONS } from '../lib/stream-tools.mjs';

// Fixtures are the exact shapes tools/stream/stream-ctl prints (do_status/do_url).

test('buildStreamArgs maps every frozen verb to a single argv token', () => {
  for (const action of STREAM_ACTIONS) assert.deepEqual(buildStreamArgs(action), [action]);
  assert.throws(() => buildStreamArgs('reboot'), /unknown stream action/);
});

test('parseStreamStatus reads the six contract lines plus daemon/enabled', () => {
  const text = [
    'sink: present',
    'source linked: yes',
    'listeners: 2',
    'frames/sec: 50',
    'dropped: 3',
    'source: up',
    'daemon: up',
    'enabled: true',
  ].join('\n');
  assert.deepEqual(parseStreamStatus(text), {
    sink: 'present',
    sourceLinked: true,
    listeners: 2,
    framesPerSec: 50,
    dropped: 3,
    source: 'up',
    daemon: 'up',
    enabled: true,
  });
});

test('parseStreamStatus returns nulls (all six keys present) for a down daemon', () => {
  const text = ['sink: absent', 'source linked: no', 'listeners: 0', 'frames/sec: 0', 'dropped: 0', 'source: down'].join('\n');
  const parsed = parseStreamStatus(text);
  assert.equal(parsed.source, 'down');
  assert.equal(parsed.sink, 'absent');
  assert.equal(parsed.sourceLinked, false);
  assert.deepEqual(Object.keys(parsed), ['sink', 'sourceLinked', 'listeners', 'framesPerSec', 'dropped', 'source', 'daemon', 'enabled']);
  assert.equal(parseStreamStatus('').source, null);
});

test('parseStreamUrl separates the direct URL from the tailscale block', () => {
  const text = [
    'ws://127.0.0.1:8787/?token=sekret',
    'tailscale: box.tailnet.ts.net',
    '  direct:  ws://box.tailnet.ts.net:8787/?token=sekret',
    '  serve:   tailscale serve --bg --https=443 http://127.0.0.1:8787',
  ].join('\n');
  assert.deepEqual(parseStreamUrl(text), {
    url: 'ws://127.0.0.1:8787/?token=sekret',
    tailscale: {
      hostname: 'box.tailnet.ts.net',
      direct: 'ws://box.tailnet.ts.net:8787/?token=sekret',
      serve: 'tailscale serve --bg --https=443 http://127.0.0.1:8787',
    },
  });
});

test('parseStreamUrl tolerates a box with no tailnet', () => {
  assert.deepEqual(parseStreamUrl('ws://127.0.0.1:8787/\n'), { url: 'ws://127.0.0.1:8787/', tailscale: null });
  assert.deepEqual(parseStreamUrl(''), { url: null, tailscale: null });
});
