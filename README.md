# tunebox

Room-based shared YouTube jukebox. One phone acts as the player (hook it to a Bluetooth speaker), everyone else with the 6-char room code edits the queue and remote-controls playback (play/pause/next/prev/jump) in real time over SSE.

Zero dependencies — Node 22 (`node:http` + `node:sqlite`). No accounts; the unguessable room code is the capability. Rooms idle for 30 days are purged.

## Run

```bash
npm start   # PORT (default 8789), DB_PATH env
npm test
```
