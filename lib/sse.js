// Per-room SSE subscriber registry. Queue/control changes broadcast the full
// room state; the hot player-status path broadcasts a small `status` event.
// Dead phones (vanished without FIN) are reaped by buffer checks, TCP
// keepalive, and a max stream life — EventSource reconnects on its own.

const HEARTBEAT_MS = 25000;            // keeps the reverse proxy's 300s idle reaper away
const MAX_SUBS_PER_ROOM = 24;
const MAX_BUFFERED = 1 << 20;          // 1 MB queued => client stopped reading, stop paying for it
const MAX_STREAM_LIFE_MS = 30 * 60 * 1000;

export function createHub() {
  const rooms = new Map(); // roomId -> Set<res>

  const drop = (subs, res) => {
    subs.delete(res);
    res.destroy();
  };

  const safeWrite = (subs, res, chunk) => {
    if (res.writableEnded || res.destroyed || res.writableLength > MAX_BUFFERED) { drop(subs, res); return; }
    res.write(chunk);
  };

  const heartbeat = setInterval(() => {
    for (const subs of rooms.values()) {
      for (const res of [...subs]) safeWrite(subs, res, ':hb\n\n');
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // -> false when the room is full (caller responds 503)
  function subscribe(roomId, res, initialState) {
    let subs = rooms.get(roomId);
    if (subs && subs.size >= MAX_SUBS_PER_ROOM) return false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: state\ndata: ${JSON.stringify(initialState)}\n\n`);
    if (!subs) { subs = new Set(); rooms.set(roomId, subs); }
    subs.add(res);
    res.socket?.setKeepAlive(true, 30000);
    res.socket?.setTimeout(0);
    const maxLife = setTimeout(() => res.end(), MAX_STREAM_LIFE_MS);
    maxLife.unref();
    const cleanup = () => {
      clearTimeout(maxLife);
      subs.delete(res);
      if (subs.size === 0) rooms.delete(roomId);
    };
    res.on('close', cleanup);
    res.on('error', () => { cleanup(); res.destroy(); });
    return true;
  }

  function broadcast(roomId, event, data) {
    const subs = rooms.get(roomId);
    if (!subs) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...subs]) safeWrite(subs, res, frame);
  }

  const close = () => {
    clearInterval(heartbeat);
    for (const subs of rooms.values()) for (const res of subs) res.end();
    rooms.clear();
  };

  return { subscribe, broadcast, close };
}
