// Euterpe - Extension
// Mantém o WebSocket com o agente local, executa tools do Spotify
// (via API própria com token fresco do AuthorizationAPI) e expõe window.euterpe.
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
    const listeners = new Set();

    let ws = null;
    let retry = 0;

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

    async function api(url, opts = {}) {
      const method = opts.method || "GET";
      if (method === "GET" && opts.ttlMs) {
        const cached = cacheGet(url);
        if (cached !== null) return cached;
      }
      const headers = { ...(opts.headers || {}) };
      const token = getApiToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      if (opts.body !== undefined && !opts.raw) headers["Content-Type"] = "application/json";

      let body = opts.body;
      if (body !== undefined && typeof body !== "string") body = JSON.stringify(body);

      const doFetch = () =>
        fetch(url, {
          method,
          headers,
          body,
          credentials: "omit",
        });

      let res = await doFetch();
      if (res.status === 401 && token) {
        const prev = token;
        await forceTokenRefresh();
        await new Promise((r) => setTimeout(r, 800));
        const next = getApiToken();
        if (next && next !== prev) {
          headers.Authorization = `Bearer ${next}`;
          res = await doFetch();
        }
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 2) * 1000));
        res = await doFetch();
        if (res.status === 429) {
          const err = new Error("rate_limited");
          err.code = 429;
          throw err;
        }
      }
      if (res.status === 204) return {};
      if (!res.ok) {
        const err = new Error(`${method} ${url} -> HTTP ${res.status}`);
        err.code = res.status;
        throw err;
      }
      const ct = res.headers.get("content-type") || "";
      const data = ct.includes("json") ? await res.json() : await res.text();
      if (method === "GET" && opts.ttlMs) cacheSet(url, data, opts.ttlMs);
      return data;
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

    async function execSpotifyTool(name, args) {
      try {
        let data;
        switch (name) {
          case "get_playlists": {
            const out = [];
            const dbg = {};
            let source = "none";
            try {
              const LibraryAPI = Spicetify.Platform && Spicetify.Platform.LibraryAPI;
              dbg.hasLibraryAPI = !!LibraryAPI && typeof LibraryAPI.getContents === "function";
              if (dbg.hasLibraryAPI) {
                const res = await LibraryAPI.getContents({
                  filters: [],
                  limit: 200,
                  offset: 0,
                });
                dbg.libraryResKeys = res ? Object.keys(res).slice(0, 12) : null;
                const items = res && Array.isArray(res.items) ? res.items : null;
                dbg.libraryItemsType = Array.isArray(items) ? `array(${items.length})` : items === null ? "missing items array" : typeof items;
                if (Array.isArray(items) && items.length) {
                  source = "library";
                  for (const p of items) {
                    out.push({
                      id: (p.uri || p.id || "").split(":").pop(),
                      uri: p.uri,
                      name: p.name,
                      tracks: Array.isArray(p.numberOfItemsPerLinkType)
                        ? p.numberOfItemsPerLinkType.reduce((acc, l) => acc + (l?.numItems ?? 0), 0)
                        : null,
                      image: p.imageUrl || (Array.isArray(p.images) && p.images[0]?.url) || null,
                    });
                  }
                }
              }
            } catch (err) {
              dbg.libraryErr = String(err && err.message ? err.message : err);
            }
            if (!out.length) {
              source = "webapi";
              try {
                const raw = await api(`${API}/me/playlists?limit=50&offset=0`);
                dbg.rawKeys = raw && typeof raw === "object" ? Object.keys(raw).slice(0, 12) : typeof raw;
                dbg.rawTotal = raw && typeof raw.total !== "undefined" ? raw.total : null;
                dbg.rawItemsType =
                  raw && raw.items ? (Array.isArray(raw.items) ? `array(${raw.items.length})` : typeof raw.items) : "missing items";
                const rawItems = raw && raw.items ? raw.items : [];
                for (const p of rawItems) {
                  out.push({ id: p.id, uri: p.uri, name: p.name, tracks: p.tracks?.total ?? null, image: p.images?.[0]?.url ?? null });
                }
              } catch (err) {
                dbg.webapiErr = String(err && err.message ? err.message : err);
              }
            }
            data = { source, total: out.length, playlists: out, _debug: dbg };
            break;
          }

          case "get_playlist_tracks": {
            const pid = idOf(args.playlist_id);
            const uri = args.playlist_id && String(args.playlist_id).startsWith("spotify:") ? args.playlist_id : `spotify:playlist:${pid}`;
            let items = [];
            try {
              const PlaylistAPI = Spicetify.Platform && Spicetify.Platform.PlaylistAPI;
              if (PlaylistAPI && typeof PlaylistAPI.getContents === "function") {
                const pageSize = 100;
                let offset = 0;
                while (offset < 300) {
                  const res = await PlaylistAPI.getContents(uri, { offset, limit: pageSize });
                  const chunkItems = res && Array.isArray(res.items) ? res.items : [];
                  items.push(...chunkItems);
                  if (chunkItems.length < pageSize) break;
                  offset += pageSize;
                }
              }
            } catch (err) {}
            if (!items.length) {
              items = await paginate(`/playlists/${pid}/tracks`, 50, 300);
            }
            data = items.map((it) => ({
              uri: it.uri || it.track?.uri,
              name: it.name || it.track?.name,
              artists: (it.artists || it.track?.artists || []).map((a) => a.name),
              artist_ids: (it.artists || it.track?.artists || []).map((a) => a.id ?? String(a.uri).split(":").pop()),
              album: it.album?.name || it.track?.album?.name,
              duration_ms: it.duration?.milliseconds ?? it.track?.duration_ms,
            }));
            break;
          }

          case "get_saved_tracks": {
            let items = [];
            try {
              const LibraryAPI = Spicetify.Platform && Spicetify.Platform.LibraryAPI;
              if (LibraryAPI && typeof LibraryAPI.getTracks === "function") {
                const res = await LibraryAPI.getTracks({ offset: 0, limit: 200 });
                items = Array.isArray(res.items) ? res.items : [];
              }
            } catch (err) {}
            if (!items.length) {
              items = await paginate("/me/tracks", 50, 200);
            }
            data = items.map((it) => ({
              uri: it.uri || it.track?.uri,
              name: it.name || it.track?.name,
              artists: (it.artists || it.track?.artists || []).map((a) => a.name),
              artist_ids: (it.artists || it.track?.artists || []).map((a) => a.id ?? String(a.uri).split(":").pop()),
              album: it.album?.name || it.track?.album?.name,
              duration_ms: it.duration?.milliseconds ?? it.track?.duration_ms,
              added_at: it.addedAt ?? it.added_at,
            }));
            break;
          }

          case "get_top_artists": {
            const tr = args.time_range || "medium_term";
            const body = await api(`${API}/me/top/artists?time_range=${tr}&limit=50`, { ttlMs: 10 * 60 * 1000 });
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
            const body = await api(`${API}/me/top/tracks?time_range=${tr}&limit=50`, { ttlMs: 10 * 60 * 1000 });
            data = (body.items ?? []).map((t) => ({
              uri: t.uri,
              name: t.name,
              artists: (t.artists ?? []).map((a) => a.name),
              artist_ids: (t.artists ?? []).map((a) => a.id),
              duration_ms: t.duration_ms,
            }));
            break;
          }

          case "search_spotify": {
            const types = args.types || "track";
            const limit = Math.min(args.limit || 20, 50);
            const body = await api(`${API}/search?q=${encodeURIComponent(args.q)}&type=${types}&limit=${limit}`, { ttlMs: 10 * 60 * 1000 });
            const pick = (arr) => (arr ?? []).map((x) => ({ id: x.id, uri: x.uri, name: x.name }));
            data = {
              tracks: pick(body.tracks?.items),
              artists: pick(body.artists?.items),
              albums: pick(body.albums?.items),
              playlists: (body.playlists?.items ?? []).map((p) => ({ id: p.id, name: p.name })),
            };
            break;
          }

          case "get_related_artists": {
            const aid = idOf(args.artist_id);
            const body = await api(`${API}/artists/${aid}/related-artists`, { ttlMs: 24 * 60 * 60 * 1000 });
            data = (body.artists ?? []).map((a) => ({ id: a.id, name: a.name, genres: a.genres ?? [], popularity: a.popularity }));
            break;
          }

          case "get_artist": {
            const aid = idOf(args.artist_id);
            const a = await api(`${API}/artists/${aid}`, { ttlMs: 24 * 60 * 60 * 1000 });
            data = {
              id: a.id,
              name: a.name,
              genres: a.genres ?? [],
              popularity: a.popularity,
              followers: a.followers?.total ?? null,
              image: a.images?.[0]?.url ?? null,
              external_url: a.external_urls?.spotify ?? null,
            };
            break;
          }

          case "get_recommendations": {
            const q = new URLSearchParams();
            if (args.seed_artists?.length) q.set("seed_artists", args.seed_artists.map(idOf).join(","));
            if (args.seed_tracks?.length) q.set("seed_tracks", args.seed_tracks.map(idOf).join(","));
            if (args.seed_genres?.length) q.set("seed_genres", args.seed_genres.join(","));
            q.set("limit", String(Math.min(args.limit || 20, 100)));
            const body = await api(`${API}/recommendations?${q}`, { ttlMs: 5 * 60 * 1000 });
            data = (body.tracks ?? []).map((t) => ({
              uri: t.uri,
              name: t.name,
              artists: (t.artists ?? []).map((a) => a.name),
              artist_ids: (t.artists ?? []).map((a) => a.id),
              duration_ms: t.duration_ms,
            }));
            break;
          }

          case "get_audio_features_bulk": {
            const ids = (args.ids ?? []).map(idOf);
            const out = [];
            for (const part of chunk(ids, 100)) {
              const body = await api(`${API}/audio-features?ids=${part.join(",")}`, { ttlMs: 24 * 60 * 60 * 1000 });
              out.push(...(body.audio_features ?? []));
            }
            data = out;
            break;
          }

          case "get_several_artists": {
            const ids = (args.ids ?? []).map(idOf);
            const out = [];
            for (const part of chunk(ids, 50)) {
              const body = await api(`${API}/artists?ids=${part.join(",")}`, { ttlMs: 24 * 60 * 60 * 1000 });
              out.push(...(body.artists ?? []));
            }
            data = out.map((a) => ({ id: a.id, name: a.name, genres: a.genres ?? [], popularity: a.popularity, image: a.images?.[0]?.url ?? null }));
            break;
          }

          case "get_several_tracks": {
            const ids = (args.ids ?? []).map(idOf);
            const out = [];
            for (const part of chunk(ids, 50)) {
              const body = await api(`${API}/tracks?ids=${part.join(",")}`, { ttlMs: 24 * 60 * 60 * 1000 });
              out.push(...(body.tracks ?? []));
            }
            data = out.map((t) => ({
              uri: t.uri,
              name: t.name,
              artists: (t.artists ?? []).map((a) => a.name),
              artist_ids: (t.artists ?? []).map((a) => a.id),
              duration_ms: t.duration_ms,
            }));
            break;
          }

          case "new_releases": {
            const limit = Math.min(args.limit || 20, 50);
            const body = await api(`${API}/browse/new-releases?limit=${limit}`, { ttlMs: 30 * 60 * 1000 });
            data = (body.albums?.items ?? []).map((al) => ({
              uri: al.uri,
              name: al.name,
              artists: (al.artists ?? []).map((a) => a.name),
              release_date: al.release_date,
            }));
            break;
          }

          case "create_playlist": {
            const me = await api(`${API}/me`);
            const body = { name: args.name, public: false };
            if (args.description) body.description = args.description;
            const created = await api(`${API}/users/${me.id}/playlists`, { method: "POST", body });
            const uris = dedupe(args.tracks);
            if (uris.length) {
              await api(`${API}/playlists/${created.id}/tracks`, { method: "POST", body: { uris } });
            }
            data = { playlist_id: created.id, name: created.name, url: created.external_urls?.spotify ?? null, added: uris.length };
            break;
          }

          case "add_tracks": {
            const uris = dedupe(args.uris);
            await api(`${API}/playlists/${idOf(args.playlist_id)}/tracks`, { method: "POST", body: { uris } });
            data = { added: uris.length };
            break;
          }

          case "remove_tracks": {
            const pid = idOf(args.playlist_id);
            const uris = dedupe(args.uris);
            for (const part of chunk(uris, 100)) {
              await api(`${API}/playlists/${pid}/tracks`, { method: "DELETE", body: { tracks: part.map((uri) => ({ uri })) } });
            }
            data = { removed: uris.length };
            break;
          }

          case "set_playlist_details": {
            const body = {};
            if (args.name) body.name = args.name;
            if (args.description !== undefined) body.description = args.description;
            await api(`${API}/playlists/${idOf(args.playlist_id)}`, { method: "PUT", body });
            data = { ok: true };
            break;
          }

          case "replace_playlist_tracks": {
            const uris = dedupe(args.uris);
            await api(`${API}/playlists/${idOf(args.playlist_id)}/tracks`, { method: "PUT", body: { uris } });
            data = { replaced: uris.length };
            break;
          }

          case "set_playlist_cover": {
            await api(`${API}/playlists/${idOf(args.playlist_id)}/images`, {
              method: "PUT",
              body: args.image_b64,
              raw: true,
              headers: { "Content-Type": "image/jpeg" },
            });
            data = { ok: true };
            break;
          }

          default:
            return { ok: false, code: "tool_nao_implementada:" + name };
        }
        return { ok: true, data };
      } catch (err) {
        const code = err && err.code === 429 ? "rate_limited" : String(err?.message || err);
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
          ws = new WebSocket(WS_URL);

          ws.onopen = () => {
            retry = 0;
            ws.send(JSON.stringify({ type: "hello", secret: cfg.secret, appVersion: "0.1.0", locale: getLocale() }));
          };

          ws.onmessage = async (ev) => {
            let msg;
            try {
              msg = JSON.parse(ev.data);
            } catch {
              return;
            }

            if (msg.type === "tool.call") {
              const result = await execSpotifyTool(msg.name, msg.args || {});
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: result.ok, data: result.data, code: result.code }));
              }
              return;
            }

            notify(msg);
          };

          ws.onclose = () => {
            notify({ type: "chat.status", status: "offline", detail: "agente desconectado" });
            scheduleReconnect();
          };

          ws.onerror = () => {
            try {
              ws.close();
            } catch (err) {}
          };
        })
        .catch(() => scheduleReconnect());
    }

    function scheduleReconnect() {
      const delay = Math.min(1000 * 2 ** retry, 30000);
      retry += 1;
      setTimeout(connect, delay);
    }

    function send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        notify({ type: "chat.status", status: "offline", detail: "agente desconectado" });
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
          dbg("openUri toURLPath falhou: " + (err && err.message ? err.message : err), "error");
        }
        dbg(`openUri: uri=${uri} path=${path} | History=${P && P.History && typeof P.History.push === "function" ? "ok" : "ausente"}`);
        try {
          if (P && P.History && typeof P.History.push === "function") {
            P.History.push(path);
            dbg("openUri push chamado");
            return true;
          }
        } catch (err) {
          dbg("openUri erro: " + (err && err.message ? err.message : err), "error");
        }
        try {
          window.location.hash = path;
          dbg("openUri fallback hash");
          return true;
        } catch (err) {}
        return false;
      },
      get connected() {
        return ws && ws.readyState === WebSocket.OPEN;
      },
    };

    Spicetify.Player.addEventListener("songchange", () => {
      const item = Spicetify.Player.data && Spicetify.Player.data.item;
      if (item) send({ type: "event.songchange", uri: item.uri });
    });

    connect();
    console.info("[euterpe] extension carregada");
  }
})();
