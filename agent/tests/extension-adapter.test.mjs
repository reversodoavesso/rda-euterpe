// Adapter regression tests.
//
// The whole point of the phase-1 adapter is that Tier 1 is *optional*: if a
// Platform API is missing, returns nothing, or throws, the tool must silently
// keep its original Web API path. These tests load the extension IIFE inside a
// stubbed Spotify client (node:vm) and assert exactly that contract.
//
// Run: node --test tests/*.test.mjs   (or: npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "..", "..", "app", "euterpe-extension", "euterpe.js");

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Loads the extension in a stubbed client and exposes window.euterpe. */
function loadExtension(opts = {}) {
  const fetchCalls = [];
  const windowObj = { addEventListener() {}, euterpe: undefined };
  windowObj.top = windowObj;

  const fetchImpl = (url) => {
    const u = String(url);
    fetchCalls.push(u);
    if (u.endsWith("/config")) return Promise.resolve(response({ version: "0.1.0", secret: "test" }));
    const r = opts.apiResponse ? opts.apiResponse(u) : null;
    if (r) return Promise.resolve(response(r.body, r.status === undefined ? 200 : r.status));
    return Promise.resolve(response({}, 404));
  };

  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
    }
    send() {}
    close() {}
  }

  const store = new Map();
  const sandbox = {
    Spicetify: {
      CosmosAsync: { get: async () => ({}) },
      Config: { version: "2.45.3" },
      Locale: { getLocale: () => "en" },
      URI: {},
      Player: opts.player || { addEventListener() {}, data: null },
      GraphQL: opts.graphql,
      Platform: Object.assign(
        {
          AuthorizationAPI: {
            getState: () => ({ token: { accessToken: "test-token" } }),
            tryAuthorize: async () => true,
          },
        },
        opts.platform || {}
      ),
    },
    window: windowObj,
    navigator: { language: "en", userAgent: "node-test" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    fetch: fetchImpl,
    WebSocket: FakeWebSocket,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    URLSearchParams,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    JSON,
    Promise,
    Error,
    Set,
    Map,
    RegExp,
  };
  sandbox.globalThis = sandbox;

  vm.runInContext(readFileSync(EXT_PATH, "utf8"), vm.createContext(sandbox), { filename: "euterpe.js" });
  return { euterpe: windowObj.euterpe, fetchCalls };
}

test("get_playlists: Platform answers -> source=platform, Web API untouched", async () => {
  const { euterpe, fetchCalls } = loadExtension({
    platform: {
      LibraryAPI: {
        getContents: async () => ({
          items: [{ uri: "spotify:playlist:p1", name: "Mix", numberOfItemsPerLinkType: [{ numItems: 3 }] }],
        }),
      },
    },
  });

  const res = await euterpe.execSpotifyTool("get_playlists", {});

  assert.equal(res.ok, true);
  assert.equal(res.data.source, "platform");
  assert.equal(res.data.total, 1);
  assert.equal(res.data.playlists[0].id, "p1");
  assert.equal(res.data.playlists[0].tracks, 3);
  assert.ok(!fetchCalls.some((u) => u.includes("/me/playlists")), "must not hit the Web API");
});

test("get_playlists: Platform throws -> falls back to the Web API", async () => {
  const { euterpe, fetchCalls } = loadExtension({
    platform: {
      LibraryAPI: {
        getContents: async () => {
          throw new Error("boom");
        },
      },
    },
    apiResponse: (u) =>
      u.includes("/me/playlists")
        ? { body: { items: [{ id: "w1", uri: "spotify:playlist:w1", name: "Web", tracks: { total: 2 }, images: [] }] } }
        : { status: 404, body: {} },
  });

  const res = await euterpe.execSpotifyTool("get_playlists", {});

  assert.equal(res.ok, true);
  assert.equal(res.data.source, "webapi");
  assert.equal(res.data.playlists[0].name, "Web");
  assert.ok(fetchCalls.some((u) => u.includes("/me/playlists")), "must fall back to the Web API");
});

test("get_saved_tracks: empty Platform result -> falls back to the Web API", async () => {
  const { euterpe, fetchCalls } = loadExtension({
    platform: { LibraryAPI: { getTracks: async () => ({ items: [] }) } },
    apiResponse: (u) =>
      u.includes("/me/tracks")
        ? {
            body: {
              items: [
                {
                  added_at: "2026-01-01T00:00:00Z",
                  track: { uri: "spotify:track:t9", name: "Song", artists: [{ name: "A" }], album: { name: "Alb" }, duration_ms: 1000 },
                },
              ],
            },
          }
        : { status: 404, body: {} },
  });

  const res = await euterpe.execSpotifyTool("get_saved_tracks", {});

  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].uri, "spotify:track:t9");
  assert.equal(res.data[0].album, "Alb");
  assert.ok(fetchCalls.some((u) => u.includes("/me/tracks")));
});

test("add_tracks: Platform answers -> Web API untouched", async () => {
  let seen = null;
  const { euterpe, fetchCalls } = loadExtension({
    platform: {
      PlaylistAPI: {
        add: async (uri, uris) => {
          seen = { uri, uris };
        },
      },
    },
  });

  const res = await euterpe.execSpotifyTool("add_tracks", {
    playlist_id: "spotify:playlist:p1",
    uris: ["spotify:track:t1"],
  });

  assert.equal(res.ok, true);
  // Cross-realm objects: compare fields, not structural identity (a value
  // produced inside the vm context has a different Object.prototype).
  assert.equal(res.data.added, 1);
  assert.equal(seen.uri, "spotify:playlist:p1");
  assert.equal(seen.uris.length, 1);
  assert.equal(seen.uris[0], "spotify:track:t1");
  assert.ok(!fetchCalls.some((u) => u.includes("/playlists/")), "must not hit the Web API");
});

test("get_related_artists: Web API 403 -> GraphQL resilience path answers", async () => {
  const { euterpe } = loadExtension({
    apiResponse: () => ({ status: 403, body: {} }),
    graphql: {
      Definitions: { queryArtistOverview: { name: "queryArtistOverview", sha256Hash: "0".repeat(64) } },
      Request: async () => ({
        data: {
          artistUnion: {
            relatedContent: {
              relatedArtists: { items: [{ id: "a1", uri: "spotify:artist:a1", profile: { name: "Related One" } }] },
            },
          },
        },
      }),
    },
  });

  const res = await euterpe.execSpotifyTool("get_related_artists", { artist_id: "spotify:artist:root" });

  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].name, "Related One");
  assert.equal(res.data[0].uri, "spotify:artist:a1");
});

test("get_artist: GraphQL first (Web API is rate limited), exposes biography", async () => {
  const { euterpe, fetchCalls } = loadExtension({
    graphql: {
      Definitions: { queryArtistOverview: { name: "queryArtistOverview", sha256Hash: "0".repeat(64) } },
      Request: async () => ({
        data: {
          artistUnion: {
            id: "a1",
            uri: "spotify:artist:a1",
            profile: { name: "The Band", biography: { text: "Bio text" } },
            stats: { followers: 42, monthlyListeners: 7 },
            visuals: { avatarImage: { sources: [{ url: "img" }] } },
          },
        },
      }),
    },
  });

  const res = await euterpe.execSpotifyTool("get_artist", { artist_id: "spotify:artist:a1" });

  assert.equal(res.ok, true);
  assert.equal(res.data.name, "The Band");
  assert.equal(res.data.biography, "Bio text");
  assert.equal(res.data.followers, 42);
  assert.equal(res.data.monthly_listeners, 7);
  assert.equal(res.data.image, "img");
  assert.ok(!fetchCalls.some((u) => u.includes("/artists/")), "must not hit the rate-limited Web API");
});

test("get_several_tracks: single id resolves via GraphQL, no Web call", async () => {
  const { euterpe, fetchCalls } = loadExtension({
    graphql: {
      Definitions: { getTrack: { name: "getTrack", sha256Hash: "0".repeat(64) } },
      Request: async () => ({
        data: {
          trackUnion: {
            uri: "spotify:track:t1",
            name: "Song",
            duration: { totalMilliseconds: 1234 },
            albumOfTrack: { name: "Alb", coverArt: { sources: [{ url: "c" }] } },
            firstArtist: { items: [{ uri: "spotify:artist:a1", profile: { name: "A" } }] },
            otherArtists: { items: [] },
          },
        },
      }),
    },
  });

  const res = await euterpe.execSpotifyTool("get_several_tracks", { ids: ["t1"] });

  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].name, "Song");
  assert.equal(res.data[0].duration_ms, 1234);
  assert.equal(res.data[0].artists[0], "A");
  assert.ok(!fetchCalls.some((u) => u.includes("/tracks?ids=")), "must not hit the Web API");
});

test("search_spotify: GraphQL extracts entities structurally, no Web call", async () => {
  const { euterpe, fetchCalls } = loadExtension({
    graphql: {
      Definitions: { searchModalResults: { name: "searchModalResults", sha256Hash: "0".repeat(64) } },
      Request: async () => ({
        data: {
          searchV2: {
            topResultsV2: {
              itemsV2: [
                { matchedFields: ["name"], item: { __typename: "TrackResponseWrapper", data: { uri: "spotify:track:t1", name: "Song", id: "t1" } } },
                { matchedFields: ["name"], item: { __typename: "ArtistResponseWrapper", data: { uri: "spotify:artist:a1", name: "Artist", id: "a1" } } },
              ],
            },
          },
        },
      }),
    },
  });

  const res = await euterpe.execSpotifyTool("search_spotify", { q: "x" });

  assert.equal(res.ok, true);
  assert.equal(res.data.source, "graphql");
  assert.equal(res.data.tracks.length, 1);
  assert.equal(res.data.tracks[0].uri, "spotify:track:t1");
  assert.equal(res.data.artists.length, 1);
  assert.equal(res.data.artists[0].name, "Artist");
  assert.ok(!fetchCalls.some((u) => u.includes("/search?")), "must not hit the Web API");
});

test("unknown tool -> reports tool_not_implemented instead of throwing", async () => {
  const { euterpe } = loadExtension({ platform: {} });

  const res = await euterpe.execSpotifyTool("does_not_exist", {});

  assert.equal(res.ok, false);
  assert.match(String(res.code), /tool_not_implemented/);
});

test("get_currently_playing: reads the client player state, no Web API call", async () => {
  const { euterpe, fetchCalls } = loadExtension({
    player: {
      addEventListener() {},
      // Field names exactly as measured in phase 0: positionAsOfTimestamp +
      // timestamp, and `duration` as a number of milliseconds.
      data: {
        isPaused: false,
        timestamp: Date.now(),
        positionAsOfTimestamp: 1234,
        duration: 2000,
        shuffle: false,
        repeat: 0,
        context: { uri: "spotify:playlist:p1" },
        item: {
          uri: "spotify:track:t1",
          name: "Song",
          artists: [{ name: "A" }],
          album: { name: "Alb" },
        },
      },
    },
  });

  const res = await euterpe.execSpotifyTool("get_currently_playing", {});

  assert.equal(res.ok, true);
  assert.equal(res.data.is_playing, true);
  assert.ok(res.data.progress_ms >= 1234, "progress advances from positionAsOfTimestamp");
  assert.equal(res.data.duration_ms, 2000);
  assert.equal(res.data.context_uri, "spotify:playlist:p1");
  assert.equal(res.data.track.uri, "spotify:track:t1");
  assert.equal(res.data.track.album, "Alb");
  assert.ok(!fetchCalls.some((u) => u.includes("/me/player")), "must not hit the Web API");
});

test("get_currently_playing: nothing playing -> null, not an error", async () => {
  const { euterpe } = loadExtension({ player: { addEventListener() {}, data: null } });

  const res = await euterpe.execSpotifyTool("get_currently_playing", {});

  assert.equal(res.ok, true);
  assert.equal(res.data, null);
});

test("get_player_state: reports shuffle/repeat/volume from the real fields", async () => {
  const { euterpe } = loadExtension({
    platform: { PlaybackAPI: { getVolume: () => 0.5 } },
    player: {
      addEventListener() {},
      data: {
        isPaused: true,
        timestamp: Date.now(),
        positionAsOfTimestamp: 0,
        duration: 1000,
        shuffle: true,
        repeat: 2,
        speed: 1,
        item: { uri: "spotify:track:t1", name: "S", artists: [{ name: "A" }], album: { name: "Al" } },
      },
    },
  });

  const res = await euterpe.execSpotifyTool("get_player_state", {});

  assert.equal(res.ok, true);
  assert.equal(res.data.is_playing, false);
  assert.equal(res.data.shuffle, true);
  assert.equal(res.data.repeat, 2);
  assert.equal(res.data.duration_ms, 1000);
  assert.equal(res.data.volume, 0.5);
  assert.equal(res.data.track.name, "S");
});

test("get_player_queue: normalizes current / nextUp / queued", async () => {
  const { euterpe } = loadExtension({
    platform: {
      PlayerAPI: {
        getQueue: async () => ({
          current: { item: { uri: "spotify:track:c", name: "Cur", artists: [{ name: "A" }], album: { name: "Al" } } },
          nextUp: [{ item: { uri: "spotify:track:n", name: "Next", artists: [{ name: "B" }], album: { name: "Al2" } } }],
          queued: [],
        }),
      },
    },
  });

  const res = await euterpe.execSpotifyTool("get_player_queue", {});

  assert.equal(res.ok, true);
  assert.equal(res.data.current.uri, "spotify:track:c");
  assert.equal(res.data.next_up.length, 1);
  assert.equal(res.data.next_up[0].name, "Next");
});

test("player_control: dispatches to the client player, validates args, never hits the Web API", async () => {
  const calls = [];
  const player = { addEventListener() {}, data: null };
  for (const m of ["play", "pause", "togglePlay", "next", "back", "seek", "setShuffle", "setRepeat", "setVolume", "setMute"]) {
    player[m] = (...a) => calls.push([m, ...a]);
  }
  const { euterpe, fetchCalls } = loadExtension({ player });

  assert.equal((await euterpe.execSpotifyTool("player_control", { action: "pause" })).ok, true);
  assert.equal((await euterpe.execSpotifyTool("player_control", { action: "seek", position_ms: 5000 })).ok, true);
  assert.equal((await euterpe.execSpotifyTool("player_control", { action: "volume", volume: 2 })).ok, true);

  const bad = await euterpe.execSpotifyTool("player_control", { action: "seek" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "missing_position_ms");

  const unknown = await euterpe.execSpotifyTool("player_control", { action: "nope" });
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.code), /unknown_action/);

  // Cross-realm arrays: compare contents, not structural identity.
  assert.equal(calls[0].join(","), "pause");
  assert.equal(calls[1].join(","), "seek,5000");
  assert.equal(calls[2].join(","), "setVolume,1"); // clamped into 0..1
  assert.ok(!fetchCalls.some((u) => u.includes("/me/player")), "must not hit the Web API");
});
