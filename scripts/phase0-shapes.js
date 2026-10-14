/* Euterpe - Phase 0 discovery, pass 3: RESPONSE SHAPES (read-only, network).
 *
 * Pass 1 gave signatures and pass 2 gave prototype methods -- but neither
 * reveals how GraphQL payloads are nested. Phase 2 (Tier 2) cannot be written
 * against a guessed shape, so this dumps a *skeleton* of each response.
 *
 * What it does: for every probe, prints the key path tree of the answer
 * (types + first array element), truncated. It reads your own account.
 * Nothing is mutated. Paste into the top-frame console; the JSON is copied.
 */
(async () => {
  const S = (typeof Spicetify !== "undefined" ? Spicetify : window.top && window.top.Spicetify) || null;
  if (!S) {
    const m = "Spicetify not found - use the TOP frame.";
    console.error(m);
    return { ok: false, error: m };
  }
  const f = (fn, d = null) => { try { return fn(); } catch (e) { return d; } };

  // Nested key skeleton: arrays collapse to [first-element-shape].
  function shape(v, depth = 0, maxDepth = 5) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1, maxDepth)] : [];
    if (typeof v === "object") {
      if (depth >= maxDepth) return "{...}";
      const o = {};
      for (const k of Object.keys(v).slice(0, 40)) o[k] = shape(v[k], depth + 1, maxDepth);
      return o;
    }
    return typeof v;
  }

  const results = {};

  async function gql(name, vars) {
    const g = S.GraphQL;
    const def = f(() => g && g.Definitions && g.Definitions[name]);
    if (!def) {
      results["gql:" + name] = { error: "definition_missing" };
      return;
    }
    try {
      const data = await g.Request(def, vars, {});
      if (data && data.errors) {
        results["gql:" + name] = { error: "graphql_errors", details: data.errors };
        return;
      }
      results["gql:" + name] = { ok: true, shape: shape(data) };
    } catch (e) {
      results["gql:" + name] = { error: String((e && e.message) || e) };
    }
  }

  async function platform(label, fn) {
    try {
      const res = await fn();
      results["plat:" + label] = { ok: true, shape: shape(res) };
    } catch (e) {
      results["plat:" + label] = { error: String((e && e.message) || e) };
    }
  }

  const P = S.Platform;
  const ARTIST = "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb"; // Radiohead
  const ALBUM = "spotify:album:6dVIqQ8qmQ5GBnJ9shOYGE"; // OK Computer
  const TRACK = "spotify:track:4iV5W9uYEdYUVa79Axb7Rh";

  // ---- GraphQL definitions the plan wants to wire -------------------------
  await gql("queryArtistOverview", { uri: ARTIST });
  await gql("getAlbum", { uri: ALBUM, locale: "en", limit: 5, offset: 0 });
  await gql("getTrack", { uri: TRACK });
  await gql("searchModalResults", { searchTerm: "miles davis", limit: 3, offset: 0 });
  await gql("decorateContextTracks", { uris: [TRACK] });
  await gql("home", {});

  // ---- Platform methods whose return shape decides the mapping ------------
  await platform("PlayHistoryAPI.getContents", () => P.PlayHistoryAPI.getContents());
  await platform("RecentsAPI.getContents()", () => P.RecentsAPI.getContents());
  await platform("LibraryAPI.getArtistView", () => P.LibraryAPI.getArtistView(ARTIST));
  await platform("RecentsAPI.getContents(obj,0,20)", () => P.RecentsAPI.getContents({}, 0, 20, null));

  const ctxUri = f(() => (S.Player && S.Player.data && S.Player.data.context && S.Player.data.context.uri) || null);
  if (ctxUri && ctxUri.includes(":playlist:")) {
    await platform("PlaylistAPI.getContents(current)", () => P.PlaylistAPI.getContents(ctxUri, { offset: 0, limit: 2 }));
  } else {
    results["plat:PlaylistAPI.getContents(current)"] = { skipped: "current context is not a playlist (" + ctxUri + ")" };
  }

  const out = { ok: true, note: "skeletons only; the full payload was NOT stored", results };
  const json = JSON.stringify(out, null, 2);
  f(() => copy(json));
  console.log(out);
  console.log("JSON (copied to clipboard):\n" + json);
  return out;
})();
