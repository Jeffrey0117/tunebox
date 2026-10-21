import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { parseVideoId } from '../lib/youtube.js';

const mk = () => createStore(':memory:');

test('create + get room', () => {
  const s = mk();
  const room = s.createRoom('派對');
  assert.match(room.id, /^[A-Z0-9]{6}$/);
  assert.equal(room.name, '派對');
  assert.deepEqual(room.queue, []);
  assert.equal(s.getRoom(room.id.toLowerCase()).id, room.id); // case-insensitive lookup
  assert.equal(s.getRoom('XXXXXX'), null);
});

test('add / move / remove tracks bump version', () => {
  const s = mk();
  const { id } = s.createRoom('r');
  const r1 = s.addTrack(id, { videoId: 'aaaaaaaaaaa', title: 'A' });
  const r2 = s.addTrack(id, { videoId: 'bbbbbbbbbbb', title: 'B' });
  assert.equal(r2.state.queue.length, 2);
  assert.ok(r2.state.version > r1.state.version);

  const tA = r2.state.queue[0];
  const up = s.moveTrack(id, r2.state.queue[1].id, 'up');
  assert.deepEqual(up.state.queue.map((t) => t.title), ['B', 'A']);
  assert.equal(s.moveTrack(id, tA.id, 'down').error, 'rejected'); // already last

  const rm = s.removeTrack(id, tA.id);
  assert.deepEqual(rm.state.queue.map((t) => t.title), ['B']);
  assert.equal(s.removeTrack(id, 'nope').error, 'rejected');
});

test('control commands get increasing seq', () => {
  const s = mk();
  const { id } = s.createRoom('r');
  const c1 = s.setControl(id, 'toggle');
  const c2 = s.setControl(id, 'jump', { trackId: 't_x' });
  assert.equal(c1.state.control.seq, 1);
  assert.equal(c2.state.control.seq, 2);
  assert.equal(c2.state.control.cmd, 'jump');
  assert.equal(c2.state.control.trackId, 't_x');
});

test('status is sanitized', () => {
  const s = mk();
  const { id } = s.createRoom('r');
  const r = s.setStatus(id, { trackId: 't_1', title: 'Song', position: '77', duration: 100, paused: 0 });
  assert.equal(r.state.status.position, 0); // non-number dropped
  assert.equal(r.state.status.duration, 100);
  assert.equal(r.state.status.paused, false);
});

test('purge removes only idle rooms', () => {
  const s = mk();
  const old = s.createRoom('old', Date.now() - 31 * 24 * 3600 * 1000);
  const fresh = s.createRoom('fresh');
  assert.equal(s.purge(), 1);
  assert.equal(s.getRoom(old.id), null);
  assert.ok(s.getRoom(fresh.id));
});

test('parseVideoId handles the common URL shapes', () => {
  for (const [input, expected] of [
    ['https://www.youtube.com/watch?v=0NChtZCDCsY', '0NChtZCDCsY'],
    ['https://youtu.be/0NChtZCDCsY?t=30', '0NChtZCDCsY'],
    ['https://m.youtube.com/watch?v=0NChtZCDCsY&list=x', '0NChtZCDCsY'],
    ['https://music.youtube.com/watch?v=0NChtZCDCsY', '0NChtZCDCsY'],
    ['https://www.youtube.com/shorts/0NChtZCDCsY', '0NChtZCDCsY'],
    ['https://www.youtube.com/embed/0NChtZCDCsY', '0NChtZCDCsY'],
    ['0NChtZCDCsY', '0NChtZCDCsY'],
    ['https://example.com/watch?v=0NChtZCDCsY', null],
    ['not a url', null],
    ['https://www.youtube.com/watch?v=short', null]
  ]) {
    assert.equal(parseVideoId(input), expected, input);
  }
});
