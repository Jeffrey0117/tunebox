import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { createApp } from '../lib/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;

let searchCalls = 0;
before(async () => {
  server = createApp({
    store: createStore(':memory:'),
    publicDir: path.join(__dirname, '..', 'public'),
    titleLookup: async (videoId) => (videoId === 'aaaaaaaaaaa' ? 'Mock Title' : null),
    searchLookup: async (q) => {
      searchCalls += 1;
      if (q === 'boom') return null;
      return [{ videoId: 'ccccccccccc', title: `Result for ${q}`, channel: 'Ch', duration: '3:00', thumbnail: 'https://i.ytimg.com/vi/ccccccccccc/mqdefault.jpg' }];
    },
    resolveLookup: async (ext) => (ext.type === 'spotify' ? 'Resolved Spotify Song' : null)
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (route, body) => fetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
}).then((r) => r.json());

test('room lifecycle over HTTP', async () => {
  const room = (await post('/api/rooms', { name: '測試' })).data;
  assert.match(room.id, /^[A-Z0-9]{6}$/);

  const added = await post(`/api/rooms/${room.id}/tracks`, { url: 'https://youtu.be/aaaaaaaaaaa' });
  assert.equal(added.success, true);
  assert.equal(added.data.queue[0].title, 'Mock Title');

  // oEmbed failure falls back to videoId-based title
  const added2 = await post(`/api/rooms/${room.id}/tracks`, { url: 'https://youtu.be/bbbbbbbbbbb' });
  assert.equal(added2.data.queue[1].title, 'YouTube bbbbbbbbbbb');

  const bad = await post(`/api/rooms/${room.id}/tracks`, { url: 'https://example.com/nope' });
  assert.equal(bad.success, false);

  const ctl = await post(`/api/rooms/${room.id}/control`, { cmd: 'toggle' });
  assert.equal(ctl.data.control.seq, 1);
  assert.equal((await post(`/api/rooms/${room.id}/control`, { cmd: 'hack' })).success, false);

  const st = await post(`/api/rooms/${room.id}/status`, { trackId: added.data.queue[0].id, position: 12, duration: 200, paused: false });
  assert.equal(st.data.status.position, 12);

  const got = await (await fetch(`${base}/api/rooms/${room.id}`)).json();
  assert.equal(got.data.queue.length, 2);
  assert.equal((await fetch(`${base}/api/rooms/ZZZZZZ`)).status, 404);
});

test('SSE delivers initial state and mutation broadcasts', async () => {
  const room = (await post('/api/rooms', { name: 'sse' })).data;
  const res = await fetch(`${base}/api/rooms/${room.id}/events`, { headers: { Accept: 'text/event-stream' } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const nextEvent = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        const event = frame.split('\n').find((l) => l.startsWith('event: '));
        if (data) return { event: event ? event.slice(7) : 'message', data: JSON.parse(data.slice(6)) };
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += decoder.decode(value, { stream: true });
    }
  };

  const initial = await nextEvent();
  assert.equal(initial.event, 'state');
  assert.equal(initial.data.id, room.id);
  assert.ok(Number.isInteger(initial.data.now)); // server clock for skew-free freshness checks

  await post(`/api/rooms/${room.id}/tracks`, { url: 'https://youtu.be/aaaaaaaaaaa' });
  const updated = await nextEvent();
  assert.equal(updated.event, 'state');
  assert.equal(updated.data.queue[0].title, 'Mock Title');

  // player heartbeat must arrive as a small `status` event, not a full state fanout
  const trackId = updated.data.queue[0].id;
  await post(`/api/rooms/${room.id}/status`, { trackId, position: 5, duration: 100, paused: false, playerId: 'p_test' });
  const statusEv = await nextEvent();
  assert.equal(statusEv.event, 'status');
  assert.equal(statusEv.data.status.trackId, trackId);
  assert.equal(statusEv.data.status.playerId, 'p_test');
  assert.equal(statusEv.data.queue, undefined);
  await reader.cancel();
});

test('global room-creation ceiling holds regardless of claimed IP', async () => {
  const isolated = createApp({ store: createStore(':memory:'), publicDir: path.join(__dirname, '..', 'public'), titleLookup: async () => null });
  await new Promise((r) => isolated.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${isolated.address().port}`;
  try {
    let last;
    for (let i = 0; i < 31; i += 1) {
      last = await fetch(`${b}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.${i}.${i}` }, // fresh bucket per request
        body: '{}'
      });
    }
    assert.equal(last.status, 429);
  } finally {
    isolated.close();
  }
});

test('search endpoint: text query, link resolution, cache, failure modes', async () => {
  const room = (await post('/api/rooms', { name: 'search' })).data;
  const get = (q) => fetch(`${base}/api/rooms/${room.id}/search?q=${encodeURIComponent(q)}`).then((r) => r.json());

  const r1 = await get('my song');
  assert.equal(r1.success, true);
  assert.equal(r1.data.query, 'my song');
  assert.equal(r1.data.results[0].title, 'Result for my song');

  const callsBefore = searchCalls;
  await get('my song'); // cached — no second upstream search
  assert.equal(searchCalls, callsBefore);

  const r2 = await get('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8');
  assert.equal(r2.data.query, 'Resolved Spotify Song');

  const unresolvable = await get('https://music.apple.com/tw/song/x/123'); // resolveLookup mock returns null for apple
  assert.equal(unresolvable.success, false);

  const down = await fetch(`${base}/api/rooms/${room.id}/search?q=boom`);
  assert.equal(down.status, 502);

  assert.equal((await fetch(`${base}/api/rooms/${room.id}/search?q=`)).status, 400);
  assert.equal((await fetch(`${base}/api/rooms/ZZZZZ2/search?q=x`)).status, 404);
});

test('room page served for /r/:id, landing for /', async () => {
  const home = await fetch(base + '/');
  assert.match(await home.text(), /tunebox/);
  const roomPage = await fetch(base + '/r/ABC234');
  assert.equal(roomPage.status, 200);
  assert.match(await roomPage.text(), /播放模式|tunebox/);
  assert.equal((await fetch(base + '/r/TOOLONG')).status, 404);
});
