// Room storage (node:sqlite). A room is a shared queue + the latest remote
// command + the player phone's reported status. Every mutation bumps `version`
// so SSE clients can ignore stale snapshots.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_TRACKS = 500;
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // rooms idle for 30 days are purged

// No confusable chars (0/O, 1/I/L) — codes get read out loud between phones.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newRoomId = () => {
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
};
const newTrackId = () => `t_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

export function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rooms (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      queue      TEXT NOT NULL,
      control    TEXT,
      status     TEXT,
      version    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const getStmt = db.prepare('SELECT * FROM rooms WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO rooms (id, name, queue, version, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
  const updateStmt = db.prepare('UPDATE rooms SET queue = ?, control = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?');
  const purgeStmt = db.prepare('DELETE FROM rooms WHERE updated_at < ?');

  const toState = (row) => ({
    id: row.id,
    name: row.name,
    queue: JSON.parse(row.queue),
    control: row.control ? JSON.parse(row.control) : null,
    status: row.status ? JSON.parse(row.status) : null,
    version: row.version
  });

  function createRoom(name, now = Date.now()) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = newRoomId();
      try {
        insertStmt.run(id, name, '[]', now, now);
        return toState(getStmt.get(id));
      } catch {
        // id collision (astronomically rare) — retry with a new code
      }
    }
    throw new Error('could not allocate room id');
  }

  const getRoom = (id) => {
    const row = getStmt.get(String(id || '').toUpperCase());
    return row ? toState(row) : null;
  };

  // Apply `fn(state)` (mutating queue/control/status in place) and persist.
  function mutate(id, fn, now = Date.now()) {
    const state = getRoom(id);
    if (!state) return null;
    const out = fn(state);
    if (out === false) return { state, error: 'rejected' };
    updateStmt.run(JSON.stringify(state.queue), state.control ? JSON.stringify(state.control) : null,
      state.status ? JSON.stringify(state.status) : null, now, state.id);
    return { state: toState(getStmt.get(state.id)) };
  }

  function addTrack(id, { videoId, title, addedBy }, now = Date.now()) {
    return mutate(id, (s) => {
      if (s.queue.length >= MAX_TRACKS) return false;
      s.queue = [...s.queue, { id: newTrackId(), videoId, title, addedBy: addedBy || null, addedAt: now }];
    }, now);
  }

  const removeTrack = (id, trackId) => mutate(id, (s) => {
    const next = s.queue.filter((t) => t.id !== trackId);
    if (next.length === s.queue.length) return false;
    s.queue = next;
  });

  const moveTrack = (id, trackId, dir) => mutate(id, (s) => {
    const i = s.queue.findIndex((t) => t.id === trackId);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= s.queue.length) return false;
    const next = [...s.queue];
    [next[i], next[j]] = [next[j], next[i]];
    s.queue = next;
  });

  // Remote command for the player phone. seq makes each command fire once.
  const setControl = (id, cmd, args = {}, now = Date.now()) => mutate(id, (s) => {
    s.control = {
      seq: (s.control?.seq || 0) + 1,
      cmd,
      trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
      issuedAt: now
    };
  }, now);

  // Player phone heartbeat: what's playing right now.
  const setStatus = (id, status, now = Date.now()) => mutate(id, (s) => {
    s.status = {
      trackId: typeof status.trackId === 'string' ? status.trackId : null,
      title: typeof status.title === 'string' ? status.title.slice(0, 300) : null,
      position: Number.isFinite(status.position) ? status.position : 0,
      duration: Number.isFinite(status.duration) ? status.duration : 0,
      paused: !!status.paused,
      updatedAt: now
    };
  }, now);

  const purge = (now = Date.now()) => purgeStmt.run(now - ROOM_TTL_MS).changes;

  return { createRoom, getRoom, addTrack, removeTrack, moveTrack, setControl, setStatus, purge, close: () => db.close() };
}
