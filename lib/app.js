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
const VALID_CMDS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'jump']);
const ROOM_ID_RE = /^[A-Za-z0-9]{6}$/;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createApp({ store, publicDir, titleLookup = fetchTitle }) {
  const hub = createHub();
  const buckets = new Map();

  function rateLimited(req, now = Date.now()) {
    const ip = (typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip']) || req.socket.remoteAddress || 'unknown';
    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + RATE_WINDOW_MS };
      buckets.set(ip, b);
      while (buckets.size > 10000) buckets.delete(buckets.keys().next().value);
    }
    b.count += 1;
    return b.count > RATE_LIMIT;
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

  const serveFile = (res, file) => {
    const full = path.join(publicDir, file);
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  };

  const emit = (result, res) => {
    if (!result) return fail(res, 404, '房間不存在');
    if (result.error) return fail(res, 409, '動作無效');
    hub.broadcast(result.state.id, result.state);
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
          return state ? send(res, 200, { success: true, data: state }) : fail(res, 404, '房間不存在');
        }
        if (req.method === 'GET' && rest === '/events') {
          const state = store.getRoom(roomId);
          if (!state) return fail(res, 404, '房間不存在');
          return hub.subscribe(roomId, res, state);
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
          return emit(store.setControl(roomId, body.cmd, { trackId: body.trackId }), res);
        }
        if (req.method === 'POST' && rest === '/status') {
          const body = await readBody(req).catch(() => null);
          if (body === null) return fail(res, 400, '格式錯誤');
          return emit(store.setStatus(roomId, body), res);
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
