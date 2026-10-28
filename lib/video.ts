import { extractTikTokUrl } from './tiktok.ts';

export type VideoPlatform = 'tiktok' | 'youtube' | 'instagram';
const YOUTUBE = new Set(['youtube.com','www.youtube.com','m.youtube.com']);
const SHORT_YOUTUBE = new Set(['youtu.be','www.youtu.be']);
const INSTAGRAM = new Set(['instagram.com','www.instagram.com','m.instagram.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Exact video URLs only: no profiles, playlists, arbitrary hosts or redirects. */
export function extractVideoUrl(text:string):string|null {
  if(typeof text!=='string'||!text||text.length>12000)return null;
  for(const raw of text.match(/https:\/\/[^\s<>"']+/gi)??[]) {
    if(raw.length>2048||/(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|[?#]|$)/i.test(raw))continue;
    const candidate=raw.replace(/[.,;:!?\)\]\}，。！？…]+$/,'');
    if(!/^https:\/\/[^\/?#@\\]+(?:[\/?#]|$)/i.test(candidate)||/[\u0000-\u0020\u007f\\]/.test(candidate)||/%(?![0-9a-f]{2})/i.test(candidate))continue;
    const tiktok=extractTikTokUrl(candidate);
    if(tiktok)return tiktok;
    try {
      const url=new URL(candidate);
      if(url.protocol!=='https:'||url.username||url.password||url.port)continue;
      const host=url.hostname.toLowerCase();
      if(YOUTUBE.has(host)||SHORT_YOUTUBE.has(host)) {
        let id:string|null=null;
        if(SHORT_YOUTUBE.has(host))id=url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1]??null;
        else if(/^\/watch\/?$/.test(url.pathname)&&url.searchParams.getAll('v').length===1)id=url.searchParams.get('v');
        else id=url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/)?.[1]??null;
        if(id&&VIDEO_ID.test(id))return `https://www.youtube.com/watch?v=${id}`;
      }
      if(INSTAGRAM.has(host)) {
        const match=url.pathname.match(/^\/(reel|reels|p)\/([A-Za-z0-9_-]{5,64})\/?$/);
        if(match)return `https://www.instagram.com/${match[1]==='p'?'p':'reel'}/${match[2]}/`;
      }
    } catch { /* Try the next shared URL. */ }
  }
  return null;
}

export function platformForUrl(value:string):VideoPlatform|null {
  const normalized=extractVideoUrl(value);if(!normalized)return null;
  const host=new URL(normalized).hostname;
  if(YOUTUBE.has(host)||SHORT_YOUTUBE.has(host))return 'youtube';
  if(INSTAGRAM.has(host))return 'instagram';
  return 'tiktok';
}
