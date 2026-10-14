import { config } from "../config.js";
import { getCache, getLatestSnapshot, markSnapshotUndone, setCache } from "../db.js";
import type Database from "better-sqlite3";
import type { ToolCallRequest } from "../protocol.js";
import sharp from "sharp";

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  code?: string;
}

export interface ServerToolContext {
  db: Database.Database;
  requestClientTool: (call: ToolCallRequest) => Promise<{ ok: boolean; data?: unknown; code?: string }>;
}

interface SearxngResult {
  title: string;
  url: string;
  content?: string;
}

export async function webSearch(q: string, categories = "general", timeRange?: string): Promise<ToolResult> {
  try {
    const url = new URL("/search", config.searxngUrl);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", categories);
    if (timeRange) url.searchParams.set("time_range", timeRange);
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, code: `searxng_http_${res.status}` };
    const body = (await res.json()) as { results?: SearxngResult[] };
    const results = (body.results ?? []).slice(0, 8).map((r) => ({ title: r.title, url: r.url, content: r.content ?? "" }));
    return { ok: true, data: { query: q, results } };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "searxng_error" };
  }
}

export async function lyricsLookup(
  artist: string,
  title: string,
  album?: string,
  durationMs?: number
): Promise<ToolResult> {
  const cleanTitle = title.replace(/-\s+(feat|with|prod).*/i, "").trim();

  const lrclib = await fetchLyricsLrclib(artist, cleanTitle, album, durationMs);
  if (lrclib.ok) return lrclib;

  const ovh = await fetchLyricsOvh(artist, cleanTitle);
  if (ovh.ok) return ovh;

  return { ok: false, code: "lyrics_not_found" };
}

async function fetchLyricsLrclib(artist: string, title: string, album?: string, durationMs?: number): Promise<ToolResult> {
  try {
    const url = new URL("/api/get", "https://lrclib.net");
    url.searchParams.set("artist_name", artist);
    url.searchParams.set("track_name", title);
    if (album) url.searchParams.set("album_name", album);
    if (durationMs) url.searchParams.set("duration", String(Math.round(durationMs / 1000)));
    const res = await fetch(url, {
      headers: { "x-user-agent": "euterpe (https://github.com/local/euterpe)" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { ok: false, code: "lrclib_404" };
    if (!res.ok) return { ok: false, code: `lrclib_http_${res.status}` };
    const body = (await res.json()) as { instrumental?: boolean; plainLyrics?: string; syncedLyrics?: string };
    if (body.instrumental) return { ok: false, code: "instrumental" };
    const text = body.plainLyrics ?? body.syncedLyrics;
    if (!text) return { ok: false, code: "lrclib_empty" };
    return { ok: true, data: { source: "lrclib", text: text.slice(0, 8000) } };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "lrclib_error" };
  }
}

async function fetchLyricsOvh(artist: string, title: string): Promise<ToolResult> {
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return { ok: false, code: "ovh_404" };
    if (!res.ok) return { ok: false, code: `ovh_http_${res.status}` };
    const body = (await res.json()) as { lyrics?: string };
    if (!body.lyrics) return { ok: false, code: "ovh_empty" };
    return { ok: true, data: { source: "ovh", text: body.lyrics.slice(0, 8000) } };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "ovh_error" };
  }
}

export async function similarArtists(artist: string, limit = 10): Promise<ToolResult> {
  const sources: Record<string, string[]> = {};

  const deezer = await similarFromDeezer(artist, limit);
  if (deezer.ok) sources.deezer = deezer.data as string[];

  if (config.lastfmApiKey) {
    const lastfm = await similarFromLastfm(artist, limit);
    if (lastfm.ok) sources.lastfm = lastfm.data as string[];
  }

  const keys = Object.keys(sources);
  if (!keys.length) return { ok: false, code: "no_similar_source" };

  const ranked = new Map<string, { name: string; sources: string[] }>();
  for (const [src, names] of Object.entries(sources)) {
    names.forEach((name, idx) => {
      const cur = ranked.get(name) ?? { name, sources: [] };
      cur.sources.push(src);
      ranked.set(name, cur);
    });
  }
  const list = [...ranked.values()]
    .sort((a, b) => b.sources.length - a.sources.length)
    .slice(0, limit)
    .map((a) => ({ name: a.name, sources: a.sources }));
  return { ok: true, data: { artist, similar: list } };
}

async function similarFromDeezer(artist: string, limit: number): Promise<ToolResult> {
  try {
    const search = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(artist)}&limit=1`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!search.ok) return { ok: false, code: "deezer_search" };
    const found = (await search.json()) as { data?: { id: number }[] };
    if (!found.data?.length) return { ok: false, code: "deezer_not_found" };
    const id = found.data[0].id;
    const rel = await fetch(`https://api.deezer.com/artist/${id}/related?limit=${limit}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!rel.ok) return { ok: false, code: "deezer_related" };
    const body = (await rel.json()) as { data?: { name: string }[] };
    const names = (body.data ?? []).map((a) => a.name);
    return { ok: true, data: names };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "deezer_error" };
  }
}

export async function artistInfo(artist: string, limit = 10): Promise<ToolResult> {
  if (config.lastfmApiKey) {
    const lastfm = await fetchLastfmArtistInfo(artist, limit);
    if (lastfm.ok) return lastfm;
  }
  const search = await webSearch(`${artist} artist biography`, "music");
  if (!search.ok) return { ok: false, code: "artist_info_unavailable" };
  const results = (search.data as { results?: { title?: string; url?: string; content?: string }[] })?.results ?? [];
  return {
    ok: true,
    data: {
      source: "web_search",
      artist,
      bio: results[0]?.content ?? results[0]?.title ?? null,
      links: results.slice(0, 5).map((r) => ({ title: r.title, url: r.url })),
    },
  };
}

async function fetchLastfmArtistInfo(artist: string, limit = 10): Promise<ToolResult> {
  try {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.searchParams.set("method", "artist.getinfo");
    url.searchParams.set("artist", artist);
    url.searchParams.set("api_key", config.lastfmApiKey!);
    url.searchParams.set("format", "json");
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { ok: false, code: `lastfm_info_http_${res.status}` };
    const body = (await res.json()) as {
      artist?: {
        name?: string;
        bio?: { summary?: string; content?: string };
        tags?: { tag?: { name?: string }[] };
        similar?: { artist?: { name?: string; match?: string }[] };
      };
    };
    const a = body.artist;
    if (!a?.name) return { ok: false, code: "lastfm_info_not_found" };
    const summary = (a.bio?.summary ?? "").replace(/<[^>]+>/g, "").trim();
    return {
      ok: true,
      data: {
        source: "lastfm",
        artist: a.name,
        bio: summary || null,
        tags: (a.tags?.tag ?? []).map((t) => t.name).slice(0, 15),
        similar: (a.similar?.artist ?? [])
          .filter((s) => Number(s.match) >= 0.1)
          .slice(0, limit)
          .map((s) => s.name),
      },
    };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "lastfm_info_error" };
  }
}

async function similarFromLastfm(artist: string, limit: number): Promise<ToolResult> {
  try {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.searchParams.set("method", "artist.getsimilar");
    url.searchParams.set("artist", artist);
    url.searchParams.set("api_key", config.lastfmApiKey!);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { ok: false, code: "lastfm_http" };
    const body = (await res.json()) as { similarartists?: { artist?: { name: string; match?: string }[] } };
    const list = (body.similarartists?.artist ?? [])
      .filter((a) => Number(a.match) >= 0.1)
      .slice(0, limit)
      .map((a) => a.name);
    return list.length ? { ok: true, data: list } : { ok: false, code: "lastfm_empty" };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "lastfm_error" };
  }
}

function chunk(list: unknown[], size: number): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

interface ChartEntry {
  trackMetadata: {
    trackName: string;
    trackUri: string;
  };
  chartEntryData: {
    currentRank?: number;
  };
}

async function getCharts(db: Database.Database, region: string): Promise<ChartEntry[] | null> {
  const cacheKey = `charts:${region}`;
  const cached = getCache(db, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ChartEntry[];
    } catch {}
  }
  try {
    const url = new URL("https://charts-spotify-com-service.spotify.com/public/v0/charts");
    url.searchParams.set("region", region);
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { entries?: ChartEntry[] };
    const entries = body.entries ?? [];
    setCache(db, cacheKey, JSON.stringify(entries), 6 * 3600_000);
    return entries;
  } catch {
    return null;
  }
}

export async function chartLookup(db: Database.Database, uris: string[], region = "global"): Promise<ToolResult> {
  const entries = await getCharts(db, region);
  if (!entries) return { ok: false, code: "charts_unavailable" };
  const rankByUri = new Map<string, number>();
  for (const e of entries) {
    const uri = e.trackMetadata?.trackUri;
    const rank = e.chartEntryData?.currentRank;
    if (uri && rank) rankByUri.set(uri, rank);
  }
  const matches = uris
    .map((uri) => ({ uri, position: rankByUri.get(uri) ?? null }))
    .filter((m) => m.position !== null);
  return { ok: true, data: { region, matches } };
}

export async function enrichTracks(ids: string[], ctx: ServerToolContext): Promise<ToolResult> {
  const idsArr = (ids ?? []).filter(Boolean) as string[];
  if (!idsArr.length) return { ok: false, code: "no_ids" };

  const tracksRes = await ctx.requestClientTool({ id: "enrich_tracks", name: "get_several_tracks", args: { ids: idsArr } });
  if (!tracksRes.ok) return tracksRes;
  const tracks = (tracksRes.data as Array<{ uri: string; name: string; artists: string[]; artist_ids: string[]; album?: string; duration_ms?: number }>) ?? [];

  const artistIds = [...new Set(tracks.flatMap((t) => t.artist_ids ?? []))];
  const artistById = new Map<string, { name: string; genres: string[] }>();
  if (artistIds.length) {
    const artistsRes = await ctx.requestClientTool({ id: "enrich_artists", name: "get_several_artists", args: { ids: artistIds.slice(0, 50) } });
    if (artistsRes.ok) {
      for (const a of (artistsRes.data as Array<{ id: string; name: string; genres: string[] }>) ?? []) {
        artistById.set(a.id, a);
      }
    }
  }

  const lyrics = await lyricsBulk(
    tracks.slice(0, 15).map((t) => ({ artist: t.artists?.[0] ?? "", title: t.name, album: t.album ?? "", duration_ms: t.duration_ms ?? 0 })),
    ctx
  );
  const lyricsByKey = new Map<string, { text?: string; source?: string }>();
  if (lyrics.ok) {
    for (const l of (lyrics.data as Array<{ uri: string; text?: string; source?: string }>) ?? []) {
      lyricsByKey.set(l.uri, l);
    }
  }

  const enriched = tracks.map((t) => {
    const id = t.uri?.split(":").pop() ?? "";
    const art = (t.artist_ids ?? []).map((aid) => artistById.get(aid)).filter(Boolean);
    return {
      uri: t.uri,
      name: t.name,
      album: t.album ?? null,
      duration_ms: t.duration_ms ?? null,
      artists: t.artists ?? [],
      genres: [...new Set(art.flatMap((a) => a?.genres ?? []))],
      lyrics: lyricsByKey.get(t.uri)?.text ? { text: lyricsByKey.get(t.uri)!.text, source: lyricsByKey.get(t.uri)!.source } : null,
    };
  });

  return { ok: true, data: { count: enriched.length, tracks: enriched } };
}

export async function lyricsBulk(
  tracks: Array<{ uri?: string; artist: string; title: string; album?: string; duration_ms?: number }>,
  _ctx: ServerToolContext
): Promise<ToolResult> {
  if (!tracks.length) return { ok: false, code: "no_tracks" };
  const out = await mapLimit(tracks, 4, async (t) => {
    const res = await lyricsLookup(t.artist, t.title, t.album, t.duration_ms);
    if (!res.ok) return { uri: t.uri ?? "", text: null, source: null };
    const data = res.data as { text: string; source: string };
    return { uri: t.uri ?? "", text: data.text, source: data.source };
  });
  return { ok: true, data: out };
}

export async function imageSearch(q: string, perPage = 10): Promise<ToolResult> {
  try {
    const url = new URL("https://api.openverse.org/v1/images/");
    url.searchParams.set("q", q);
    url.searchParams.set("license_type", "commercial");
    url.searchParams.set("page_size", String(Math.min(perPage, 20)));
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, code: `openverse_http_${res.status}` };
    const body = (await res.json()) as { results?: Array<{ title: string; url: string; thumbnail: string; license: string; creator: string }> };
    const results = (body.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      thumbnail: r.thumbnail,
      license: r.license,
      creator: r.creator,
    }));
    return { ok: true, data: { q, results } };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "openverse_error" };
  }
}

export async function weeklyReport(ctx: ServerToolContext): Promise<ToolResult> {
  const recents = await ctx.requestClientTool({ id: "weekly_recents", name: "get_listening_recents", args: { limit: 50, time_range: "long_term" } });
  const saved = await ctx.requestClientTool({ id: "weekly_saved", name: "get_saved_tracks", args: {} });
  const recentsCount = recents.ok && Array.isArray(recents.data) ? recents.data.length : null;
  return {
    ok: true,
    data: {
      recent_tracks: recents.ok ? recents.data : null,
      saved_tracks: saved.ok && Array.isArray(saved.data) ? (saved.data as unknown[]).length : null,
    },
  };
}

export async function prepareCover(url: string, maxKb = 256): Promise<ToolResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, code: `cover_download_${res.status}` };
    const buffer = Buffer.from(await res.arrayBuffer());
    let image = sharp(buffer).rotate().resize(600, 600, { fit: "inside", withoutEnlargement: true }).jpeg();
    let jpeg = await image.toBuffer();
    let quality = 85;
    while (jpeg.length > maxKb * 1024 && quality > 40) {
      quality -= 10;
      jpeg = await sharp(buffer).rotate().resize(600, 600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    }
    if (jpeg.length > maxKb * 1024) return { ok: false, code: "cover_too_large" };
    return { ok: true, data: { image_b64: jpeg.toString("base64"), bytes: jpeg.length } };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message : "cover_error" };
  }
}

export async function runServerTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerToolContext
): Promise<ToolResult> {
  switch (name) {
    case "undo_last_mutation": {
      const playlistId = String(args.playlist_id ?? "");
      const snapshot = getLatestSnapshot(ctx.db, playlistId);
      if (!snapshot) return { ok: false, code: "no_snapshot" };
      const res = await ctx.requestClientTool({
        id: `undo_${playlistId}`,
        name: "replace_playlist_tracks",
        args: { playlist_id: playlistId, uris: snapshot },
      });
      if (!res.ok) return res;
      markSnapshotUndone(ctx.db, playlistId);
      return { ok: true, data: { restored_tracks: snapshot.length } };
    }
    case "web_search":
      return webSearch(String(args.q ?? ""), String(args.categories ?? "general"), args.time_range as string | undefined);
    case "enrich_tracks":
      return enrichTracks((args.ids as string[]) ?? [], ctx);
    case "lyrics_bulk":
      return lyricsBulk((args.tracks as Array<{ artist: string; title: string; album?: string; duration_ms?: number }>) ?? [], ctx);
    case "chart_lookup":
      return chartLookup(ctx.db, (args.uris as string[]) ?? [], String(args.region ?? "global"));
    case "image_search":
      return imageSearch(String(args.q ?? ""), typeof args.per_page === "number" ? args.per_page : 10);
    case "weekly_report":
      return weeklyReport(ctx);
    case "prepare_cover":
      return prepareCover(String(args.url ?? ""), typeof args.max_kb === "number" ? args.max_kb : 256);
    case "lyrics_lookup":
      return lyricsLookup(
        String(args.artist),
        String(args.title),
        args.album ? String(args.album) : undefined,
        typeof args.duration_ms === "number" ? args.duration_ms : undefined
      );
    case "similar_artists":
      return similarArtists(String(args.artist), typeof args.limit === "number" ? args.limit : 10);
    case "artist_info":
      return artistInfo(String(args.artist), typeof args.limit === "number" ? args.limit : 10);
    default:
      return { ok: false, code: `unknown_server_tool:${name}` };
  }
}
