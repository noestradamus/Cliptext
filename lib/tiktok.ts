const ALLOWED = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com']);

/** Extract only actual TikTok video/photo/share URLs; never accept arbitrary fetch targets. */
export function extractTikTokUrl(text: string): string | null {
  if (!text || text.length > 12000) return null;
  const candidates = text.match(/https:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of candidates) {
    if (raw.length > 2048 || /(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|[?#]|$)/i.test(raw)) continue;
    const candidate = raw.replace(/[.,;:!?\)\]\}，。！？…]+$/, '');
    if (!/^https:\/\/[^\/?#@\\]+(?:[\/?#]|$)/i.test(candidate) || /[\u0000-\u0020\u007f\\]/.test(candidate) || /%(?![0-9a-f]{2})/i.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' || !ALLOWED.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) continue;
      if (url.hostname === 'vt.tiktok.com' || url.hostname === 'vm.tiktok.com') {
        if (!/^\/[A-Za-z0-9_-]{4,80}\/?$/.test(url.pathname)) continue;
      } else if (!/^\/@[^/]+\/(?:video|photo)\/\d{10,25}\/?$/.test(url.pathname) && !/^\/t\/[A-Za-z0-9_-]{4,80}\/?$/.test(url.pathname)) continue;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { /* Ignore non-URLs and continue to the next shared token. */ }
  }
  return null;
}
