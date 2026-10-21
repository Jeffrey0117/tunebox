// HTTP layer: static pages + room API + SSE. No auth — the unguessable room
// code is the capability; a per-IP rate limit caps abuse.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseVideoId, fetchTitle } from './youtube.js';
import { createHub } from './sse.js';

const MAX_BODY = 16 * 1024;
const RATE_LIMIT = 240; // per IP per minute — player status posts + edits for a living room
const RATE_WINDOW_MS = 60 * 1000;
const VALID_CMDS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'jump', 'seek', 'volume']);
const ROOM_ID_RE = /^[A-Za-z0-9]{6}$/;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// CF-Connecting-IP is only meaningful when the request actually came through
// our local reverse proxy; a direct hit could forge it to mint fresh buckets
// and bypass the limiter entirely (and the room code is the auth model here).
const TRUSTED_PROXIES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const IP_SHAPE = /^[0-9a-fA-F:.]{3,45}$/;
const clientIp = (req) => {
  const peer = req.socket.remoteAddress || 'unknown';
  if (!TRUSTED_PROXIES.has(peer)) return peer;
  const fwd = req.headers['cf-connecting-ip'];
  return typeof fwd === 'string' && IP_SHAPE.test(fwd) ? fwd : peer;
};

// Global ceilings that hold even if per-IP identity is ever fooled again:
// room creation and room-code guessing (404s) must stay slow in absolute terms.
const GLOBAL_CAPS = { create: 30, miss: 60 };

export function createApp({ store, publicDir, titleLookup = fetchTitle }) {
  const hub = createHub();
  const buckets = new Map();
  const globalCounts = { create: 0, miss: 0, resetAt: 0 };

  function rateLimited(req, now = Date.now()) {
    const ip = clientIp(req);
    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + RATE_WINDOW_MS };
      buckets.set(ip, b);
      while (buckets.size > 10000) buckets.delete(buckets.keys().next().value);
    }
    b.count += 1;
    return b.count > RATE_LIMIT;
  }

  function globalLimited(kind, now = Date.now()) {
    if (globalCounts.resetAt <= now) { globalCounts.create = 0; globalCounts.miss = 0; globalCounts.resetAt = now + RATE_WINDOW_MS; }
    globalCounts[kind] += 1;
    return globalCounts[kind] > GLOBAL_CAPS[kind];
  }

  const send = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  const fail = (res, status, error) => send(res, status, { success: false, error });

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });

  // The two pages are tiny and immutable per deploy — serve from memory.
  const pageCache = new Map();
  const serveFile = (res, file) => {
    let data = pageCache.get(file);
    if (!data) {
      try { data = fs.readFileSync(path.join(publicDir, file)); pageCache.set(file, data); }
      catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  };

  const withNow = (state) => ({ ...state, now: Date.now() });

  const emit = (result, res) => {
    if (!result) return fail(res, 404, '房間不存在');
    if (result.error) return fail(res, 409, '動作無效');
    hub.broadcast(result.state.id, 'state', withNow(result.state));
    return send(res, 200, { success: true, data: result.state });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      // static
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html');
      if (req.method === 'GET' && /^\/r\/[A-Za-z0-9]{6}$/.test(p)) return serveFile(res, 'room.html');
      if (req.method === 'GET' && p === '/health') return send(res, 200, { success: true, time: Date.now() });

      if (rateLimited(req)) return fail(res, 429, '請求太頻繁，稍等一下');

      // API
      if (req.method === 'POST' && p === '/api/rooms') {
        if (globalLimited('create')) return fail(res, 429, '開房太頻繁，稍後再試');
        const body = await readBody(req).catch(() => null);
        if (body === null) return fail(res, 400, '格式錯誤');
        const name = String(body.name || '我們的歌單').slice(0, 100);
        const state = store.createRoom(name);
        return send(res, 200, { success: true, data: state });
      }

      const m = /^\/api\/rooms\/([A-Za-z0-9]{6})(\/.*)?$/.exec(p);
      if (m) {
        const roomId = m[1].toUpperCase();
        const rest = m[2] || '';
        if (!ROOM_ID_RE.test(roomId)) return fail(res, 400, '房號格式錯誤');

        if (req.method === 'GET' && rest === '') {
          const state = store.getRoom(roomId);
          if (!state && globalLimited('miss')) return fail(res, 429, '請求太頻繁');
          return state ? send(res, 200, { success: true, data: withNow(state) }) : fail(res, 404, '房間不存在');
        }
        if (req.method === 'GET' && rest === '/events') {
          const state = store.getRoom(roomId);
          if (!state) {
            if (globalLimited('miss')) return fail(res, 429, '請求太頻繁');
            return fail(res, 404, '房間不存在');
          }
          if (!hub.subscribe(roomId, res, withNow(state))) return fail(res, 503, '這個房間的連線已滿');
          return undefined;
        }
        if (req.method === 'POST' && rest === '/tracks') {
          const body = await readBody(req).catch(() => null);
          if (body === null) return fail(res, 400, '格式錯誤');
          const videoId = parseVideoId(body.url);
          if (!videoId) return fail(res, 400, '看不懂這個 YouTube 連結');
          const title = (typeof body.title === 'string' && body.title.trim().slice(0, 300)) || await titleLookup(videoId) || `YouTube ${videoId}`;
          return emit(store.addTrack(roomId, { videoId, title, addedBy: String(body.addedBy || '').slice(0, 50) }), res);
        }
        const trackOp = /^\/tracks\/([\w-]{1,40})\/(move|delete)$/.exec(rest);
        if (req.method === 'POST' && trackOp) {
          if (trackOp[2] === 'delete') return emit(store.removeTrack(roomId, trackOp[1]), res);
          const body = await readBody(req).catch(() => ({}));
          const dir = body.dir === 'up' ? 'up' : 'down';
          return emit(store.moveTrack(roomId, trackOp[1], dir), res);
        }
        if (req.method === 'POST' && rest === '/control') {
          const body = await readBody(req).catch(() => null);
          if (body === null || !VALID_CMDS.has(body.cmd)) return fail(res, 400, '未知指令');
          return emit(store.setControl(roomId, body.cmd, { trackId: body.trackId, position: body.position, volume: body.volume }), res);
        }
        if (req.method === 'POST' && rest === '/status') {
          const body = await readBody(req).catch(() => null);
          if (body === null) return fail(res, 400, '格式錯誤');
          const result = store.setStatus(roomId, body);
          if (!result) return fail(res, 404, '房間不存在');
          // Hot path: small dedicated event, not a full-queue state fanout.
          hub.broadcast(roomId, 'status', { status: result.status, now: Date.now() });
          return send(res, 200, { success: true, data: { status: result.status } });
        }
      }

      return fail(res, 404, 'Not found');
    } catch (err) {
      console.error('[tunebox] request failed:', err);
      if (!res.headersSent) return fail(res, 500, '伺服器錯誤');
      res.end();
    }
  });

  server.on('close', () => hub.close());
  return server;
}
