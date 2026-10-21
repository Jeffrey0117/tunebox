// Per-room SSE subscriber registry. Every mutation broadcasts the full room
// state (rooms are tiny); a heartbeat keeps proxies from reaping idle streams.

const HEARTBEAT_MS = 25000;

export function createHub() {
  const rooms = new Map(); // roomId -> Set<res>

  const heartbeat = setInterval(() => {
    for (const subs of rooms.values()) {
      for (const res of subs) res.write(':hb\n\n');
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function subscribe(roomId, res, initialState) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: state\ndata: ${JSON.stringify(initialState)}\n\n`);
    let subs = rooms.get(roomId);
    if (!subs) { subs = new Set(); rooms.set(roomId, subs); }
    subs.add(res);
    res.on('close', () => {
      subs.delete(res);
      if (subs.size === 0) rooms.delete(roomId);
    });
  }

  function broadcast(roomId, state) {
    const subs = rooms.get(roomId);
    if (!subs) return;
    const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of subs) res.write(frame);
  }

  const close = () => {
    clearInterval(heartbeat);
    for (const subs of rooms.values()) for (const res of subs) res.end();
    rooms.clear();
  };

  return { subscribe, broadcast, close };
}
