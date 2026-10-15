// Euterpe - Extension
// Keeps the WebSocket with the local agent, runs Spotify tools
// (via the private API with a fresh AuthorizationAPI token) and exposes
// window.euterpe.
(function euterpeExtension() {
  if (window.euterpe) return;
  init();

  function init() {
    if (!Spicetify || !Spicetify.CosmosAsync) {
      setTimeout(init, 300);
      return;
    }

    const AGENT_URL = "http://127.0.0.1:8337";
    const WS_URL = "ws://127.0.0.1:8337/ws";
    const API = "https://api.spotify.com/v1";
    const MAX_PLAYLIST_TRACKS = 300;
    const MAX_SAVED_TRACKS = 200;
    const MAX_LIBRARY_ITEMS = 200;
    const PAGE_SIZE = 50;
    const MAX_PAGE_SIZE = 100;
    const CACHE_10MIN = 10 * 60 * 1000;
    const CACHE_5MIN = 5 * 60 * 1000;
    const CACHE_30MIN = 30 * 60 * 1000;
    const CACHE_24H = 24 * 60 * 60 * 1000;
    const RECONNECT_MAX_DELAY = 30000;
    const listeners = new Set();

    // Locale-aware strings emitted as chat.status details / logs.
    const STRINGS = {
      disconnected: { en: "Agent disconnected", "pt-br": "Agente desconectado" },
      extensionLoaded: { en: "extension loaded", "pt-br": "extensão carregada" },
    };

    function normalizeLocale(raw) {
      const lang = String(raw || "").split("-")[0].trim().toLowerCase();
      return lang === "pt" ? "pt-br" : "en";
    }

    function tr(key) {
      const loc = normalizeLocale(getLocale());
      const entry = STRINGS[key];
      return (entry && entry[loc]) || key;
    }

    let ws = null;
    let retry = 0;
    let agentVersion = null;

    // TEMP DIAGNOSTICS — forward page errors (from any custom app, including
    // euterpe) to the agent log via client.debug.
    function reportPageError(level, detail) {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "client.debug", level, detail: "[page] " + detail }));
        }
      } catch (err) {}
    }
    window.addEventListener("error", (e) => reportPageError("error", (e && e.message ? e.message : e) + " @ " + (e && e.filename ? e.filename : "?") + ":" + (e && e.lineno ? e.lineno : "?")));
    window.addEventListener("unhandledrejection", (e) => reportPageError("error", "unhandledrejection: " + (e && e.reason ? e.reason : e)));

    function notify(msg) {
      listeners.forEach((cb) => {
        try {
          cb(msg);
        } catch (err) {
          console.error("[euterpe]", err);
        }
      });
    }

    function idOf(uriOrId) {
      return String(uriOrId).split(":").pop();
    }

    function getApiToken() {
      try {
        return Spicetify?.Platform?.AuthorizationAPI?.getState?.()?.token?.accessToken || null;
      } catch {
        return null;
      }
    }

    async function forceTokenRefresh() {
      try {
        const auth = Spicetify?.Platform?.AuthorizationAPI;
        if (auth && typeof auth.tryAuthorize === "function") {
          await auth.tryAuthorize();
          return true;
        }
      } catch {}
      return false;
    }

    function cacheGet(key) {
      try {
        const raw = localStorage.getItem("euterpe:cache:" + key);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (o.exp && Date.now() > o.exp) return null;
        return o.v;
      } catch {
        return null;
      }
    }

    function cacheSet(key, value, ttlMs) {
      try {
        localStorage.setItem("euterpe:cache:" + key, JSON.stringify({ v: value, exp: Date.now() + ttlMs }));
      } catch {}
    }

    // --- Web API throttling (phase 5) -------------------------------------
    // The Web API is the only tier with a tight rate limit. Requests are
    // spaced, identical concurrent GETs are coalesced, and retryable
    // statuses back off exponentially with jitter (honouring Retry-After).
    const WEB_MIN_SPACING_MS = 120; // PLAN.md 2.5: keep >= ~100ms between calls
    const WEB_MAX_ATTEMPTS = 3;
    const WEB_BACKOFF_BASE_MS = 500;
    const WEB_BACKOFF_CAP_MS = 4000;
    const WEB_RETRYABLE = new Set([429, 502, 503, 504]);
    // Hard bounds. A stalled request must never silently burn the agent's 30s
    // tool timeout: that is how a hang turns into an opaque `client_timeout`.
    const WEB_ATTEMPT_TIMEOUT_MS = 6000;
    const WEB_TOTAL_BUDGET_MS = 20000;
    // A 429 whose Retry-After exceeds this means the quota window is exhausted:
    // retrying now only burns the caller's patience, so fail fast instead.
    const WEB_RETRY_AFTER_MAX_MS = 2000;

    let webLastCallAt = 0;
    const webInFlight = new Map();

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async function throttleWeb() {
      const wait = webLastCallAt + WEB_MIN_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      webLastCallAt = Date.now();
    }

    function retryDelayMs(res, attempt) {
      const hinted = res ? Number(res.headers.get("retry-after")) : NaN;
      if (hinted > 0) return Math.min(hinted * 1000, WEB_BACKOFF_CAP_MS);
      const base = Math.min(WEB_BACKOFF_BASE_MS * 2 ** attempt, WEB_BACKOFF_CAP_MS);
      return base / 2 + Math.random() * (base / 2); // jittered half->full
    }

    // Tier provenance. Reported as a structured log line (never in the tool
    // payload, so tool contracts stay intact): the fewer distinct Web API URLs
    // appear, the better the Tier 1 migration is working.
    const notedWebUrls = new Set();
    function noteWebUse(url) {
      if (notedWebUrls.has(url)) return;
      notedWebUrls.add(url);
      dbg("[tier] webapi " + url);
    }

    // Records the HTTP outcome of a Web API call (once per url+status), which is
    // what makes a silent hang diagnosable from the agent log.
    const notedWebStatuses = new Set();
    function noteWebStatus(url, status) {
      const key = status + " " + url;
      if (notedWebStatuses.has(key)) return;
      notedWebStatuses.add(key);
      dbg("[web] " + status + " " + url);
    }

    async function api(url, opts = {}) {
      const method = opts.method || "GET";
      const cacheable = method === "GET" && !!opts.ttlMs;
      if (cacheable) {
        const cached = cacheGet(url);
        if (cached !== null) return cached;
      }
      // Coalesce identical GETs already in flight (two tools, same URL).
      if (method === "GET") {
        const running = webInFlight.get(url);
        if (running) return running;
      }

      const run = (async () => {
        const headers = { ...(opts.headers || {}) };
        let token = getApiToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        if (opts.body !== undefined && !opts.raw) headers["Content-Type"] = "application/json";

        let body = opts.body;
        if (body !== undefined && typeof body !== "string") body = JSON.stringify(body);

        noteWebUse(url);
        const deadline = Date.now() + WEB_TOTAL_BUDGET_MS;
        let res = null;
        let netErr = null;
        for (let attempt = 0; attempt < WEB_MAX_ATTEMPTS; attempt++) {
          if (Date.now() >= deadline) break;
          await throttleWeb();

          // Bound every attempt: a stalled connection must surface as an error
          // well before the agent's tool timeout, never as a silent hang.
          const ctrl = typeof AbortController === "function" ? new AbortController() : null;
          const budget = Math.max(1000, Math.min(WEB_ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
          const timer = ctrl ? setTimeout(() => ctrl.abort(), budget) : null;
          try {
            res = await fetch(
              url,
              ctrl
                ? { method, headers, body, credentials: "omit", signal: ctrl.signal }
                : { method, headers, body, credentials: "omit" }
            );
            netErr = null;
            noteWebStatus(url, res.status);
          } catch (err) {
            netErr = err;
            res = null;
            dbg("[web] " + (err && err.name ? err.name : "network_error") + " " + url);
          } finally {
            if (timer) clearTimeout(timer);
          }

          if (!res) {
            if (attempt < WEB_MAX_ATTEMPTS - 1) {
              await sleep(Math.min(retryDelayMs(null, attempt), Math.max(0, deadline - Date.now())));
              continue;
            }
            break;
          }

          if (res.status === 401 && token) {
            const prev = token;
            await forceTokenRefresh();
            await sleep(800);
            const next = getApiToken();
            if (next && next !== prev) {
              token = next;
              headers.Authorization = `Bearer ${next}`;
              continue;
            }
          }
          if (WEB_RETRYABLE.has(res.status) && attempt < WEB_MAX_ATTEMPTS - 1) {
            const hinted = Number(res.headers.get("retry-after")) || 0;
            if (hinted * 1000 > WEB_RETRY_AFTER_MAX_MS) {
              // quota window exhausted: break immediately to surface informative 429
              break;
            }
            await sleep(Math.min(retryDelayMs(res, attempt), Math.max(0, deadline - Date.now())));
            continue;
          }
          break;
        }

        if (!res) {
          const err = new Error(
            `${method} ${url} -> ${netErr ? netErr.name || "network_error" : "deadline_exceeded"}`
          );
          err.code = netErr && netErr.name === "AbortError" ? "timeout" : "network_error";
          throw err;
        }
        if (res.status === 204) return {};
        if (!res.ok) {
          const err = new Error(`${method} ${url} -> HTTP ${res.status}`);
          err.code = res.status;
          if (res.status === 429) {
            const retryHeader = res.headers.get("retry-after");
            const hinted = Number(retryHeader);
            err.retryAfterSeconds = !isNaN(hinted) && hinted > 0 ? hinted : 30;
          }
          throw err;
        }
        const ct = res.headers.get("content-type") || "";
        const data = ct.includes("json") ? await res.json() : await res.text();
        if (cacheable) cacheSet(url, data, opts.ttlMs);
        return data;
      })();

      if (method === "GET") {
        webInFlight.set(url, run);
        run
          .catch(() => {})
          .finally(() => webInFlight.delete(url));
      }
      return run;
    }

    async function paginate(path, limit = 50, maxItems = 200) {
      const items = [];
      let offset = 0;
      while (offset < maxItems) {
        const body = await api(`${API}${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`);
        const arr = body.items || body.artists?.items || body.tracks?.items || [];
        items.push(...arr);
        if (arr.length < limit) break;
        offset += limit;
      }
      return items;
    }

    function chunk(list, size) {
      const out = [];
      for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
      return out;
    }

    function dedupe(list) {
      return [...new Set(list || [])];
    }

    // Normalizes the several track payload shapes (LibraryAPI/PlaylistAPI/web
    // API) into a single {uri, name, artists, artist_ids, album, duration_ms}.
    function mapTrack(it) {
      const artists = it.artists || it.track?.artists || [];
      return {
        uri: it.uri || it.track?.uri,
        name: it.name || it.track?.name,
        artists: artists.map((a) => a.name),
        artist_ids: artists.map((a) => a.id ?? String(a.uri).split(":").pop()),
        album: it.album?.name || it.track?.album?.name,
        duration_ms: it.duration?.milliseconds ?? it.track?.duration_ms,
      };
    }

    // =====================================================================
    // Internal API access layer (phase 1: Platform tier).
    //
    // Cheap first: Platform reads the client store (~zero network, no rate
    // limit) before falling back to the Web API. Tier 2 (GraphQL/Pathfinder)
    // lands in phase 2. Every platform resolver answers `null` when it is
    // unavailable, empty or throws, so the caller keeps its Web API path:
    // if a signature differs from what was measured in phase 0, nothing
    // regresses -- the original behaviour still runs.
    // =====================================================================
    const ACCESS_SOURCE = { PLATFORM: "platform", GRAPHQL: "graphql", WEB: "webapi" };

    function platformApi(namespace, method) {
      const p = Spicetify && Spicetify.Platform;
      const ns = p && p[namespace];
      return ns && typeof ns[method] === "function" ? ns : null;
    }

    function playlistUri(ref) {
      const s = String(ref || "");
      return s.startsWith("spotify:") ? s : `spotify:playlist:${idOf(s)}`;
    }

    function apiPlaylist(p) {
      return {
        id: p.id,
        uri: p.uri,
        name: p.name,
        tracks: p.tracks ? p.tracks.total ?? null : null,
        image: p.images && p.images[0] ? p.images[0].url : null,
      };
    }

    // Persisted-query hashes captured in phase 0 (see agent/data/probes/*.json
    // and PLAN-INTERNAL-API.md 11.3). Phase 6 hardening: if a future spicetify
    // drops a definition, the request can still be issued by hash.
    const GRAPHQL_HASHES = {
      queryArtistOverview: "9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6",
    };

    const Access = {
      platform: {
        async playlists(limit) {
          const LibraryAPI = platformApi("LibraryAPI", "getContents");
          if (!LibraryAPI) return null;
          try {
            const res = await LibraryAPI.getContents({ filters: [], limit, offset: 0 });
            const items = res && Array.isArray(res.items) ? res.items : [];
            if (!items.length) return null;
            return items.map((p) => ({
              id: (p.uri || p.id || "").split(":").pop(),
              uri: p.uri,
              name: p.name,
              tracks: Array.isArray(p.numberOfItemsPerLinkType)
                ? p.numberOfItemsPerLinkType.reduce((acc, l) => acc + ((l && l.numItems) || 0), 0)
                : null,
              image: p.imageUrl || (Array.isArray(p.images) && p.images[0] ? p.images[0].url : null),
            }));
          } catch (err) {
            return null;
          }
        },

        async playlistTracks(ref, maxItems) {
          const PlaylistAPI = platformApi("PlaylistAPI", "getContents");
          if (!PlaylistAPI) return null;
          const uri = playlistUri(ref);
          try {
            const items = [];
            let offset = 0;
            while (offset < maxItems) {
              const res = await PlaylistAPI.getContents(uri, { offset, limit: MAX_PAGE_SIZE });
              const page = res && Array.isArray(res.items) ? res.items : [];
              items.push(...page);
              if (page.length < MAX_PAGE_SIZE) break;
              offset += MAX_PAGE_SIZE;
            }
            return items.length ? items.map(mapTrack) : null;
          } catch (err) {
            return null;
          }
        },

        async playlistContents(ref) {
          const PlaylistAPI = platformApi("PlaylistAPI", "getContents");
          if (!PlaylistAPI) return null;
          try {
            const res = await PlaylistAPI.getContents(playlistUri(ref));
            return res && Array.isArray(res.items) ? res.items : null;
          } catch (err) {
            return null;
          }
        },

        async savedTracks(limit) {
          const LibraryAPI = platformApi("LibraryAPI", "getTracks");
          if (!LibraryAPI) return null;
          try {
            const res = await LibraryAPI.getTracks({ offset: 0, limit });
            const items = res && Array.isArray(res.items) ? res.items : [];
            if (!items.length) return null;
            return items.map((it) => ({ ...mapTrack(it), added_at: it.addedAt ?? it.added_at }));
          } catch (err) {
            return null;
          }
        },

        async dumpLibrary(opts = {}) {
          const maxPlaylists = opts.max_playlists || 100;
          const includeTracks = opts.include_tracks !== false;
          const includeSaved = !!opts.include_saved_tracks;

          let playlists = await this.playlists(maxPlaylists);
          if (!playlists) {
            try {
              playlists = await Access.web.myPlaylists(50);
            } catch (err) {
              playlists = [];
            }
          }

          const out = [];
          for (const pl of (playlists || []).slice(0, maxPlaylists)) {
            const entry = {
              id: pl.id,
              uri: pl.uri,
              name: pl.name,
              total_tracks: pl.tracks,
              image: pl.image,
            };
            if (includeTracks) {
              try {
                const tracks = await this.playlistTracks(pl.uri, MAX_PLAYLIST_TRACKS);
                entry.tracks = tracks || [];
              } catch (e) {
                entry.tracks = [];
              }
            }
            out.push(entry);
          }

          let saved = [];
          if (includeSaved) {
            try {
              saved = (await this.savedTracks(MAX_SAVED_TRACKS)) || [];
            } catch (e) {
              saved = [];
            }
          }

          return {
            source: ACCESS_SOURCE.PLATFORM,
            playlists_count: out.length,
            playlists: out,
            saved_tracks_count: saved.length,
            saved_tracks: saved,
          };
        },

        // --- mutations ---------------------------------------------------
        async createPlaylist(name, description, uris) {
          let pl = null;
          const RootlistAPI = platformApi("RootlistAPI", "createPlaylist");
          if (RootlistAPI) {
            try {
              pl = await RootlistAPI.createPlaylist(name, { after: "end" });
            } catch (err) {
              dbg("[tier] platform RootlistAPI.createPlaylist({after:'end'}) failed: " + (err?.message || err));
            }
            if (!pl || !pl.uri) {
              try {
                pl = await RootlistAPI.createPlaylist(name, {});
              } catch (err) {
                dbg("[tier] platform RootlistAPI.createPlaylist({}) failed: " + (err?.message || err));
              }
            }
            if (!pl || !pl.uri) {
              try {
                pl = await RootlistAPI.createPlaylist(name);
              } catch (err) {
                dbg("[tier] platform RootlistAPI.createPlaylist(name) failed: " + (err?.message || err));
              }
            }
          }

          // Fallback Cosmos IPC interno direto no processo C++ do Spotify
          if ((!pl || !pl.uri) && Spicetify && Spicetify.CosmosAsync && typeof Spicetify.CosmosAsync.post === "function") {
            try {
              const res = await Spicetify.CosmosAsync.post("sp://core-playlist/v1/rootlist", { name });
              if (res && (res.uri || res.playlist?.uri)) {
                pl = { uri: res.uri || res.playlist?.uri, name: res.name || res.playlist?.name || name };
              }
            } catch (err) {
              dbg("[tier] cosmos createPlaylist sp://core-playlist/v1/rootlist failed: " + (err?.message || err));
            }
          }

          if (!pl || !pl.uri) return null;

          try {
            const updateDetails = platformApi("PlaylistAPI", "updateDetails");
            const add = platformApi("PlaylistAPI", "add");
            if (description && updateDetails) {
              try {
                await updateDetails.updateDetails(pl.uri, { description });
              } catch (e) {
                dbg("[tier] PlaylistAPI.updateDetails error: " + (e?.message || e));
              }
            }
            let addedCount = 0;
            let batchCount = 0;
            if (uris.length && add) {
              const batches = chunk(uris, 100);
              batchCount = batches.length;
              for (const part of batches) {
                try {
                  await add.add(pl.uri, part, { after: "end" });
                  addedCount += part.length;
                } catch (e) {
                  dbg("[tier] PlaylistAPI.add batch error: " + (e?.message || e));
                }
              }
            }
            return {
              playlist_id: pl.uri.split(":").pop(),
              name: pl.name || name,
              url: null,
              uri: pl.uri,
              added: addedCount,
              batches: batchCount,
            };
          } catch (err) {
            dbg("[tier] createPlaylist post-creation step failed: " + (err?.message || err));
            return {
              playlist_id: pl.uri.split(":").pop(),
              name: pl.name || name,
              url: null,
              uri: pl.uri,
              added: 0,
            };
          }
        },

        async addTracks(ref, uris) {
          const PlaylistAPI = platformApi("PlaylistAPI", "add");
          if (!PlaylistAPI) return null;
          try {
            let addedCount = 0;
            for (const part of chunk(uris, 100)) {
              await PlaylistAPI.add(playlistUri(ref), part, { after: "end" });
              addedCount += part.length;
            }
            return { added: addedCount };
          } catch (err) {
            return null;
          }
        },

        async removeTracks(ref, uris) {
          const PlaylistAPI = platformApi("PlaylistAPI", "remove");
          if (!PlaylistAPI) return null;
          try {
            const contents = await Access.platform.playlistContents(ref);
            if (!contents) return null;
            const wanted = new Set(uris);
            const targets = [];
            for (const it of contents) {
              const tUri = it.uri || (it.track && it.track.uri);
              if (tUri && wanted.has(tUri)) targets.push({ uri: tUri, uid: it.uid });
            }
            if (!targets.length) return { removed: 0 };
            await PlaylistAPI.remove(playlistUri(ref), targets);
            return { removed: targets.length };
          } catch (err) {
            return null;
          }
        },

        async updateDetails(ref, patch) {
          const PlaylistAPI = platformApi("PlaylistAPI", "updateDetails");
          if (!PlaylistAPI) return null;
          try {
            await PlaylistAPI.updateDetails(playlistUri(ref), patch);
            return { ok: true };
          } catch (err) {
            return null;
          }
        },

        async uploadImage(ref, imageB64) {
          const PlaylistAPI = platformApi("PlaylistAPI", "uploadImage");
          if (!PlaylistAPI) return null;
          try {
            await PlaylistAPI.uploadImage(playlistUri(ref), imageB64);
            return { ok: true };
          } catch (err) {
            return null;
          }
        },

        // Argument shape not yet confirmed by a phase-0 network probe:
        // guarded so a wrong guess falls straight back to the Web API.
        async recommendedTracks(seedUris, limit) {
          const PlaylistAPI = platformApi("PlaylistAPI", "getRecommendedTracks");
          if (!PlaylistAPI) return null;
          try {
            const res = await PlaylistAPI.getRecommendedTracks(
              { uri: seedUris[0] || null, uris: seedUris },
              [],
              { limit }
            );
            const items = (res && (res.items || res.tracks)) || [];
            return items.length ? items.map(mapTrack) : null;
          } catch (err) {
            return null;
          }
        },
      },

      // Tier 2: GraphQL (Pathfinder). Shapes confirmed by the agent probe
      // (agent/data/probes/*.json). Only what is actually called -- no dead
      // surface. Note: queryArtistOverview exposes NO genres/popularity, so it
      // is used as resilience, not as a richer replacement.
      graphql: {
        available() {
          const g = Spicetify && Spicetify.GraphQL;
          return !!(g && g.Definitions && typeof g.Request === "function");
        },

        async request(name, variables) {
          const g = Spicetify && Spicetify.GraphQL;
          const def = g && g.Definitions && g.Definitions[name];

          // Preferred path: the bundled definition (spicetify resolves the hash).
          if (def && typeof g.Request === "function") {
            try {
              const r = await g.Request(def, variables, {});
              if (r && !r.errors) return r.data || r;
            } catch (err) {
              // fall through to the hash path
            }
          }

          // Hardening path: issue the persisted query by hash via CosmosAsync.
          const hash = GRAPHQL_HASHES[name];
          const cosmos = Spicetify && Spicetify.CosmosAsync;
          if (!hash || !cosmos || typeof cosmos.get !== "function") return null;
          try {
            const qs = new URLSearchParams({
              operationName: name,
              variables: JSON.stringify(variables || {}),
              extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
            });
            const r = await cosmos.get(`https://api-partner.spotify.com/pathfinder/v2/query?${qs}`);
            if (!r || r.errors) return null;
            return r.data || r;
          } catch (err) {
            return null;
          }
        },

        // queryArtistOverview -> artistUnion.relatedContent.relatedArtists.items
        async relatedArtists(uri, limit) {
          const data = await Access.graphql.request("queryArtistOverview", { uri });
          const rel = data && data.artistUnion && data.artistUnion.relatedContent;
          const items = (rel && rel.relatedArtists && rel.relatedArtists.items) || [];
          if (!items.length) return null;
          return items.slice(0, limit || 20).map((x) => ({
            id: x.id,
            uri: x.uri,
            name: (x.profile && x.profile.name) || null,
            genres: [],
            popularity: null,
          }));
        },

        // queryArtistOverview -> artistUnion. Note: this payload carries NO
        // genres/popularity (Spotify dropped them internally), but it does carry
        // the biography, followers and monthly listeners.
        async artist(uri) {
          const data = await Access.graphql.request("queryArtistOverview", { uri });
          const a = data && data.artistUnion;
          if (!a || !a.uri) return null;
          const sources = (a.visuals && a.visuals.avatarImage && a.visuals.avatarImage.sources) || [];
          const img = sources.length ? sources[sources.length - 1].url : null;
          return {
            id: a.id,
            uri: a.uri,
            name: (a.profile && a.profile.name) || null,
            biography: (a.profile && a.profile.biography && a.profile.biography.text) || null,
            followers: (a.stats && a.stats.followers) ?? null,
            monthly_listeners: (a.stats && a.stats.monthlyListeners) ?? null,
            image: img,
            genres: [],
            popularity: null,
            external_url: null,
          };
        },

        // getTrack -> trackUnion
        async track(uri) {
          const data = await Access.graphql.request("getTrack", { uri });
          const t = data && data.trackUnion;
          if (!t || !t.uri) return null;
          const first = (t.firstArtist && t.firstArtist.items) || [];
          const other = (t.otherArtists && t.otherArtists.items) || [];
          const artists = [];
          const artistUris = [];
          for (const x of [...first, ...other]) {
            const n = (x.profile && x.profile.name) || null;
            if (n) artists.push(n);
            if (x.uri) artistUris.push(x.uri);
          }
          const sources = (t.albumOfTrack && t.albumOfTrack.coverArt && t.albumOfTrack.coverArt.sources) || [];
          return {
            uri: t.uri,
            name: t.name,
            artists,
            artist_ids: artistUris.map((u) => String(u).split(":").pop()),
            album: (t.albumOfTrack && t.albumOfTrack.name) || null,
            duration_ms: (t.duration && t.duration.totalMilliseconds) || null,
            image: sources.length ? sources[sources.length - 1].url : null,
          };
        },
        // searchModalResults -> searchV2.topResultsV2.itemsV2[].item
        // The inner `item` wrapper is not enumerated by the probe, so extraction
        // is structural: collect any node carrying a spotify URI plus a name.
        async search(term, limit) {
          const data = await Access.graphql.request("searchModalResults", {
            searchTerm: term,
            limit: limit || 20,
            offset: 0,
            numberOfTopResults: 5,
            includeArtistHasConcertsField: false,
            includeAudiobooks: false,
            includeAuthors: false,
            includePreReleases: false,
          });
          const groups = data && data.searchV2 && data.searchV2.topResultsV2 && data.searchV2.topResultsV2.itemsV2;
          if (!Array.isArray(groups) || !groups.length) return null;
          const found = [];
          const seen = new Set();
          const walk = (node, depth) => {
            if (!node || typeof node !== "object" || depth > 8) return;
            if (Array.isArray(node)) {
              for (const v of node) walk(v, depth + 1);
              return;
            }
            if (typeof node.uri === "string" && typeof node.name === "string" && !seen.has(node.uri)) {
              seen.add(node.uri);
              found.push(node);
            }
            for (const k of Object.keys(node)) walk(node[k], depth + 1);
          };
          for (const g of groups) walk(g, 0);
          if (!found.length) return null;
          const buckets = { tracks: [], artists: [], albums: [], playlists: [] };
          const bucketOf = {
            "spotify:track:": "tracks",
            "spotify:artist:": "artists",
            "spotify:album:": "albums",
            "spotify:playlist:": "playlists",
          };
          for (const n of found) {
            for (const prefix of Object.keys(bucketOf)) {
              if (n.uri.startsWith(prefix)) {
                buckets[bucketOf[prefix]].push({ id: (n.id ?? n.uri.split(":").pop()), uri: n.uri, name: n.name });
                break;
              }
            }
          }
          if (!buckets.tracks.length && !buckets.artists.length && !buckets.albums.length && !buckets.playlists.length) return null;
          return buckets;
        },
      },

      // Tier 3: the original Web API calls, kept intact as the fallback path.
      web: {
        async myPlaylists(limit) {
          const raw = await api(`${API}/me/playlists?limit=${limit || PAGE_SIZE}&offset=0`);
          const items = raw && raw.items ? raw.items : [];
          return items.map(apiPlaylist);
        },
      },
    };

    async function listeningRecents(limit) {
      const P = Spicetify && Spicetify.Platform;
      const R = P && P.RecentsAPI;
      if (!R || typeof R.getContents !== "function") return null;
      try {
        const res = await R.getContents({ limit: limit || 50, offset: 0 });
        const items = res && Array.isArray(res.items) ? res.items : [];
        if (!items.length) return null;
        return items.map((it) => {
          const dur = it && typeof it.duration === "number" ? it.duration : null;
          return {
            uri: it.uri,
            name: it.name,
            artists: Array.isArray(it.artists) ? it.artists.map((a) => a.name) : [],
            artist_ids: Array.isArray(it.artists) ? it.artists.map((a) => a.uri?.split(":").pop() || a.id || "") : [],
            album: it.album?.name || null,
            duration_ms: dur,
            added_at: it.addedAt,
            fully_played: it.fullyPlayed ?? null,
            resume_position_ms: it.resumePositionMs ?? null,
          };
        });
      } catch (err) {
        return null;
      }
    }

    // ---------------------------------------------------------------------
    // Player / playback layer.
    // Everything reads the client's own state (Spicetify.Player +
    // Platform.PlayerAPI/PlaybackAPI/ConnectDevicesAPI): no Web API call and
    // therefore no rate limit. Field names confirmed by the phase-0 probe
    // (agent/data/probes/*.json): `positionAsOfTimestamp` + `timestamp`,
    // `duration` as a number of ms, `isPaused`, `shuffle`, `repeat`, `speed`,
    // `sleepTimer`, `playbackQuality`, `restrictions`.
    // ---------------------------------------------------------------------
    function playerState() {
      const p = Spicetify && Spicetify.Player;
      if (p && p.data) return p.data;
      const P = Spicetify && Spicetify.Platform;
      if (P && P.PlayerAPI && typeof P.PlayerAPI.getState === "function") {
        try {
          return P.PlayerAPI.getState();
        } catch (err) {
          return null;
        }
      }
      return null;
    }

    function playheadMs(d) {
      const pos = d && typeof d.positionAsOfTimestamp === "number" ? d.positionAsOfTimestamp : null;
      if (pos == null) return null;
      const ts = d && typeof d.timestamp === "number" ? d.timestamp : null;
      return ts == null ? pos : Math.max(0, pos + (Date.now() - ts));
    }

    function trackMs(d, item) {
      if (d && typeof d.duration === "number") return d.duration;
      if (item && item.duration && typeof item.duration.milliseconds === "number") return item.duration.milliseconds;
      if (d && d.duration && typeof d.duration.milliseconds === "number") return d.duration.milliseconds;
      return null;
    }

    function queueItem(x) {
      if (!x || typeof x !== "object") return null;
      const it = x.item || x.track || x;
      const t = mapTrack(it);
      return t.uri ? t : null;
    }

    const PlayerOps = {
      state() {
        const d = playerState();
        if (!d) return null;
        const item = d.item || null;
        const p = Spicetify && Spicetify.Player;
        const P = Spicetify && Spicetify.Platform;
        let vol = null;
        if (p && typeof p.getVolume === "function") vol = p.getVolume();
        else if (P && P.PlaybackAPI && typeof P.PlaybackAPI.getVolume === "function") vol = P.PlaybackAPI.getVolume();
        const track = item ? mapTrack(item) : null;
        if (track) track.duration_ms = trackMs(d, item);
        return {
          is_playing: typeof d.isPaused === "boolean" ? !d.isPaused : null,
          is_buffering: d.isBuffering ?? null,
          progress_ms: playheadMs(d),
          duration_ms: trackMs(d, item),
          volume: typeof vol === "number" ? Math.round(vol * 100) / 100 : null,
          muted: p && typeof p.getMute === "function" ? p.getMute() : null,
          shuffle: d.shuffle ?? null,
          repeat: d.repeat ?? null,
          speed: d.speed ?? null,
          sleep_timer: d.sleepTimer ?? null,
          playback_quality: d.playbackQuality ?? null,
          context_uri: (d.context && d.context.uri) || null,
          index: d.index ?? null,
          restrictions: d.restrictions ?? null,
          track,
        };
      },

      async queue() {
        const P = Spicetify && Spicetify.Platform;
        if (!P || !P.PlayerAPI || typeof P.PlayerAPI.getQueue !== "function") return null;
        try {
          const q = await P.PlayerAPI.getQueue();
          if (!q) return null;
          const list = (arr) => (Array.isArray(arr) ? arr.map(queueItem).filter(Boolean) : []);
          return {
            current: queueItem(q.current),
            next_up: list(q.nextUp),
            queued: list(q.queued),
          };
        } catch (err) {
          return null;
        }
      },

      async devices() {
        const P = Spicetify && Spicetify.Platform;
        if (!P || !P.ConnectDevicesAPI || typeof P.ConnectDevicesAPI.getDevices !== "function") return null;
        try {
          const res = await P.ConnectDevicesAPI.getDevices();
          const arr = Array.isArray(res) ? res : res && Array.isArray(res.devices) ? res.devices : [];
          if (!arr.length) return null;
          return arr.map((x) => {
            const d = x && x.device ? x.device : x;
            let vol = d && typeof d.volume === "number" ? d.volume : null;
            if (vol != null && vol > 1) vol = Math.round((vol / 65535) * 100) / 100; // Connect volume is 0..65535
            return {
              id: d && d.id,
              name: d && d.name,
              type: d && d.type,
              is_active: !!(d && d.isActive),
              volume: vol,
            };
          });
        } catch (err) {
          return null;
        }
      },

      // Transient playback control: no snapshot, no confirmation gate (nothing
      // is destroyed, and every action is immediately reversible by the user).
      control(action, a) {
        const p = Spicetify && Spicetify.Player;
        const P = Spicetify && Spicetify.Platform;
        if (!p) return { ok: false, code: "player_unavailable" };
        try {
          switch (action) {
            case "play":
              p.play();
              return { ok: true };
            case "pause":
              p.pause();
              return { ok: true };
            case "toggle":
              p.togglePlay();
              return { ok: true };
            case "next":
              p.next();
              return { ok: true };
            case "previous":
              p.back();
              return { ok: true };
            case "seek":
              if (typeof a.position_ms !== "number") return { ok: false, code: "missing_position_ms" };
              p.seek(a.position_ms);
              return { ok: true, position_ms: a.position_ms };
            case "shuffle":
              if (typeof a.shuffle !== "boolean") return { ok: false, code: "missing_shuffle" };
              p.setShuffle(a.shuffle);
              return { ok: true, shuffle: a.shuffle };
            case "repeat":
              if (a.repeat !== 0 && a.repeat !== 1 && a.repeat !== 2) return { ok: false, code: "repeat_must_be_0_1_2" };
              p.setRepeat(a.repeat);
              return { ok: true, repeat: a.repeat };
            case "volume":
              if (typeof a.volume !== "number") return { ok: false, code: "missing_volume" };
              p.setVolume(Math.max(0, Math.min(1, a.volume)));
              return { ok: true, volume: Math.max(0, Math.min(1, a.volume)) };
            case "mute":
              if (typeof a.mute !== "boolean") return { ok: false, code: "missing_mute" };
              p.setMute(a.mute);
              return { ok: true, mute: a.mute };
            case "speed":
              if (!P || !P.PlayerAPI || typeof P.PlayerAPI.setSpeed !== "function") return { ok: false, code: "speed_unavailable" };
              P.PlayerAPI.setSpeed(typeof a.speed === "number" ? a.speed : 1);
              return { ok: true, speed: typeof a.speed === "number" ? a.speed : 1 };
            case "sleep_timer":
              if (!P || !P.PlayerAPI || typeof P.PlayerAPI.setSleepTimer !== "function") {
                return { ok: false, code: "sleep_timer_unavailable" };
              }
              P.PlayerAPI.setSleepTimer(typeof a.minutes === "number" ? a.minutes * 60000 : null);
              return { ok: true, minutes: typeof a.minutes === "number" ? a.minutes : null };
            default:
              return { ok: false, code: "unknown_action:" + action };
          }
        } catch (err) {
          return { ok: false, code: String((err && err.message) || err) };
        }
      },

      async queueControl(action, a) {
        const P = Spicetify && Spicetify.Platform;
        const PA = P && P.PlayerAPI;
        if (!PA) return { ok: false, code: "player_api_unavailable" };
        try {
          const need = (fn) => (typeof PA[fn] === "function" ? PA[fn].bind(PA) : null);
          switch (action) {
            case "add": {
              const fn = need("addToQueue");
              if (!fn) return { ok: false, code: "add_unavailable" };
              await fn(a.uri, {});
              return { ok: true, uri: a.uri };
            }
            case "insert_next": {
              const fn = need("insertIntoQueue");
              if (!fn) return { ok: false, code: "insert_unavailable" };
              await fn(a.uri, 0, {});
              return { ok: true, uri: a.uri };
            }
            case "remove": {
              const fn = need("removeFromQueue");
              if (!fn) return { ok: false, code: "remove_unavailable" };
              await fn(a.index);
              return { ok: true, index: a.index };
            }
            case "reorder": {
              const fn = need("reorderQueue");
              if (!fn) return { ok: false, code: "reorder_unavailable" };
              await fn(a.from, a.to);
              return { ok: true };
            }
            case "clear": {
              const fn = need("clearQueue");
              if (!fn) return { ok: false, code: "clear_unavailable" };
              await fn();
              return { ok: true };
            }
            default:
              return { ok: false, code: "unknown_action:" + action };
          }
        } catch (err) {
          return { ok: false, code: String((err && err.message) || err) };
        }
      },
    };

    // ---------------------------------------------------------------------
    // Phase 0 probe (agent-triggered, read-only).
    // GET /probe on the agent calls this and writes the result to
    // agent/data/probes/*.json, so the inventory never has to be copied out
    // of DevTools by hand. It reads APIs and shapes; it mutates nothing.
    // ---------------------------------------------------------------------
    const PROBE_ARTIST = "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb"; // Radiohead
    const PROBE_ALBUM = "spotify:album:6dVIqQ8qmQ5GBnJ9shOYGE"; // OK Computer
    const PROBE_TRACK = "spotify:track:4iV5W9uYEdYUVa79Axb7Rh";

    function atPath(obj, path) {
      return String(path).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
    }

    // Bounded node description: 2 object levels, arrays collapse to item[0].
    function describeNode(v, depth = 0) {
      if (v === null) return "null";
      if (v === undefined) return "undefined";
      if (Array.isArray(v)) return v.length ? { len: v.length, item: describeNode(v[0], depth + 1) } : "[]";
      if (typeof v === "object") {
        if (depth >= 2) return Object.keys(v).slice(0, 25);
        const o = {};
        for (const k of Object.keys(v).slice(0, 25)) o[k] = describeNode(v[k], depth + 1);
        return o;
      }
      return typeof v;
    }

    // Platform APIs are class instances: methods live on the prototype.
    function methodsOf(obj) {
      if (!obj) return [];
      const names = new Set();
      let o = obj;
      let depth = 0;
      while (o && o !== Object.prototype && depth < 6) {
        for (const n of Object.getOwnPropertyNames(o)) {
          if (n === "constructor") continue;
          let isFn = false;
          try {
            isFn = typeof obj[n] === "function";
          } catch (err) {
            isFn = false;
          }
          if (isFn) names.add(n);
        }
        o = Object.getPrototypeOf(o);
        depth += 1;
      }
      return [...names].sort();
    }

    async function runProbe() {
      const out = { guard: {}, platform: {}, graphql: {}, shapes: {}, runtime: {} };
      out.guard.spicetifyVersion = Spicetify && Spicetify.Config ? Spicetify.Config.version : null;
      out.guard.spotifyVersion = Spicetify && Spicetify.Platform ? Spicetify.Platform.version : null;
      out.guard.hasGraphQL = !!(Spicetify && Spicetify.GraphQL);
      out.guard.userAgent = navigator.userAgent;

      // Fase 0 (PLAN-REFACTOR.md, D2): decide how the daemon autostarts.
      // node == true  -> the extension can spawn euterpe.exe itself
      //                  (with a port guard against double-binding 8337);
      // node == false -> fall back to a Startup shortcut + `euterpe --ensure`.
      out.runtime = {
        node: typeof require === "function" || typeof process !== "undefined",
        electron: (typeof process !== "undefined" && process.versions && process.versions.electron) || null,
        nodeVersion: (typeof process !== "undefined" && process.versions && process.versions.node) || null,
        requireType: typeof require,
        spawnAvailable: (() => {
          try {
            if (typeof require !== "function") return false;
            const cp = require("child_process");
            return typeof cp?.spawn === "function";
          } catch (err) {
            return false;
          }
        })(),
      };

      const namespaces = [
        "LibraryAPI", "PlaylistAPI", "RootlistAPI", "PlayerAPI", "PlayHistoryAPI",
        "RecentlyPlayedAPI", "RecentsAPI", "CollectionPlatformAPI", "PlaybackAPI",
        "UserAPI", "FollowAPI", "ListPlatformAPI", "CurationAPI",
        "AssistedCurationAPI", "ShowAPI", "LocalFilesAPI",
        "ConnectDevicesAPI", "ConnectTransferAPI", "ConnectAPI", "ConnectDeviceManagementAPI",
      ];
      const P = Spicetify && Spicetify.Platform;
      for (const n of namespaces) {
        const api = P && P[n];
        out.platform[n] = api ? methodsOf(api) : null;
      }

      const defs = (Spicetify && Spicetify.GraphQL && Spicetify.GraphQL.Definitions) || {};
      out.graphql.names = Object.keys(defs).sort();
      out.graphql.hashes = {};
      for (const n of out.graphql.names) {
        const d = defs[n];
        if (d && typeof d === "object" && typeof d.sha256Hash === "string") out.graphql.hashes[n] = d.sha256Hash;
      }

      const gqlProbe = async (name, vars, paths) => {
        const def = defs[name];
        if (!def || typeof Spicetify.GraphQL.Request !== "function") {
          out.shapes["gql:" + name] = { error: "definition_missing" };
          return;
        }
        try {
          const r = await Spicetify.GraphQL.Request(def, vars, {});
          if (r && r.errors) {
            out.shapes["gql:" + name] = { error: "graphql_errors", details: JSON.stringify(r.errors).slice(0, 400) };
            return;
          }
          const data = (r && r.data) || r || {};
          const res = { top: Object.keys(data).slice(0, 10) };
          for (const p of paths) res[p] = describeNode(atPath(data, p));
          out.shapes["gql:" + name] = res;
        } catch (err) {
          out.shapes["gql:" + name] = { error: String((err && err.message) || err) };
        }
      };

      await gqlProbe("queryArtistOverview", { uri: PROBE_ARTIST }, [
        "artistUnion.profile",
        "artistUnion.relatedContent.relatedArtists.items",
        "artistUnion.discography.topTracks.items",
        "artistUnion.visuals.avatarImage.sources",
      ]);
      await gqlProbe("getAlbum", { uri: PROBE_ALBUM, locale: "en", limit: 5, offset: 0 }, [
        "albumUnion.name",
        "albumUnion.artists.items",
        "albumUnion.tracks.items",
        "albumUnion.coverArt.sources",
      ]);
      await gqlProbe("getTrack", { uri: PROBE_TRACK }, ["trackUnion", "track"]);
      await gqlProbe("searchModalResults", {
        searchTerm: "miles davis",
        limit: 3,
        offset: 0,
        numberOfTopResults: 5,
        includeArtistHasConcertsField: false,
        includeAudiobooks: false,
        includeAuthors: false,
        includePreReleases: false,
      }, [
        "searchV2",
        "searchV2.tracksV2.items",
        "searchV2.albumsV2.items",
        "searchV2.artists.items",
        "searchV2.playlists.items",
      ]);
      await gqlProbe("home", { timeZone: "America/Sao_Paulo", country: "BR", facet: null, sectionItemsLimit: 10 }, ["home"]);
      await gqlProbe("getTrack", { uri: PROBE_TRACK }, ["trackUnion.associationsV3.audioAssociations.items"]);

      const platProbe = async (label, fn, paths) => {
        try {
          const r = await fn();
          const res = { top: r && typeof r === "object" ? Object.keys(r).slice(0, 12) : describeNode(r) };
          for (const p of paths || []) res[p] = describeNode(atPath(r, p));
          out.shapes["plat:" + label] = res;
        } catch (err) {
          out.shapes["plat:" + label] = { error: String((err && err.message) || err) };
        }
      };

      if (P) {
        await platProbe("PlayHistoryAPI.getContents", () => P.PlayHistoryAPI.getContents(), ["items"]);
        await platProbe("RecentsAPI.getContents", () => P.RecentsAPI.getContents(), ["items"]);
        await platProbe("CollectionPlatformAPI.get", () => P.CollectionPlatformAPI.get("spotify:collection:tracks"));
        const ctxUri =
          (Spicetify.Player && Spicetify.Player.data && Spicetify.Player.data.context && Spicetify.Player.data.context.uri) || null;
        if (ctxUri && ctxUri.includes(":playlist:")) {
          await platProbe("PlaylistAPI.getContents", () => P.PlaylistAPI.getContents(ctxUri, { offset: 0, limit: 2 }), ["items"]);
        } else {
          out.shapes["plat:PlaylistAPI.getContents"] = { skipped: "context is not a playlist (" + ctxUri + ")" };
        }
      }

      // --- player / playback / connect: needed to expose player features
      const Pl = Spicetify && Spicetify.Player;
      if (Pl) {
        out.shapes["player:Spicetify.Player"] = {
          keys: Object.keys(Pl).slice(0, 60),
          dataKeys: Pl.data ? Object.keys(Pl.data).slice(0, 60) : null,
          itemKeys: Pl.data && Pl.data.item ? Object.keys(Pl.data.item).slice(0, 60) : null,
          isPlaying: typeof Pl.isPlaying === "function" ? Pl.isPlaying() : null,
          progress: typeof Pl.getProgress === "function" ? Pl.getProgress() : null,
          duration: typeof Pl.getDuration === "function" ? Pl.getDuration() : null,
          volume: typeof Pl.getVolume === "function" ? Pl.getVolume() : null,
          shuffle: typeof Pl.getShuffle === "function" ? Pl.getShuffle() : null,
          repeat: typeof Pl.getRepeat === "function" ? Pl.getRepeat() : null,
        };
      }
      if (P) {
        await platProbe("PlayerAPI.getState", () => P.PlayerAPI.getState());
        await platProbe("PlayerAPI.getQueue", () => P.PlayerAPI.getQueue());
        await platProbe("PlayerAPI.getSleepTimerCore", () => P.PlayerAPI.getSleepTimerCore());
        await platProbe("PlaybackAPI.getPlaybackInfo", () => P.PlaybackAPI.getPlaybackInfo());
        await platProbe("PlaybackAPI.getVolume", () => P.PlaybackAPI.getVolume());
        if (P.ConnectDevicesAPI && typeof P.ConnectDevicesAPI.getDevices === "function") {
          await platProbe("ConnectDevicesAPI.getDevices", () => P.ConnectDevicesAPI.getDevices());
        }
      }

      return out;
    }

    async function execSpotifyTool(name, args) {
      try {
        let data;
        switch (name) {
          case "probe": {
            // Agent-triggered (GET /probe). Read-only inventory + shapes.
            data = await runProbe();
            break;
          }

          case "get_listening_recents": {
            data = await Access.platform.listeningRecents(args.limit);
            break;
          }
            case "get_currently_playing": {
            // Light slice of PlayerOps.state(): the client's own player state,
            // no Web API call, no rate limit.
            const s = PlayerOps.state();
            data =
              s && s.track
                ? {
                    is_playing: s.is_playing,
                    progress_ms: s.progress_ms,
                    duration_ms: s.duration_ms,
                    context_uri: s.context_uri,
                    shuffle: s.shuffle,
                    repeat: s.repeat,
                    volume: s.volume,
                    track: s.track,
                  }
                : null;
            break;
          }

          case "get_player_state": {
            data = PlayerOps.state();
            break;
          }

          case "get_player_queue": {
            data = await PlayerOps.queue();
            break;
          }

          case "get_connect_devices": {
            data = await PlayerOps.devices();
            break;
          }

          case "player_control": {
            const r = PlayerOps.control(args.action, args);
            if (!r.ok) return r;
            data = r;
            break;
          }

          case "player_queue_control": {
            const r = await PlayerOps.queueControl(args.action, args);
            if (!r.ok) return r;
            data = r;
            break;
          }

          case "get_playlists": {
            // Tier 1 (client store, no pagination) -> Tier 3 (Web API).
            let playlists = await Access.platform.playlists(MAX_LIBRARY_ITEMS);
            let source = ACCESS_SOURCE.PLATFORM;
            if (!playlists) {
              source = ACCESS_SOURCE.WEB;
              try {
                playlists = await Access.web.myPlaylists(PAGE_SIZE);
              } catch (err) {
                playlists = [];
              }
            }
            data = { source, total: playlists.length, playlists };
            break;
          }

          case "get_playlist_tracks": {
            // Tier 1 (PlaylistAPI, client store) -> Tier 3 (Web API).
            let tracks = await Access.platform.playlistTracks(args.playlist_id, MAX_PLAYLIST_TRACKS);
            if (!tracks) {
              const items = await paginate(`/playlists/${idOf(args.playlist_id)}/tracks`, PAGE_SIZE, MAX_PLAYLIST_TRACKS);
              tracks = items.map(mapTrack);
            }
            data = tracks;
            break;
          }

          case "get_saved_tracks": {
            // Tier 1 (LibraryAPI) -> Tier 3 (Web API).
            let rows = await Access.platform.savedTracks(MAX_SAVED_TRACKS);
            if (!rows) {
              const items = await paginate("/me/tracks", PAGE_SIZE, MAX_SAVED_TRACKS);
              rows = items.map((it) => ({ ...mapTrack(it), added_at: it.addedAt ?? it.added_at }));
            }
            data = rows;
            break;
          }

          case "get_top_artists": {
            const tr = args.time_range || "medium_term";
            const body = await api(`${API}/me/top/artists?time_range=${tr}&limit=50`, { ttlMs: CACHE_10MIN });
            data = (body.items ?? []).map((a) => ({
              id: a.id,
              name: a.name,
              genres: a.genres ?? [],
              popularity: a.popularity,
              image: a.images?.[0]?.url ?? null,
            }));
            break;
          }

          case "get_top_tracks": {
            const tr = args.time_range || "medium_term";
            const body = await api(`${API}/me/top/tracks?time_range=${tr}&limit=50`, { ttlMs: CACHE_10MIN });
            data = (body.items ?? []).map(mapTrack);
            break;
          }

          case "search_spotify": {
            const types = args.types || "track";
            const limit = Math.min(args.limit || 20, PAGE_SIZE);
            // GraphQL first: the Web API tier is the one that returns 429.
            const gql = await Access.graphql.search(args.q, limit);
            if (gql) {
              data = {
                source: ACCESS_SOURCE.GRAPHQL,
                tracks: gql.tracks.slice(0, limit),
                artists: gql.artists.slice(0, limit),
                albums: gql.albums.slice(0, limit),
                playlists: gql.playlists.slice(0, limit),
              };
              break;
            }
            const body = await api(`${API}/search?q=${encodeURIComponent(args.q)}&type=${types}&limit=${limit}`, { ttlMs: CACHE_10MIN });
            const pick = (arr) => (arr ?? []).map((x) => ({ id: x.id, uri: x.uri, name: x.name }));
            data = {
              source: ACCESS_SOURCE.WEB,
              tracks: pick(body.tracks?.items),
              artists: pick(body.artists?.items),
              albums: pick(body.albums?.items),
              playlists: (body.playlists?.items ?? []).map((p) => ({ id: p.id, name: p.name })),
            };
            break;
          }

          case "get_related_artists": {
            const aid = idOf(args.artist_id);
            // Web API first: it is richer (genres + popularity). GraphQL is the
            // resilience path -- /related-artists has been deprecated since
            // 2024-11, so this tool must not depend on that endpoint alone.
            let artists = null;
            try {
              const body = await api(`${API}/artists/${aid}/related-artists`, { ttlMs: CACHE_24H });
              artists = (body.artists ?? []).map((a) => ({ id: a.id, name: a.name, genres: a.genres ?? [], popularity: a.popularity }));
            } catch (err) {
              artists = null;
            }
            if (!artists || !artists.length) {
              artists = await Access.graphql.relatedArtists(`spotify:artist:${aid}`, 20);
            }
            data = artists || [];
            break;
          }

          case "get_artist": {
            const aid = idOf(args.artist_id);
            // GraphQL first: the Web API tier is the one that gets rate limited
            // (measured: /artists/{id} -> 429 after Retry-After). The internal
            // payload also carries the biography, which the Web API does not.
            let artist = await Access.graphql.artist(`spotify:artist:${aid}`);
            if (!artist) {
              const a = await api(`${API}/artists/${aid}`, { ttlMs: CACHE_24H });
              artist = {
                id: a.id,
                name: a.name,
                biography: null,
                followers: a.followers?.total ?? null,
                image: a.images?.[0]?.url ?? null,
                genres: a.genres ?? [],
                popularity: a.popularity,
                external_url: a.external_urls?.spotify ?? null,
              };
            }
            data = artist;
            break;
          }

          case "get_recommendations": {
            // Tier 1 (PlaylistAPI.getRecommendedTracks, guarded -- arg shape
            // not yet confirmed) -> Tier 3 (Web API).
            const seeds = [
              ...(args.seed_tracks || []).map((t) => `spotify:track:${idOf(t)}`),
              ...(args.seed_artists || []).map((a) => `spotify:artist:${idOf(a)}`),
            ];
            let tracks = await Access.platform.recommendedTracks(seeds, Math.min(args.limit || 20, MAX_PAGE_SIZE));
            if (!tracks) {
              const q = new URLSearchParams();
              if (args.seed_artists?.length) q.set("seed_artists", args.seed_artists.map(idOf).join(","));
              if (args.seed_tracks?.length) q.set("seed_tracks", args.seed_tracks.map(idOf).join(","));
              if (args.seed_genres?.length) q.set("seed_genres", args.seed_genres.join(","));
              q.set("limit", String(Math.min(args.limit || 20, MAX_PAGE_SIZE)));
              const body = await api(`${API}/recommendations?${q}`, { ttlMs: CACHE_5MIN });
              tracks = (body.tracks ?? []).map(mapTrack);
            }
            data = tracks;
            break;
          }

          case "get_several_artists": {
            const ids = (args.ids ?? []).map(idOf);
            // GraphQL first (internal). Note: genres are NOT exposed internally
            // by Spotify, so they come back empty here -- artist_info (Last.fm,
            // server side, no Web quota) is the genres/tags source.
            if (ids.length && ids.length <= 10) {
              const gqlArtists = [];
              for (const id of ids) {
                const a = await Access.graphql.artist(`spotify:artist:${id}`);
                if (a) gqlArtists.push({ id: a.id, name: a.name, genres: [], popularity: a.popularity, image: a.image });
              }
              if (gqlArtists.length) {
                data = gqlArtists;
                break;
              }
            }
            const out = [];
            for (const part of chunk(ids, PAGE_SIZE)) {
              const body = await api(`${API}/artists?ids=${part.join(",")}`, { ttlMs: CACHE_24H });
              out.push(...(body.artists ?? []));
            }
            data = out.map((a) => ({ id: a.id, name: a.name, genres: a.genres ?? [], popularity: a.popularity, image: a.images?.[0]?.url ?? null }));
            break;
          }

          case "get_several_tracks": {
            const ids = (args.ids ?? []).map(idOf);
            // GraphQL first (internal, not rate limited) for small batches; the
            // Web API tier is the one that returns 429. Large batches keep the
            // single Web batch call, which is cheaper than N GraphQL requests.
            if (ids.length && ids.length <= 10) {
              const gqlTracks = [];
              for (const id of ids) {
                const t = await Access.graphql.track(`spotify:track:${id}`);
                if (t) gqlTracks.push(t);
              }
              if (gqlTracks.length) {
                data = gqlTracks;
                break;
              }
            }
            const out = [];
            for (const part of chunk(ids, PAGE_SIZE)) {
              const body = await api(`${API}/tracks?ids=${part.join(",")}`, { ttlMs: CACHE_24H });
              out.push(...(body.tracks ?? []));
            }
            data = out.map(mapTrack);
            break;
          }

          case "new_releases": {
            const limit = Math.min(args.limit || 20, PAGE_SIZE);
            const body = await api(`${API}/browse/new-releases?limit=${limit}`, { ttlMs: CACHE_30MIN });
            data = (body.albums?.items ?? []).map((al) => ({
              uri: al.uri,
              name: al.name,
              artists: (al.artists ?? []).map((a) => a.name),
              release_date: al.release_date,
            }));
            break;
          }

          case "create_playlist": {
            const uris = dedupe(args.tracks);
            // Tier 1 (RootlistAPI + PlaylistAPI) -> Tier 3 (Web API).
            let created = await Access.platform.createPlaylist(args.name, args.description, uris);
            if (!created) {
              const me = await api(`${API}/me`);
              const body = { name: args.name, public: false };
              if (args.description) body.description = args.description;
              const pl = await api(`${API}/users/${me.id}/playlists`, { method: "POST", body });
              let addedCount = 0;
              const batches = chunk(uris, 100);
              for (const part of batches) {
                await api(`${API}/playlists/${pl.id}/tracks`, { method: "POST", body: { uris: part } });
                addedCount += part.length;
              }
              created = {
                playlist_id: pl.id,
                name: pl.name,
                url: pl.external_urls?.spotify ?? null,
                added: addedCount,
                batches: batches.length,
              };
            }
            data = created;
            break;
          }

          case "add_tracks": {
            const uris = dedupe(args.uris);
            // Tier 1 (PlaylistAPI) -> Tier 3 (Web API).
            let res = await Access.platform.addTracks(args.playlist_id, uris);
            if (!res) {
              let addedCount = 0;
              for (const part of chunk(uris, 100)) {
                await api(`${API}/playlists/${idOf(args.playlist_id)}/tracks`, { method: "POST", body: { uris: part } });
                addedCount += part.length;
              }
              res = { added: addedCount };
            }
            data = res;
            break;
          }

          case "remove_tracks": {
            const uris = dedupe(args.uris);
            // Tier 1 (PlaylistAPI, resolves uid from contents) -> Tier 3.
            let res = await Access.platform.removeTracks(args.playlist_id, uris);
            if (!res) {
              const pid = idOf(args.playlist_id);
              for (const part of chunk(uris, 100)) {
                await api(`${API}/playlists/${pid}/tracks`, { method: "DELETE", body: { tracks: part.map((uri) => ({ uri })) } });
              }
              res = { removed: uris.length };
            }
            data = res;
            break;
          }

          case "set_playlist_details": {
            const patch = {};
            if (args.name) patch.name = args.name;
            if (args.description !== undefined) patch.description = args.description;
            // Tier 1 (PlaylistAPI.updateDetails) -> Tier 3 (Web API).
            let res = await Access.platform.updateDetails(args.playlist_id, patch);
            if (!res) {
              await api(`${API}/playlists/${idOf(args.playlist_id)}`, { method: "PUT", body: patch });
              res = { ok: true };
            }
            data = res;
            break;
          }

          case "replace_playlist_tracks": {
            const uris = dedupe(args.uris);
            // No atomic replace internally: drop every current uid, then add.
            const contents = await Access.platform.playlistContents(args.playlist_id);
            const rm = platformApi("PlaylistAPI", "remove");
            const addApi = platformApi("PlaylistAPI", "add");
            if (contents && rm && addApi) {
              const targets = contents
                .map((it) => ({ uri: it.uri || (it.track && it.track.uri), uid: it.uid }))
                .filter((t) => t.uri && t.uid);
              if (targets.length) await rm.remove(playlistUri(args.playlist_id), targets);
              if (uris.length) await addApi.add(playlistUri(args.playlist_id), uris, { after: "end" });
              data = { replaced: uris.length };
              break;
            }
            await api(`${API}/playlists/${idOf(args.playlist_id)}/tracks`, { method: "PUT", body: { uris } });
            data = { replaced: uris.length };
            break;
          }

          case "set_playlist_cover": {
            // Tier 1 (PlaylistAPI.uploadImage) -> Tier 3 (Web API).
            let res = await Access.platform.uploadImage(args.playlist_id, args.image_b64);
            if (!res) {
              await api(`${API}/playlists/${idOf(args.playlist_id)}/images`, {
                method: "PUT",
                body: args.image_b64,
                raw: true,
                headers: { "Content-Type": "image/jpeg" },
              });
              res = { ok: true };
            }
            data = res;
            break;
          }

          case "dump_library": {
            data = await Access.platform.dumpLibrary(args);
            break;
          }

          case "batch_create_playlists": {
            const list = Array.isArray(args.playlists) ? args.playlists : [];
            const delay = typeof args.delay_between_ms === "number" ? Math.max(0, args.delay_between_ms) : 1500;
            const results = [];
            for (let i = 0; i < list.length; i++) {
              const p = list[i];
              if (!p || !p.name) continue;
              const uris = dedupe(p.tracks || []);
              let created = await Access.platform.createPlaylist(p.name, p.description, uris);
              if (!created) {
                try {
                  const me = await api(`${API}/me`);
                  const body = { name: p.name, public: false };
                  if (p.description) body.description = p.description;
                  const pl = await api(`${API}/users/${me.id}/playlists`, { method: "POST", body });
                  let addedCount = 0;
                  const batches = chunk(uris, 100);
                  for (const part of batches) {
                    await api(`${API}/playlists/${pl.id}/tracks`, { method: "POST", body: { uris: part } });
                    addedCount += part.length;
                  }
                  created = {
                    playlist_id: pl.id,
                    name: pl.name,
                    url: pl.external_urls?.spotify ?? null,
                    added: addedCount,
                    batches: batches.length,
                  };
                } catch (e) {
                  created = { ok: false, error: e?.message || String(e) };
                }
              }
              results.push(created);
              if (delay > 0 && i < list.length - 1) {
                await sleep(delay);
              }
            }
            data = {
              total_requested: list.length,
              created_count: results.filter((r) => r && r.playlist_id).length,
              results,
            };
            break;
          }

          default:
            return { ok: false, code: "tool_not_implemented:" + name };
        }
        return { ok: true, data };
      } catch (err) {
        if (err && err.code === 429) {
          const retryAfter = err.retryAfterSeconds || 30;
          return {
            ok: false,
            code: "rate_limited",
            data: {
              retry_after_seconds: retryAfter,
              hint: "Limite de requisições do Spotify atingido. Recarregue o Spotify Desktop (Ctrl+R) para um novo token ou aguarde o cooldown."
            }
          };
        }
        const code = String(err?.message || err);
        return { ok: false, code };
      }
    }

    function getLocale() {
      try {
        if (Spicetify && Spicetify.Locale && typeof Spicetify.Locale.getLocale === "function") {
          const l = Spicetify.Locale.getLocale();
          if (l) return String(l);
        }
      } catch (err) {}
      try {
        return navigator.language || null;
      } catch (err) {}
      return null;
    }

    function connect() {
      fetch(AGENT_URL + "/config")
        .then((r) => r.json())
        .then((cfg) => {
          agentVersion = cfg.version || null;
          const sock = new WebSocket(WS_URL);
          ws = sock;

          sock.onopen = () => {
            retry = 0;
            sock.send(JSON.stringify({ type: "hello", secret: cfg.secret, appVersion: "0.1.0", locale: getLocale() }));
          };

          sock.onmessage = async (ev) => {
            // Stale-socket guard: ignore messages from a previous connection
            // that may still be in flight after a reconnect.
            if (sock !== ws) return;
            let msg;
            try {
              msg = JSON.parse(ev.data);
            } catch {
              return;
            }

            if (msg.type === "tool.call") {
              const result = await execSpotifyTool(msg.name, msg.args || {});
              if (sock === ws && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: result.ok, data: result.data, code: result.code }));
              }
              return;
            }

            notify(msg);
          };

          sock.onclose = () => {
            if (sock !== ws) return;
            notify({ type: "chat.status", status: "offline", detail: tr("disconnected") });
            scheduleReconnect();
          };

          sock.onerror = () => {
            try {
              sock.close();
            } catch (err) {}
          };
        })
        .catch(() => scheduleReconnect());
    }

    function scheduleReconnect() {
      const delay = Math.min(1000 * 2 ** retry, RECONNECT_MAX_DELAY);
      retry += 1;
      setTimeout(connect, delay);
    }

    function send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        notify({ type: "chat.status", status: "offline", detail: tr("disconnected") });
        return false;
      }
      ws.send(JSON.stringify(msg));
      return true;
    }

    function dbg(detail, level) {
      const lvl = level || "log";
      try {
        console[lvl]("[euterpe]", detail);
      } catch (err) {}
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "client.debug", level: lvl, detail: String(detail) }));
        }
      } catch (err) {}
    }

    window.euterpe = {
      send,
      onMessage(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      execSpotifyTool,
      openUri(uri) {
        const P = Spicetify && Spicetify.Platform;
        let path = uri;
        try {
          const parsed = Spicetify && Spicetify.URI && Spicetify.URI.fromString ? Spicetify.URI.fromString(uri) : null;
          if (parsed && typeof parsed.toURLPath === "function") {
            path = parsed.toURLPath(true);
          }
        } catch (err) {
          dbg("openUri toURLPath failed: " + (err && err.message ? err.message : err), "error");
        }
        dbg(`openUri: uri=${uri} path=${path} | History=${P && P.History && typeof P.History.push === "function" ? "ok" : "missing"}`);
        try {
          if (P && P.History && typeof P.History.push === "function") {
            P.History.push(path);
            dbg("openUri push called");
            return true;
          }
        } catch (err) {
          dbg("openUri error: " + (err && err.message ? err.message : err), "error");
        }
        try {
          window.location.hash = path;
          dbg("openUri hash fallback");
          return true;
        } catch (err) {}
        return false;
      },
      get connected() {
        return ws && ws.readyState === WebSocket.OPEN;
      },
      get agentVersion() {
        return agentVersion;
      },
    };

    Spicetify.Player.addEventListener("songchange", () => {
      const item = Spicetify.Player.data && Spicetify.Player.data.item;
      if (item) send({ type: "event.songchange", uri: item.uri });
    });

    // --- Playlist change event watcher with FNV-1a hash & debounce (Phase 5) ---
    function fnv1a64(str) {
      let hash = BigInt("0xcbf29ce484222325");
      const prime = BigInt("0x100000001b3");
      for (let i = 0; i < str.length; i++) {
        hash = hash ^ BigInt(str.charCodeAt(i));
        hash = (hash * prime) & BigInt("0xffffffffffffffff");
      }
      return hash.toString(16).padStart(16, "0");
    }

    const playlistTimers = new Map();
    const lastKnownHashes = new Map();

    async function handlePlaylistModified(playlistUriStr) {
      const pid = idOf(playlistUriStr);
      if (!pid) return;

      if (playlistTimers.has(pid)) {
        clearTimeout(playlistTimers.get(pid));
      }

      playlistTimers.set(
        pid,
        setTimeout(async () => {
          playlistTimers.delete(pid);
          try {
            // Leitura interna Tier 1 em memória (0 requisições HTTP)
            const tracks = await Access.platform.playlistTracks(pid, MAX_PLAYLIST_TRACKS);
            if (!tracks) return;
            const uris = tracks.map((t) => t.uri).filter(Boolean);
            const currentHash = fnv1a64(uris.join(","));

            if (lastKnownHashes.get(pid) === currentHash) {
              return; // Hash idêntico: descarta sem custo
            }
            lastKnownHashes.set(pid, currentHash);

            send({
              type: "event.playlist_modified",
              playlistId: pid,
              hash: currentHash,
              uris,
            });
            dbg(`[watcher] playlist ${pid} modified -> diff sent (hash=${currentHash}, tracks=${uris.length})`);
          } catch (e) {
            dbg("[watcher] error inspecting modified playlist: " + (e?.message || e));
          }
        }, 1500)
      );
    }

    try {
      const plApi = platformApi("PlaylistAPI", "getEvents") || platformApi("PlaylistAPI", "addListener");
      let bus = null;
      if (plApi) {
        if (typeof plApi.getEvents === "function") {
          bus = plApi.getEvents();
        } else if (typeof plApi.addListener === "function") {
          bus = plApi;
        }
      }
      if (bus && typeof bus.addListener === "function") {
        bus.addListener("operation", (ev) => {
          const uri = ev && (ev.uri || ev.playlistUri);
          if (uri) handlePlaylistModified(uri);
        });
      }
    } catch (err) {
      dbg("[watcher] PlaylistAPI event bus unavailable: " + (err?.message || err));
    }

    connect();
    console.info("[euterpe] " + tr("extensionLoaded"));
  }
})();
