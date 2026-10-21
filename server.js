// tunebox — shared YouTube jukebox. One phone plays (Bluetooth speaker),
// everyone with the room code edits the queue and remote-controls playback.
// Env: PORT, DB_PATH
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { createApp } from './lib/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fine */ }

const PORT = Number(process.env.PORT) || 8789;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tunebox.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const store = createStore(DB_PATH);
const server = createApp({ store, publicDir: path.join(__dirname, 'public') });

const purged = store.purge();
if (purged) console.error(`[tunebox] purged ${purged} idle rooms`);
setInterval(() => store.purge(), 24 * 60 * 60 * 1000).unref();

server.listen(PORT, () => console.error(`[tunebox] listening on :${PORT}`));

const shutdown = () => {
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
