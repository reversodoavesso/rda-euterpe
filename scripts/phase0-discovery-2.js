/* Euterpe - Phase 0 discovery, pass 2 (read-only).
 *
 * Fixes pass-1 gaps:
 *   - pass 1 listed own-keys only, so class methods (on the prototype) were missed;
 *     this walks the prototype chain to enumerate real methods + arity.
 *   - ArtistAPI / SearchAPI / AlbumAPI / TrackAPI do NOT exist in this client;
 *     this probes the namespaces that DO exist and may replace them.
 *   - captures operation name + persisted-query hash for the GraphQL definitions
 *     the plan will actually wire.
 *
 * Run in the Spotify DevTools Console on the TOP frame. No network, no mutation.
 */
(() => {
  const S = (typeof Spicetify !== "undefined" ? Spicetify : window.top && window.top.Spicetify) || null;
  if (!S) {
    const m = "Spicetify not found - open the console on the TOP frame.";
    console.error(m);
    return { ok: false, error: m };
  }
  const f = (fn, d = null) => { try { return fn(); } catch (e) { return d; } };

  // Enumerate methods across the prototype chain (class instances keep them there).
  const methodsOf = (obj) => {
    if (!obj) return [];
    const names = new Set();
    let o = obj;
    let depth = 0;
    while (o && o !== Object.prototype && depth < 6) {
      for (const n of Object.getOwnPropertyNames(o)) {
        if (n === "constructor") continue;
        if (typeof f(() => obj[n]) === "function") names.add(n);
      }
      o = Object.getPrototypeOf(o);
      depth++;
    }
    return [...names].sort();
  };

  const probe = (ns) => {
    const api = f(() => S.Platform[ns], null);
    if (!api) return { present: false };
    const methods = methodsOf(api);
    const arity = {};
    for (const m of methods) arity[m] = f(() => api[m].length, null);
    return { present: true, count: methods.length, methods, arity };
  };

  const namespaces = [
    // already confirmed present
    "LibraryAPI", "PlaylistAPI", "RootlistAPI", "PlayerAPI", "LocalFilesAPI",
    // candidates to replace ArtistAPI / SearchAPI / AlbumAPI / TrackAPI / History
    "PlayHistoryAPI", "RecentlyPlayedAPI", "RecentsAPI", "CollectionPlatformAPI",
    "PlaybackAPI", "UserAPI", "FollowAPI", "ListPlatformAPI", "CurationAPI",
    "AssistedCurationAPI", "PlaylistMixingAPI", "PlatformData", "Registry",
    "GraphQLLoader", "Session", "ShowAPI", "YourLibraryTagsAPI", "PubsubAPI", "PubSubAPI",
  ];

  const platform = {};
  for (const n of namespaces) platform[n] = probe(n);

  // GraphQL definitions the plan can realistically wire on this client.
  const defs = f(() => S.GraphQL && S.GraphQL.Definitions, {}) || {};
  const defNames = [
    "getTrack", "getAlbum", "getAlbumNameAndTracks", "getArtistNameAndTracks",
    "queryAlbumTracks", "queryAlbumTrackUris", "queryTrackArtists",
    "queryArtistOverview", "queryArtistAboutModal",
    "searchModalResults", "searchSuggestions", "searchModalEntityPage",
    "decorateContextTracks", "decorateQueuedByUsers", "showItemsPlayedState",
    "recentSearches", "home", "homeSection", "npvPageContent", "watchFeedView",
    "canvas", "concert", "trackPreview", "similarAlbumsBasedOnThisTrack",
    "seoRecommendedTrackPlaylistDesktop", "lookupChildEntities",
  ];
  const graphql = {};
  for (const n of defNames) {
    const d = f(() => defs[n], null);
    graphql[n] = d
      ? { present: true, operation: f(() => d.operation), hash: f(() => d.sha256Hash), apiType: f(() => d.__apiType) }
      : { present: false };
  }

  const out = { ok: true, platform, graphql };
  const json = JSON.stringify(out, null, 2);
  f(() => copy(json));
  console.log(out);
  console.log("JSON (copied to clipboard):\n" + json);
  return out;
})();
