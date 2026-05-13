#!/usr/bin/env node

// ============================================================================
// Follow Builders — User Sources Fetcher
// ============================================================================
// Fetches YouTube channels and RSS feeds from the user's personal source list.
// No API keys required. Uses the same YouTube Atom feed approach as
// generate-feed.js. Output JSON is merged by prepare-user-digest.js.
//
// Usage: node fetch-user-sources.js
// Output: JSON to stdout
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR    = process.env.DATA_DIR || join(homedir(), '.follow-builders');
const SOURCES_PATH = join(USER_DIR, 'user-sources.json');
const STATE_PATH   = join(USER_DIR, 'state-user.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LOOKBACK_HOURS = 72;  // 3-day window — generous for weekly/biweekly sources
const MAX_ITEMS = 2;         // new items per source per run (avoids flooding the digest)

// ── State management ──────────────────────────────────────────────────────────

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seen: {} };
  try { return JSON.parse(await readFile(STATE_PATH, 'utf-8')); }
  catch { return { seen: {} }; }
}

async function saveState(state) {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(state.seen)) {
    if (v < cutoff) delete state.seen[k];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── RSS parsing ───────────────────────────────────────────────────────────────

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const title = (
      b.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
      b.match(/<title>([\s\S]*?)<\/title>/)
    )?.[1]?.trim() || 'Untitled';

    const guid = (
      b.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) ||
      b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)
    )?.[1]?.trim();

    const pub  = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    const link = b.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();

    // Prefer itunes:summary for podcasts, fall back to description
    const desc = (
      b.match(/<itunes:summary><!\[CDATA\[([\s\S]*?)\]\]><\/itunes:summary>/) ||
      b.match(/<itunes:subtitle><!\[CDATA\[([\s\S]*?)\]\]><\/itunes:subtitle>/) ||
      b.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
      b.match(/<description>([\s\S]*?)<\/description>/)
    )?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) || '';

    const id = guid || link;
    if (id) items.push({
      title,
      id,
      publishedAt: pub ? (() => { try { return new Date(pub).toISOString(); } catch { return null; } })() : null,
      url: link || '',
      description: desc,
    });
  }
  return items;
}

// ── YouTube Atom feed ─────────────────────────────────────────────────────────

async function resolveYouTubeFeedUrl(channelUrl) {
  // Playlist URLs
  const playlistM = channelUrl.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (playlistM) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistM[1]}`;

  // /channel/UCxxx URLs (direct)
  const ucM = channelUrl.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
  if (ucM) return `https://www.youtube.com/feeds/videos.xml?channel_id=${ucM[1]}`;

  // /c/name or /@handle — need to fetch the page to get the channel ID
  if (channelUrl.includes('youtube.com')) {
    try {
      const res = await fetch(channelUrl, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      const idM = html.match(/"channelId":"(UC[A-Za-z0-9_-]{20,})"/) ||
                  html.match(/<meta\s+itemprop="(?:identifier|channelId)"\s+content="(UC[A-Za-z0-9_-]{20,})"/);
      return idM ? `https://www.youtube.com/feeds/videos.xml?channel_id=${idM[1]}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseYouTubeAtom(xml) {
  const items = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const title    = b.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const videoId  = b.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/)?.[1]?.trim();
    const published = b.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim();
    const desc     = b.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]?.trim().slice(0, 400) || '';
    if (title && videoId) {
      items.push({
        title,
        id: videoId,
        publishedAt: published || null,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        description: desc,
      });
    }
  }
  return items;
}

async function fetchYouTube(source, state, cutoff) {
  try {
    const feedUrl = await resolveYouTubeFeedUrl(source.url);
    if (!feedUrl) {
      return { source: 'youtube', name: source.name, category: source.category || '', url: source.url, items: [], error: 'Could not resolve YouTube feed URL' };
    }

    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { source: 'youtube', name: source.name, category: source.category || '', url: source.url, items: [], error: `HTTP ${res.status}` };
    }

    const videos = parseYouTubeAtom(await res.text());
    const items = [];
    for (const v of videos) {
      if (state.seen[v.id]) continue;
      if (v.publishedAt && new Date(v.publishedAt) < cutoff) continue;
      items.push(v);
      state.seen[v.id] = Date.now();
      if (items.length >= MAX_ITEMS) break;
    }
    return { source: 'youtube', name: source.name, category: source.category || '', url: source.url, items };
  } catch (err) {
    return { source: 'youtube', name: source.name, category: source.category || '', url: source.url, items: [], error: err.message };
  }
}

async function fetchRss(source, state, cutoff) {
  try {
    const res = await fetch(source.rss, {
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      return { source: source.type || 'podcast_rss', name: source.name, category: source.category || '', url: source.url || source.rss, items: [], error: `HTTP ${res.status}` };
    }

    const parsed = parseRss(await res.text());
    const items = [];
    for (const p of parsed) {
      if (state.seen[p.id]) continue;
      if (p.publishedAt && new Date(p.publishedAt) < cutoff) continue;
      items.push({ title: p.title, url: p.url, publishedAt: p.publishedAt, description: p.description });
      state.seen[p.id] = Date.now();
      if (items.length >= MAX_ITEMS) break;
    }
    return { source: source.type || 'podcast_rss', name: source.name, category: source.category || '', url: source.url || source.rss, items };
  } catch (err) {
    return { source: source.type || 'podcast_rss', name: source.name, category: source.category || '', url: source.url || source.rss, items: [], error: err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(SOURCES_PATH)) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      youtube: [], rss: [],
      stats: { youtubeSources: 0, rssSources: 0, totalItems: 0 },
      errors: ['No user-sources.json found at ' + SOURCES_PATH],
    }));
    return;
  }

  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf-8'));
  const state   = await loadState();
  const cutoff  = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);

  // Fetch all in parallel — no API rate limits, just RSS + YouTube Atom
  const [ytResults, rssResults] = await Promise.all([
    Promise.all((sources.youtube || []).map(s => fetchYouTube(s, state, cutoff))),
    Promise.all((sources.rss     || []).map(s => fetchRss(s, state, cutoff))),
  ]);

  await saveState(state);

  const errors = [
    ...ytResults.filter(r => r.error).map(r => `YouTube:${r.name}: ${r.error}`),
    ...rssResults.filter(r => r.error).map(r => `RSS:${r.name}: ${r.error}`),
  ];

  const ytWithItems  = ytResults.filter(r => r.items?.length > 0);
  const rssWithItems = rssResults.filter(r => r.items?.length > 0);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    youtube: ytWithItems,
    rss: rssWithItems,
    stats: {
      youtubeSources: ytWithItems.length,
      rssSources: rssWithItems.length,
      totalItems: [...ytResults, ...rssResults].reduce((s, r) => s + (r.items?.length || 0), 0),
    },
    errors: errors.length > 0 ? errors : undefined,
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
