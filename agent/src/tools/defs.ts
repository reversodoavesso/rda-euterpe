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
    "delete_playlist",
    "Deletes or unfollows a playlist (or multiple playlists) by ID or URI, removing it from the user's library. Mutation confirmed by the user.",
    {
      playlist_id: { type: "string", description: "Single playlist ID or URI (e.g. spotify:playlist:...)" },
      playlist_ids: { type: "array", items: { type: "string" }, description: "Optional list of playlist IDs or URIs to delete in batch" },
    },
    [],
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
    "get_listening_recents",
    "Your recently played tracks from the client's history (RecentsAPI). Returns up to `limit` items with track name, artists, album, URI, `added_at`, `fully_played`, `resume_position_ms`. Use instead of the rate-limited `get_top_tracks`/`get_top_artists` to understand what you actually listened to recently.",
    {
      limit: { type: "integer", description: "max 50" },
      time_range: { type: "string", description: "short_term, medium_term, long_term (ignored; history is unbounded)" },
    },
    [],
    "client"
  ),
  def(
    "get_currently_playing",
    "What is playing RIGHT NOW in the Spotify client (track, artists, album, is_playing, progress, context). Use this FIRST whenever the user says 'this song', 'what is playing', 'a música que está tocando', or refers to the current track. Returns null when nothing is playing.",
    {},
    [],
    "client"
  ),
  def(
    "get_player_state",
    "Full playback state of the Spotify client: is_playing, progress/duration, volume, muted, shuffle, repeat, speed, sleep timer, playback quality, context URI, index, restrictions, plus the current track. Use when the user wants the full picture of what the player is doing.",
    {},
    [],
    "client"
  ),
  def(
    "get_player_queue",
    "The client playback queue: the current item, what is next up, and manually queued items. Use when the user asks what is coming next or reasons about the queue.",
    {},
    [],
    "client"
  ),
  def(
    "get_connect_devices",
    "Spotify Connect devices visible to the client (name, type, active state, volume). Use when the user asks where the music is playing or wants to move playback.",
    {},
    [],
    "client"
  ),
  def(
    "player_control",
    "Controls playback in the client. action is one of: play, pause, toggle, next, previous, seek (needs position_ms), shuffle (needs shuffle: boolean), repeat (needs repeat: 0 off | 1 context | 2 track), volume (needs volume: 0..1), mute (needs mute: boolean), speed (needs speed: number), sleep_timer (needs minutes, null clears). Transient and instantly reversible. Only call it when the user actually asks to control playback.",
    {
      action: {
        type: "string",
        enum: ["play", "pause", "toggle", "next", "previous", "seek", "shuffle", "repeat", "volume", "mute", "speed", "sleep_timer"],
      },
      position_ms: { type: "integer", description: "for seek" },
      shuffle: { type: "boolean", description: "for shuffle" },
      repeat: { type: "integer", description: "for repeat: 0 off, 1 context, 2 track" },
      volume: { type: "number", description: "for volume, 0..1" },
      mute: { type: "boolean", description: "for mute" },
      speed: { type: "number", description: "for speed, e.g. 1.0" },
      minutes: { type: "integer", description: "for sleep_timer" },
    },
    ["action"],
    "client"
  ),
  def(
    "player_queue_control",
    "Manipulates the playback queue. action is one of: add (needs uri), insert_next (needs uri), remove (needs index), reorder (needs from and to), clear. Transient and reversible.",
    {
      action: { type: "string", enum: ["add", "insert_next", "remove", "reorder", "clear"] },
      uri: { type: "string", description: "for add / insert_next" },
      index: { type: "integer", description: "for remove" },
      from: { type: "integer", description: "for reorder" },
      to: { type: "integer", description: "for reorder" },
    },
    ["action"],
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
    "Artist data from the Spotify client: name, biography, followers, monthly listeners and image. Note: genres/popularity may come back empty — Spotify no longer exposes genres internally and the public Web API is rate limited. Use artist_info (Last.fm) for genres/tags and artist_info/web_search for extra biography context.",
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
  def(
    "dump_library",
    "Extrai instantaneamente todas as playlists, faixas e metadados da biblioteca local via Spicetify em <2s sem consumir rate limit da Web API.",
    {
      include_tracks: { type: "boolean", description: "Inclui faixas completas de cada playlist (default: true)" },
      include_saved_tracks: { type: "boolean", description: "Inclui músicas curtidas (default: false)" },
      max_playlists: { type: "integer", description: "Limite de playlists a extrair (default: 100)" },
    },
    [],
    "client"
  ),
  def(
    "batch_create_playlists",
    "Cria múltiplas playlists em lote com fatiamento e delay controlado em uma única execução. Toda criação é confirmada pelo usuário. Suporta auto-resolução: itens em tracks que não comecem com spotify:track: são buscados automaticamente em background.",
    {
      playlists: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            tracks: { type: "array", items: { type: "string" } },
          },
          required: ["name", "tracks"],
        },
      },
      delay_between_ms: { type: "integer", description: "Pausa entre criações em ms (default: 1500)" },
    },
    ["playlists"],
    "client"
  ),
  def(
    "resolve_tracks",
    "Resolves a list of tracks by artist and title into Spotify URIs directly inside the desktop client via GraphQL/Cosmos search without rate limits. Accepts batches of 50-100 tracks.",
    {
      tracks: {
        type: "array",
        description: "List of tracks to resolve, each with artist and title",
        items: {
          type: "object",
          properties: {
            artist: { type: "string", description: "Artist name" },
            title: { type: "string", description: "Track title" },
          },
          required: ["artist", "title"],
        },
      },
    },
    ["tracks"],
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
    "Prepara uma capa de playlist a partir de uma URL remota, caminho de arquivo local ou Data URI base64. Redimensiona e comprime para JPEG ≤ 256KB pronta para set_playlist_cover.",
    {
      url: { type: "string", description: "URL da imagem, caminho de arquivo local ou data:image/... base64" },
      file_path: { type: "string", description: "caminho de arquivo de imagem local opcional" },
      max_kb: { type: "integer", description: "default 256" },
    },
    [],
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
  def(
    "find_orphans",
    "Identifica faixas que estavam nas playlists de origem mas foram esquecidas nas playlists de destino durante reorganização/curadoria.",
    {
      source_playlist_ids: { type: "array", items: { type: "string" }, description: "IDs ou URIs das playlists originais" },
      target_playlist_ids: { type: "array", items: { type: "string" }, description: "IDs ou URIs das playlists novas geradas" },
    },
    ["source_playlist_ids", "target_playlist_ids"],
    "server"
  ),
  def(
    "analyze_overlap",
    "Calcula matriz de intersecção e similaridade Jaccard entre playlists para detectar duplicidades e sobreposição.",
    {
      playlist_ids: { type: "array", items: { type: "string" }, description: "lista com pelo menos 2 IDs de playlists" },
    },
    ["playlist_ids"],
    "server"
  ),
  def(
    "backup_library",
    "Salva um snapshot completo com data/hora da biblioteca local para restauração segura e controle de versões.",
    {},
    [],
    "server"
  ),
  def(
    "restore_library",
    "Restaura a estrutura da biblioteca a partir de um backup prévio salvo em disco.",
    {
      backup_id: { type: "string", description: "ID do backup (ex: snapshot-20261014-230000)" },
    },
    ["backup_id"],
    "server"
  ),
  def(
    "get_playlist_history",
    "Consulta o histórico e a linha do tempo de alterações de uma playlist (deltas incrementais com adições, remoções e reordenações).",
    {
      playlist_id: { type: "string", description: "ID ou URI da playlist" },
      limit: { type: "integer", description: "Limite de versões a consultar (default: 10)" },
    },
    ["playlist_id"],
    "server"
  ),
];

export const allToolSchemas: ChatCompletionTool[] = [...clientTools, ...serverTools].map((t) => ({
  type: "function" as const,
  function: t.function,
}));

export const MUTATING_TOOLS = new Set([
  "create_playlist",
  "delete_playlist",
  "add_tracks",
  "remove_tracks",
  "set_playlist_details",
  "replace_playlist_tracks",
  "set_playlist_cover",
  "batch_create_playlists",
]);
