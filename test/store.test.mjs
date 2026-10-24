import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { parseVideoId, parseExternalLink } from '../lib/youtube.js';

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

test('seek/volume control args are sanitized', () => {
  const s = mk();
  const { id } = s.createRoom('r');
  const seek = s.setControl(id, 'seek', { position: 93.4 });
  assert.equal(seek.state.control.position, 93.4);
  const badSeek = s.setControl(id, 'seek', { position: -5 });
  assert.equal(badSeek.state.control.position, undefined);
  const vol = s.setControl(id, 'volume', { volume: 250 });
  assert.equal(vol.state.control.volume, 100); // clamped
  const vol2 = s.setControl(id, 'volume', { volume: 33.7 });
  assert.equal(vol2.state.control.volume, 34);
  const badVol = s.setControl(id, 'volume', { volume: 'loud' });
  assert.equal(badVol.state.control.volume, undefined);
});

test('status is sanitized', () => {
  const s = mk();
  const { id } = s.createRoom('r');
  const r = s.setStatus(id, { trackId: 't_1', title: 'Song', position: '77', duration: 100, paused: 0, volume: 87 });
  assert.equal(r.status.position, 0); // non-number dropped
  assert.equal(r.status.duration, 100);
  assert.equal(r.status.paused, false);
  assert.equal(r.status.volume, 87);
  assert.equal(s.getRoom(id).status.duration, 100); // persisted
  assert.equal(s.setStatus('XXXXXX', {}), null);
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

test('parseExternalLink detects Spotify and Apple Music links', () => {
  assert.deepEqual(parseExternalLink('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8?si=abc'),
    { type: 'spotify', url: 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8' });
  assert.deepEqual(parseExternalLink('https://open.spotify.com/intl-zh-tw/track/4PTG3Z6ehGkBFwjybzWkR8'),
    { type: 'spotify', url: 'https://open.spotify.com/intl-zh-tw/track/4PTG3Z6ehGkBFwjybzWkR8' });
  assert.deepEqual(parseExternalLink('https://music.apple.com/tw/album/american-teen/1200868403?i=1200868616'),
    { type: 'apple', id: '1200868616' });
  assert.deepEqual(parseExternalLink('https://music.apple.com/tw/song/american-teen/1200868616'),
    { type: 'apple', id: '1200868616' });
  assert.equal(parseExternalLink('https://example.com/track/x'), null);
  assert.equal(parseExternalLink('khalid american teen'), null);
  assert.equal(parseExternalLink('https://open.spotify.com/user/someone'), null);
});
