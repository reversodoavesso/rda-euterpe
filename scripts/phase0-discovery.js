/* Euterpe — Phase 0 discovery (read-only).
 *
 * Purpose: capture the *real* signature surface of the running Spotify client
 * so PLAN-INTERNAL-API.md can be implemented against facts, not guesses.
 *
 * How to run:
 *   1. Open Spotify desktop DevTools (Console tab). Make sure the JS context
 *      is the TOP frame ("top" in the context dropdown) — `Spicetify` lives there.
 *   2. Paste this whole file, press Enter.
 *   3. The result is copied to the clipboard AND printed. Paste that JSON back.
 *
 * Guarantees: makes NO network request and mutates NOTHING. Every probe is
 * wrapped in try/catch so a missing API degrades to `null` instead of throwing.
 *
 * This file is NOT part of the spicetify install (install.mjs does not copy it).
 */
(() => {
  const SP = (typeof Spicetify !== "undefined" ? Spicetify : window.top && window.top.Spicetify) || null;

  const safe = (fn, fallback = null) => {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  };
  const hex64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

  const out = { ok: false, guard: {}, platform: {}, graphql: {} };

  if (!SP) {
    out.error = "Spicetify global not found. Open the console on the TOP frame.";
    console.error(out.error);
    return out;
  }

  // ---- guard: versions and top-level capabilities -------------------------
  out.guard.spicetifyVersion = safe(() => SP.Config?.version ?? null);
  out.guard.spotifyVersion = safe(() => SP.Platform?.version ?? SP.Platform?.session?.version ?? null);
  out.guard.hasPlatform = !!SP.Platform;
  out.guard.hasGraphQL = !!SP.GraphQL;
  out.guard.hasCosmosAsync = !!SP.CosmosAsync;
  out.guard.hasURI = !!SP.URI;
  out.guard.userAgent = safe(() => navigator.userAgent);

  // ---- Platform: top-level namespace inventory -----------------------------
  out.platform.keys = safe(() => Object.keys(SP.Platform).sort(), []);

  // ---- Platform: deep probe of the APIs the plan depends on ----------------
  // For each method we record: arity (function length) or "value" / null.
  const probe = (ns, methods) => {
    const api = safe(() => SP.Platform[ns], null);
    if (!api) return { present: false };
    const found = {};
    for (const m of methods) {
      found[m] = typeof api[m] === "function" ? api[m].length : m in api ? "value" : null;
    }
    return {
      present: true,
      methods: found,
      allFns: safe(
        () => Object.keys(api).filter((k) => typeof api[k] === "function").sort(),
        []
      ),
    };
  };

  out.platform.probes = {
    LibraryAPI: probe("LibraryAPI", ["getContents", "getTracks", "getAlbums", "add", "remove", "contains"]),
    PlaylistAPI: probe("PlaylistAPI", ["getMetadata", "getContents", "add", "remove", "setPermission"]),
    RootlistAPI: probe("RootlistAPI", ["createPlaylist", "getContents", "add", "remove", "move"]),
    ArtistAPI: probe("ArtistAPI", ["getMetadata", "getContents", "getRelatedArtists", "queryArtistOverview", "getDiscography"]),
    History: probe("History", ["getRecentlyPlayed", "getTopArtists", "getTopTracks"]),
    PlayerAPI: probe("PlayerAPI", ["getState", "play", "addToQueue"]),
    AuthorizationAPI: probe("AuthorizationAPI", ["getState", "tryAuthorize"]),
    SearchAPI: probe("SearchAPI", ["getSearchResults", "getTopResults"]),
    AlbumAPI: probe("AlbumAPI", ["getMetadata", "getContents"]),
    TrackAPI: probe("TrackAPI", ["getMetadata", "getContents"]),
    LocalFilesAPI: probe("LocalFilesAPI", []),
  };

  // ---- GraphQL wrapper ------------------------------------------------------
  const GQL = safe(() => SP.GraphQL, null);
  out.graphql.present = !!GQL;
  out.graphql.members = safe(() => Object.keys(GQL).sort(), []);

  const defs = safe(() => GQL.Definitions, null);
  out.graphql.definitionCount = safe(() => Object.keys(defs).length, 0);
  out.graphql.names = safe(() => Object.keys(defs).sort(), []);

  // Definitions the plan wants to use. `sha256` scans the definition object for
  // a 64-hex string (persisted-query hash) when present.
  const wanted = [
    "FetchPlaylistContents",
    "FetchPlaylistMetadata",
    "queryArtistRelated",
    "searchModalResults",
    "searchDesktop",
    "getAlbum",
    "queryArtistOverview",
    "queryArtistDiscographyAll",
    "decorateContextTracks",
    "browsePage",
    "browseTrack",
    "browseArtist",
    "queryArtistMinimal",
  ];
  out.graphql.wanted = {};
  for (const w of wanted) {
    const d = safe(() => (defs ? defs[w] : null), null);
    out.graphql.wanted[w] = d
      ? {
          present: true,
          type: typeof d,
          keys: safe(() => Object.keys(d), []),
          sha256: safe(() => {
            const stack = [d];
            while (stack.length) {
              const v = stack.pop();
              if (hex64(v)) return v;
              if (v && typeof v === "object") for (const k of Object.keys(v)) stack.push(v[k]);
            }
            return null;
          }, null),
        }
      : { present: false };
  }

  out.ok = true;
  const json = JSON.stringify(out, null, 2);
  safe(() => copy(json)); // DevTools console helper: copies to clipboard
  console.log("%cEuterpe Phase 0 — discovery", "font-weight:bold");
  console.log(out);
  console.log("JSON (already copied to clipboard):\n" + json);
  return out;
})();

/* ==========================================================================
 * OPTIONAL — response shapes (MAKES NETWORK CALLS; run only if you want the
 * exact field names so `mapTrack` parity is guaranteed). Reads 1 item from
 * your library and 1 item from the currently playing playlist. Nothing is
 * mutated. Paste this block by itself, after the block above.
 * ==========================================================================
 *
 * (async () => {
 *   const SP = window.Spicetify || window.top.Spicetify;
 *   const shape = {};
 *   try {
 *     const lib = await SP.Platform.LibraryAPI.getContents({ limit: 1, offset: 0, filters: [] });
 *     shape.libraryItemKeys = lib?.items?.[0] ? Object.keys(lib.items[0]) : null;
 *     shape.libraryItemSample = lib?.items?.[0] ?? null;
 *   } catch (e) { shape.libraryError = String(e); }
 *   try {
 *     const uri = SP.Player?.data?.item?.uri || SP.Platform?.PlayerAPI?.getState?.()?.item?.uri;
 *     if (uri && uri.includes(":playlist:")) {
 *       const pl = await SP.Platform.PlaylistAPI.getContents(uri, { offset: 0, limit: 1 });
 *       shape.playlistItemKeys = pl?.items?.[0] ? Object.keys(pl.items[0]) : null;
 *       shape.playlistItemSample = pl?.items?.[0] ?? null;
 *     } else {
 *       shape.playlistSkipped = "current context is not a playlist: " + uri;
 *     }
 *   } catch (e) { shape.playlistError = String(e); }
 *   console.log(JSON.stringify(shape, null, 2));
 *   return shape;
 * })();
 */
