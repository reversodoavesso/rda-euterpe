/* Euterpe - Phase 0 shapes, pass 3b: TARGETED LEAF KEYS (read-only, network).
 *
 * Pass 3 dumped full trees, which is (a) huge and (b) cut off at depth 5, so
 * the leaf keys we actually need to normalize were lost as "{...}".
 * This pass instead walks a short list of *known* paths and prints, for each,
 * only the shape of that node. Compact enough to paste back whole.
 */
(async () => {
  const S = (typeof Spicetify !== "undefined" ? Spicetify : window.top && window.top.Spicetify) || null;
  if (!S) {
    const m = "Spicetify not found - use the TOP frame.";
    console.error(m);
    return { ok: false, error: m };
  }
  const f = (fn, d = null) => { try { return fn(); } catch (e) { return d; } };

  const at = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

  // Bounded description: 2 object levels deep, arrays collapse to their first item.
  const describe = (v, depth = 0) => {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return v.length ? { len: v.length, item: describe(v[0], depth + 1) } : "[]";
    if (typeof v === "object") {
      if (depth >= 2) return Object.keys(v).slice(0, 25);
      const o = {};
      for (const k of Object.keys(v).slice(0, 25)) o[k] = describe(v[k], depth + 1);
      return o;
    }
    return typeof v;
  };

  const out = {};

  async function gql(name, vars, paths) {
    const g = S.GraphQL;
    const def = f(() => g && g.Definitions && g.Definitions[name]);
    if (!def) {
      out["gql:" + name] = { error: "definition_missing" };
      return;
    }
    try {
      const r = await g.Request(def, vars, {});
      if (r && r.errors) {
        out["gql:" + name] = { error: "graphql_errors", details: JSON.stringify(r.errors).slice(0, 300) };
        return;
      }
      const data = (r && r.data) || r || {};
      const res = { top: Object.keys(data).slice(0, 10) };
      for (const p of paths) res[p] = describe(at(data, p));
      out["gql:" + name] = res;
    } catch (e) {
      out["gql:" + name] = { error: String((e && e.message) || e) };
    }
  }

  async function plat(label, fn, paths) {
    try {
      const r = await fn();
      const res = { top: r && typeof r === "object" ? Object.keys(r).slice(0, 12) : describe(r) };
      for (const p of paths || []) res[p] = describe(at(r, p));
      out["plat:" + label] = res;
    } catch (e) {
      out["plat:" + label] = { error: String((e && e.message) || e) };
    }
  }

  const P = S.Platform;
  const ARTIST = "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb"; // Radiohead
  const ALBUM = "spotify:album:6dVIqQ8qmQ5GBnJ9shOYGE"; // OK Computer
  const TRACK = "spotify:track:4iV5W9uYEdYUVa79Axb7Rh";

  await gql("queryArtistOverview", { uri: ARTIST }, [
    "artistUnion.profile",
    "artistUnion.relatedContent.relatedArtists.items",
    "artistUnion.discography.topTracks.items",
    "artistUnion.visuals.avatarImage.sources",
  ]);
  await gql("getAlbum", { uri: ALBUM, locale: "en", limit: 5, offset: 0 }, [
    "albumUnion.name",
    "albumUnion.artists.items",
    "albumUnion.tracks.items",
    "albumUnion.coverArt.sources",
  ]);
  await gql("getTrack", { uri: TRACK }, ["trackUnion", "track"]);
  await gql("searchModalResults", { searchTerm: "miles davis", limit: 3, offset: 0 }, [
    "searchV2",
    "searchV2.tracksV2.items",
    "searchV2.albumsV2.items",
    "searchV2.artists.items",
    "searchV2.playlists.items",
  ]);

  // Platform probes that decide the remaining mappings.
  await plat("PlayHistoryAPI.getContents", () => P.PlayHistoryAPI.getContents());
  await plat("RecentsAPI.getContents", () => P.RecentsAPI.getContents());
  await plat("RecentsAPI.getContents(obj,0,20,null)", () => P.RecentsAPI.getContents({}, 0, 20, null));
  await plat("LibraryAPI.getArtistView", () => P.LibraryAPI.getArtistView(ARTIST));
  await plat("CollectionPlatformAPI.get", () => P.CollectionPlatformAPI.get("spotify:collection:tracks"));

  const ctxUri = f(() => (S.Player && S.Player.data && S.Player.data.context && S.Player.data.context.uri) || null);
  if (ctxUri && ctxUri.includes(":playlist:")) {
    await plat("PlaylistAPI.getContents", () => P.PlaylistAPI.getContents(ctxUri, { offset: 0, limit: 2 }), ["items"]);
  } else {
    out["plat:PlaylistAPI.getContents"] = { skipped: "context is not a playlist (" + ctxUri + ")" };
  }

  const payload = { ok: true, note: "leaf keys only", results: out };
  const json = JSON.stringify(payload, null, 2);
  f(() => copy(json));
  console.log(out);
  console.log("JSON (copied):\n" + json);
  return out;
})();
