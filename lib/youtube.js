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
