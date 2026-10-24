// YouTube URL parsing + title lookup (oEmbed, no API key).

const ID_RE = /^[\w-]{11}$/;

// watch?v=ID, youtu.be/ID, shorts/ID, embed/ID, music.youtube.com/watch?v=ID
export function parseVideoId(raw) {
  const s = String(raw || '').trim();
  if (ID_RE.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:[/?]|$)/.exec(url.pathname);
    if (m) return m[1];
  }
  return null;
}

// --- external music links (Spotify / Apple Music) -> text query -------------

// -> { type: 'spotify', url } | { type: 'apple', id } | null
export function parseExternalLink(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'open.spotify.com' && /^\/(intl-[a-z-]+\/)?(track|album|episode)\//.test(url.pathname)) {
    return { type: 'spotify', url: url.origin + url.pathname };
  }
  if (host === 'music.apple.com' || host === 'itunes.apple.com') {
    const i = url.searchParams.get('i');
    if (i && /^\d+$/.test(i)) return { type: 'apple', id: i };
    const m = /\/(?:song|album)\/[^/]+\/(\d+)/.exec(url.pathname);
    if (m) return { type: 'apple', id: m[1] };
  }
  return null;
}

// Resolve a Spotify/Apple link to "title artist" via their keyless public APIs.
export async function resolveExternalQuery(ext, { fetchImpl = fetch } = {}) {
  try {
    if (ext.type === 'spotify') {
      const res = await fetchImpl(`https://open.spotify.com/oembed?url=${encodeURIComponent(ext.url)}`,
        { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body?.title === 'string' && body.title ? body.title.slice(0, 200) : null;
    }
    if (ext.type === 'apple') {
      const res = await fetchImpl(`https://itunes.apple.com/lookup?id=${ext.id}`,
        { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const body = await res.json();
      const r = body?.results?.[0];
      if (!r) return null;
      const q = [r.trackName || r.collectionName, r.artistName].filter(Boolean).join(' ');
      return q ? q.slice(0, 200) : null;
    }
  } catch { /* network/timeout */ }
  return null;
}

// --- YouTube search (scrapes the results page; no API key, no quota) ---------

const walkForVideos = (node, out) => {
  if (!node || typeof node !== 'object' || out.length >= 12) return;
  if (node.videoRenderer?.videoId) {
    const v = node.videoRenderer;
    out.push({
      videoId: v.videoId,
      title: (v.title?.runs?.map((r) => r.text).join('') || '').slice(0, 300),
      channel: (v.ownerText?.runs?.[0]?.text || '').slice(0, 100),
      duration: v.lengthText?.simpleText || '',
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`
    });
    return;
  }
  for (const key of Object.keys(node)) walkForVideos(node[key], out);
};

// Extract the balanced JSON object that follows `ytInitialData =` in the page.
const extractInitialData = (html) => {
  const at = html.indexOf('ytInitialData');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
};

export async function searchYouTube(query, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=zh-TW`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        Cookie: 'CONSENT=YES+1'
      },
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!res.ok) return null;
  const data = extractInitialData(await res.text());
  if (!data) return null;
  const out = [];
  walkForVideos(data, out);
  return out;
}

export async function fetchTitle(videoId, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.title === 'string' ? body.title.slice(0, 300) : null;
  } catch {
    return null;
  }
}
