import { NextRequest, NextResponse } from 'next/server';

import { extractSongmid, getRequestedQualityFallbackChain, isMusicSource, lxPostJson, normalizeMusicQuality, normalizeSong } from '@/lib/music-v2';
import { badRequest } from '@/lib/music-v2-api';

export const runtime = 'nodejs';

const STREAM_URL_CACHE_TTL_MS = 30 * 1000;

type StreamUrlCacheValue = {
  url: string;
  quality: string;
  expiresAt: number;
};

type StreamUrlResolution = {
  url: string;
  quality: string;
};

const globalMusicStreamCache = globalThis as typeof globalThis & {
  __musicV2StreamUrlCache?: Map<string, StreamUrlCacheValue>;
  __musicV2StreamUrlInflight?: Map<string, Promise<StreamUrlResolution>>;
};

const streamUrlCache = globalMusicStreamCache.__musicV2StreamUrlCache ?? new Map<string, StreamUrlCacheValue>();
const streamUrlInflight = globalMusicStreamCache.__musicV2StreamUrlInflight ?? new Map<string, Promise<StreamUrlResolution>>();

globalMusicStreamCache.__musicV2StreamUrlCache = streamUrlCache;
globalMusicStreamCache.__musicV2StreamUrlInflight = streamUrlInflight;

function getStreamCacheKey(song: ReturnType<typeof normalizeSong>, quality: string) {
  return `${song.source}:${song.songId}:${quality}`;
}

function getCachedStreamUrl(cacheKey: string) {
  const cached = streamUrlCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    streamUrlCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function setCachedStreamUrl(cacheKey: string, url: string, quality: string) {
  streamUrlCache.set(cacheKey, {
    url,
    quality,
    expiresAt: Date.now() + STREAM_URL_CACHE_TTL_MS,
  });
}

async function resolveStreamUrl(
  song: ReturnType<typeof normalizeSong>,
  qualities: string[],
  cacheKey: string
) {
  const cached = getCachedStreamUrl(cacheKey);
  if (cached) return cached;

  const inflight = streamUrlInflight.get(cacheKey);
  if (inflight) return inflight;

  const resolverPromise = (async () => {
    let lastError = '获取音频流失败';

    for (const quality of qualities) {
      const urlResult = await lxPostJson<{ url?: string; type?: string; error?: string }>(
        '/api/music/url',
        {
          songInfo: {
            id: song.songId,
            name: song.name,
            singer: song.artist,
            source: song.source,
            songmid: extractSongmid(song),
            hash: song.hash,
            interval: song.durationText,
            copyrightId: song.copyrightId,
            albumId: song.albumId,
            lrcUrl: song.lrcUrl,
            mrcUrl: song.mrcUrl,
            trcUrl: song.trcUrl,
          },
          quality,
        },
        'auto'
      );

      const upstreamUrl = urlResult?.url;
      if (upstreamUrl) {
        const resolvedQuality = normalizeMusicQuality(urlResult?.type || quality);
        setCachedStreamUrl(cacheKey, upstreamUrl, resolvedQuality);
        return { url: upstreamUrl, quality: resolvedQuality };
      }

      if (urlResult?.error) lastError = urlResult.error;
    }

    throw new Error(lastError);
  })();

  streamUrlInflight.set(cacheKey, resolverPromise);

  try {
    return await resolverPromise;
  } finally {
    streamUrlInflight.delete(cacheKey);
  }
}

function buildUpstreamHeaders(request: NextRequest, upstreamUrl: string) {
  const headers = new Headers();
  headers.set(
    'User-Agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  );

  const range = request.headers.get('range');
  if (range) headers.set('Range', range);

  const url = new URL(upstreamUrl);
  const hostname = url.hostname.toLowerCase();

  if (hostname.includes('kuwo.cn')) {
    headers.set('Referer', 'http://www.kuwo.cn/');
    headers.set('Origin', 'http://www.kuwo.cn');
  } else if (hostname.includes('qqmusic.qq.com') || hostname === 'y.qq.com') {
    headers.set('Referer', 'https://y.qq.com/');
    headers.set('Origin', 'https://y.qq.com');
  } else if (hostname.includes('music.163.com')) {
    headers.set('Referer', 'https://music.163.com/');
    headers.set('Origin', 'https://music.163.com');
  }

  return headers;
}

function inferAudioContentType(upstreamUrl: string, upstreamContentType: string | null, requestedQuality: string) {
  const pathname = new URL(upstreamUrl).pathname.toLowerCase();

  if (pathname.endsWith('.flac') || requestedQuality === 'flac' || requestedQuality === 'flac24bit') {
    return 'audio/flac';
  }
  if (pathname.endsWith('.m4a') || pathname.endsWith('.mp4')) {
    return 'audio/mp4';
  }
  if (pathname.endsWith('.aac')) {
    return 'audio/aac';
  }
  if (pathname.endsWith('.ogg') || pathname.endsWith('.opus')) {
    return 'audio/ogg';
  }
  if (pathname.endsWith('.wav')) {
    return 'audio/wav';
  }
  if (pathname.endsWith('.mp3')) {
    return 'audio/mpeg';
  }

  return upstreamContentType || 'audio/mpeg';
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') || '';
    const songId = searchParams.get('songId') || '';
    const requestedQuality = normalizeMusicQuality(searchParams.get('quality') || 'flac24bit');

    if (!isMusicSource(source)) return badRequest('不支持的音源');
    if (!songId) return badRequest('缺少歌曲ID');

    const song = normalizeSong({
      songId,
      source,
      songmid: searchParams.get('songmid') || undefined,
      name: searchParams.get('name') || '',
      artist: searchParams.get('artist') || '',
      durationText: searchParams.get('durationText') || undefined,
      hash: searchParams.get('hash') || undefined,
      copyrightId: searchParams.get('copyrightId') || undefined,
      albumId: searchParams.get('albumId') || undefined,
      lrcUrl: searchParams.get('lrcUrl') || undefined,
      mrcUrl: searchParams.get('mrcUrl') || undefined,
      trcUrl: searchParams.get('trcUrl') || undefined,
    });

    const cacheKey = getStreamCacheKey(song, requestedQuality);
    const candidateQualities = getRequestedQualityFallbackChain(requestedQuality);
    let streamResolution = await resolveStreamUrl(song, candidateQualities, cacheKey);
    let upstreamUrl = streamResolution.url;
    let actualQuality = streamResolution.quality;
    let upstreamHeaders = buildUpstreamHeaders(request, upstreamUrl);

    const fetchUpstream = (url: string, headers: Headers) => fetch(url, {
      headers,
      signal: AbortSignal.timeout(90000),
      cache: 'no-store',
    });

    let upstream: Response;
    try {
      upstream = await fetchUpstream(upstreamUrl, upstreamHeaders);
    } catch (error) {
      streamUrlCache.delete(cacheKey);
      streamResolution = await resolveStreamUrl(song, candidateQualities, cacheKey);
      upstreamUrl = streamResolution.url;
      actualQuality = streamResolution.quality;
      upstreamHeaders = buildUpstreamHeaders(request, upstreamUrl);
      upstream = await fetchUpstream(upstreamUrl, upstreamHeaders);
      console.warn('[music-v2/stream] upstream fetch failed once, retried with refreshed URL', {
        source,
        songId,
        quality: requestedQuality,
        actualQuality,
        range: request.headers.get('range'),
        reason: (error as Error).message,
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      if ([401, 403, 404, 410, 416].includes(upstream.status)) {
        streamUrlCache.delete(cacheKey);
        streamResolution = await resolveStreamUrl(song, candidateQualities, cacheKey);
        upstreamUrl = streamResolution.url;
        actualQuality = streamResolution.quality;
        upstreamHeaders = buildUpstreamHeaders(request, upstreamUrl);
        upstream = await fetchUpstream(upstreamUrl, upstreamHeaders);
      }

      if (!upstream.ok && upstream.status !== 206) {
        return NextResponse.json({ success: false, error: { code: 'STREAM_FAILED', message: '获取音频流失败' } }, { status: upstream.status });
      }
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', inferAudioContentType(upstreamUrl, upstream.headers.get('content-type'), actualQuality));
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('Pragma', 'no-cache');
    responseHeaders.set('Expires', '0');
    responseHeaders.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    const copyHeaders = ['content-length', 'content-range', 'etag', 'last-modified'];
    for (const header of copyHeaders) {
      const value = upstream.headers.get(header);
      if (value) responseHeaders.set(header, value);
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: { code: 'STREAM_FAILED', message: (error as Error).message } }, { status: 400 });
  }
}
