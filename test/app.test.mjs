import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { createApp } from '../lib/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;

before(async () => {
  server = createApp({
    store: createStore(':memory:'),
    publicDir: path.join(__dirname, '..', 'public'),
    titleLookup: async (videoId) => (videoId === 'aaaaaaaaaaa' ? 'Mock Title' : null)
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
  const nextState = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += decoder.decode(value, { stream: true });
    }
  };

  const initial = await nextState();
  assert.equal(initial.id, room.id);
  assert.equal(initial.queue.length, 0);

  await post(`/api/rooms/${room.id}/tracks`, { url: 'https://youtu.be/aaaaaaaaaaa' });
  const updated = await nextState();
  assert.equal(updated.queue.length, 1);
  assert.equal(updated.queue[0].title, 'Mock Title');
  await reader.cancel();
});

test('room page served for /r/:id, landing for /', async () => {
  const home = await fetch(base + '/');
  assert.match(await home.text(), /tunebox/);
  const roomPage = await fetch(base + '/r/ABC234');
  assert.equal(roomPage.status, 200);
  assert.match(await roomPage.text(), /播放模式|tunebox/);
  assert.equal((await fetch(base + '/r/TOOLONG')).status, 404);
});
