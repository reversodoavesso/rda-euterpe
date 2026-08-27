import type { ChatCompletionTool } from "openai/resources/chat/completions";

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  side: "client" | "server";
}

function def(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  side: "client" | "server"
): ToolDef {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
    side,
  };
}

export const clientTools: ToolDef[] = [
  def(
    "create_playlist",
    "CREATES a new playlist and ADDS the given tracks in one shot. Every creation is confirmed by the user. Show the list with per-track justification in chat first.",
    {
      name: { type: "string", description: "playlist name" },
      description: { type: "string", description: "optional description" },
      tracks: { type: "array", items: { type: "string" }, description: "track URIs" },
    },
    ["name", "tracks"],
    "client"
  ),
  def(
    "add_tracks",
    "Adds tracks to an existing playlist. Mutation confirmed by the user.",
    {
      playlist_id: { type: "string" },
      uris: { type: "array", items: { type: "string" } },
    },
    ["playlist_id", "uris"],
    "client"
  ),
  def(
    "remove_tracks",
    "Removes tracks from a playlist. Mutation confirmed by the user.",
    {
      playlist_id: { type: "string" },
      uris: { type: "array", items: { type: "string" } },
    },
    ["playlist_id", "uris"],
    "client"
  ),
  def(
    "set_playlist_details",
    "Updates a playlist's name and/or description. Mutation confirmed by the user.",
    {
      playlist_id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
    },
    ["playlist_id"],
    "client"
  ),
  def(
    "replace_playlist_tracks",
    "Replaces ALL tracks of a playlist with the given list (used for undo and hygiene). Mutation confirmed by the user.",
    {
      playlist_id: { type: "string" },
      uris: { type: "array", items: { type: "string" } },
    },
    ["playlist_id", "uris"],
    "client"
  ),
  def(
    "set_playlist_cover",
    "Changes a playlist's cover (JPEG image in base64, max 256KB). Mutation confirmed by the user.",
    {
      playlist_id: { type: "string" },
      image_b64: { type: "string", description: "JPEG base64" },
    },
    ["playlist_id", "image_b64"],
    "client"
  ),
  def(
    "get_playlists",
    "Lists the user's playlists. Returns {source, total, playlists[]} with id/uri, name, track count and image. Use before referencing a playlist.",
    { limit: { type: "integer", description: "max 50" } },
    [],
    "client"
  ),
  def(
    "get_playlist_tracks",
    "Returns the tracks of a playlist (uri, name, artists, album, duration).",
    { playlist_id: { type: "string", description: "playlist ID or URI" } },
    ["playlist_id"],
    "client"
  ),
  def(
    "get_saved_tracks",
    "The user's saved (liked) tracks, paginated.",
    { limit: { type: "integer", description: "max 50 per page" } },
    [],
    "client"
  ),
  def(
    "get_top_artists",
    "The user's most played artists, with genres.",
    { time_range: { type: "string", enum: ["short_term", "medium_term", "long_term"] } },
    [],
    "client"
  ),
  def(
    "get_top_tracks",
    "The user's most played tracks.",
    { time_range: { type: "string", enum: ["short_term", "medium_term", "long_term"] } },
    [],
    "client"
  ),
  def(
    "search_spotify",
    "Searches the Spotify catalog (track/artist/album/playlist). Resolves names to URIs. Use to find mentioned artists and tracks.",
    {
      q: { type: "string", description: "search term" },
      types: { type: "string", description: "track,artist,album,playlist (comma separated)" },
      limit: { type: "integer", description: "max 50" },
    },
    ["q"],
    "client"
  ),
  def(
    "get_related_artists",
    "Artists related to an artist (Spotify's primary similarity).",
    { artist_id: { type: "string", description: "artist ID or URI" } },
    ["artist_id"],
    "client"
  ),
  def(
    "get_artist",
    "Official artist metadata from Spotify (name, genres, popularity, followers, image). Does NOT include a biography — use artist_info (Last.fm) or web_search for biography.",
    { artist_id: { type: "string", description: "artist ID or URI" } },
    ["artist_id"],
    "client"
  ),
  def(
    "get_recommendations",
    "Generates recommendations from seeds (artists/tracks/genres). Use to build candidates.",
    {
      seed_artists: { type: "array", items: { type: "string" }, description: "artist IDs (up to 5 seeds total)" },
      seed_tracks: { type: "array", items: { type: "string" }, description: "track IDs" },
      seed_genres: { type: "array", items: { type: "string" }, description: "genres" },
      limit: { type: "integer", description: "max 100" },
    },
    [],
    "client"
  ),
  def(
    "get_audio_features_bulk",
    "Audio features (valence, energy, danceability, tempo...) of up to 100 tracks at once. Use to analyze mood/Music DNA.",
    { ids: { type: "array", items: { type: "string" }, description: "track IDs, up to 100" } },
    ["ids"],
    "client"
  ),
  def(
    "get_several_artists",
    "Metadata of up to 50 artists at once (genres, popularity, image).",
    { ids: { type: "array", items: { type: "string" }, description: "artist IDs, up to 50" } },
    ["ids"],
    "client"
  ),
  def(
    "get_several_tracks",
    "Metadata of up to 50 tracks at once.",
    { ids: { type: "array", items: { type: "string" }, description: "track IDs, up to 50" } },
    ["ids"],
    "client"
  ),
  def(
    "new_releases",
    "New releases from the catalog (browse/new-releases). Use for the release radar.",
    { limit: { type: "integer", description: "max 50" } },
    [],
    "client"
  ),
];

export const serverTools: ToolDef[] = [
  def(
    "enrich_tracks",
    "CENTRAL CROSS-REFERENCE ORCHESTRATOR: receives track IDs and returns unified entities (metadata, artists, genres, audio features and lyrics where available). PREFER this tool to analyze any music collection.",
    { ids: { type: "array", items: { type: "string" }, description: "track IDs (up to 100)" } },
    ["ids"],
    "server"
  ),
  def(
    "lyrics_bulk",
    "Fetches lyrics in batch for a list of tracks (limited fan-out). Returns per track with the source marked.",
    {
      tracks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            uri: { type: "string" },
            artist: { type: "string" },
            title: { type: "string" },
            album: { type: "string" },
            duration_ms: { type: "integer" },
          },
        },
      },
    },
    ["tracks"],
    "server"
  ),
  def(
    "chart_lookup",
    "Queries Spotify Charts (global or by region) and returns the position of the given tracks.",
    {
      uris: { type: "array", items: { type: "string" }, description: "track URIs" },
      region: { type: "string", description: "e.g. global, BR, US (default global)" },
    },
    ["uris"],
    "server"
  ),
  def(
    "prepare_cover",
    "Downloads the image at a URL, resizes and compresses to JPEG ≤ 256KB and returns it in base64, ready for set_playlist_cover.",
    { url: { type: "string", description: "image URL" }, max_kb: { type: "integer", description: "default 256" } },
    ["url"],
    "server"
  ),
  def(
    "weekly_report",
    "Gathers data for the weekly report: top artists, top tracks, saved tracks and playlists. Returns the data so you can write the summary.",
    {},
    [],
    "server"
  ),
  def(
    "image_search",
    "Searches images by concept (Openverse, commercial license). Returns results with thumbnail/url to use as playlist cover.",
    { q: { type: "string", description: "search terms" }, per_page: { type: "integer", description: "max 20" } },
    ["q"],
    "server"
  ),
  def(
    "undo_last_mutation",
    "Undoes the last mutation made on a playlist (restores the previous snapshot). The restore is also confirmed by the user.",
    { playlist_id: { type: "string" } },
    ["playlist_id"],
    "server"
  ),
  def(
    "web_search",
    "Text search on the web via SearXNG. Use for similar artists by external opinion, trends, releases, shows, cultural context, or as a generic fallback when another tool fails.",
    {
      q: { type: "string", description: "query" },
      categories: { type: "string", description: "general,music,news,images" },
      time_range: { type: "string", enum: ["day", "month", "year"] },
    },
    ["q"],
    "server"
  ),
  def(
    "lyrics_lookup",
    "Fetches the lyrics of a song (LRCLIB → Lyrics.ovh). Returns text and source. If not found, say you could not find them (never invent lyrics).",
    {
      artist: { type: "string" },
      title: { type: "string" },
      album: { type: "string" },
      duration_ms: { type: "integer" },
    },
    ["artist", "title"],
    "server"
  ),
  def(
    "similar_artists",
    "Similar artists from external sources (Deezer + Last.fm when configured). Complements get_related_artists from Spotify.",
    {
      artist: { type: "string", description: "artist name" },
      limit: { type: "integer", description: "max 15 per source" },
    },
    ["artist"],
    "server"
  ),
  def(
    "artist_info",
    "Artist biography and info from Last.fm (bio text, tags/genres, similar artists). Returns source marked as 'lastfm'. Falls back to web_search when Last.fm is not configured/unavailable.",
    {
      artist: { type: "string", description: "artist name" },
      limit: { type: "integer", description: "max similar artists (default 10)" },
    },
    ["artist"],
    "server"
  ),
];

export const allToolSchemas: ChatCompletionTool[] = [...clientTools, ...serverTools].map((t) => ({
  type: "function" as const,
  function: t.function,
}));

export const MUTATING_TOOLS = new Set([
  "create_playlist",
  "add_tracks",
  "remove_tracks",
  "set_playlist_details",
  "replace_playlist_tracks",
  "set_playlist_cover",
]);
