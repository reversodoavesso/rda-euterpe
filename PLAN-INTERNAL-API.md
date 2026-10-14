# Euterpe — Plano de Reestruturação da Camada de Acesso ao Spotify

**Status:** proposta (não implementado)
**Escopo:** `app/euterpe-extension/euterpe.js` (camada de acesso) + cache durável no `agent/`
**Objetivo:** parar de usar a **API Web pública** (`api.spotify.com/v1`) como caminho primário e passar a usar as **APIs internas do client** (`Spicetify.Platform`, `Spicetify.GraphQL`), reduzindo 429, latência e fragilidade a updates.

---

## 0. Princípio norteador

> **Não clonar. Otimizar de dentro.**

A eficiência do Euterpe vem de as requisições saírem **de dentro do client oficial** — token certo, fingerprint certo, headers certos. `Spicetify.Platform` e `Spicetify.GraphQL` são **injetados pelo spicetify no client em execução**; fora dele não existem. Um "clone recompilado" perderia exatamente o que torna o mod eficiente, viraria **cliente não-padrão** (fingerprinting → 429/ban) e ainda esbarraria no fato de que "recompilar o Spotify" não existe (sem fonte; decompilação é lossy).

| Critério | Mod in-client (atual, corrigido) | Clone standalone |
|---|---|---|
| Acesso a `Platform`/`GraphQL` | ✅ nativo | ❌ inexistente fora do client |
| Fingerprint | ✅ é o próprio client | ❌ detectado como não-padrão |
| Auth | ✅ reusa `AuthorizationAPI` | ❌ reimplementar Login5/librespot |
| Custo de manutenção | baixo | altíssimo |
| Risco de ban | baixo | **alto** |

**Conclusão:** o caminho é corrigir a camada de acesso, não trocar de arquitetura.

---

## 1. Diagnóstico (com evidência)

### 1.1 Pontos de estrangulamento

| Local | Símbolo | Problema |
|---|---|---|
| `euterpe.js:17` | `const API = "https://api.spotify.com/v1"` | define a superfície **pública** como default |
| `euterpe.js:114` | `async function api(url, opts)` | toda rede passa por aqui; retry 429 fixo |
| `euterpe.js:147-156` | retry de `429` | **um** retry, `retry-after` truncado em 2s, **sem backoff exponencial nem jitter** |
| `euterpe.js:169` | `async function paginate(...)` | paginação REST 50/100 → N chamadas por recurso |
| `euterpe.js:96-112` | `cacheGet/cacheSet` | cache em `localStorage`, **volátil por client**, some com limpeza |

### 1.2 O que já está correto (não mexer, só refatorar)

`get_playlists` (`:210`), `get_playlist_tracks` (`:252`) e `get_saved_tracks` (`:276`) **já preferem `Spicetify.Platform`** com fallback Web API. São o modelo a seguir.

### 1.3 Tools ainda presas à API Web (o problema)

| Tool | Linha | Endpoint atual | Observação |
|---|---|---|---|
| `get_top_artists` | `:294` | `/me/top/artists` | REST, cache 10min |
| `get_top_tracks` | `:307` | `/me/top/tracks` | REST |
| `search_spotify` | `:315` | `/search` | REST, limit 50 |
| `get_related_artists` | `:328` | `/artists/{id}/related-artists` | ⚠️ **endpoint deprecado (nov/2024)** |
| `get_artist` | `:335` | `/artists/{id}` | REST |
| `get_recommendations` | `:354` | `/recommendations` | ⚠️ **deprecado** |
| `get_audio_features_bulk` | `:363` | `/audio-features?ids=` | ⚠️ **deprecado** + lotes de 100 |
| `get_several_artists` | `:374` | `/artists?ids=` | lotes de 50 |
| `get_several_tracks` | `:385` | `/tracks?ids=` | lotes de 50 |
| `new_releases` | `:394` | `/browse/new-releases` | REST |
| `create_playlist` | `:404` | `/users/{id}/playlists` | mutação |
| `add_tracks` | `:417` | `/playlists/{id}/tracks` (POST) | mutação |
| `remove_tracks` | `:424` | `/playlists/{id}/tracks` (DELETE) | mutação |
| `set_playlist_details` | `:434` | `/playlists/{id}` (PUT) | mutação |
| `replace_playlist_tracks` | `:443` | `/playlists/{id}/tracks` (PUT) | mutação |
| `set_playlist_cover` | `:450` | `/playlists/{id}/images` | mutação — ver §4 (sem equivalente interno confirmado) |

Os três marcados ⚠️ só funcionam porque o token é o do client oficial. São o risco mais alto de quebra silenciosa.

---

## 2. Arquitetura alvo — três tiers

```
                    execSpotifyTool(name, args)
                              │
                    ┌─────────▼──────────┐
                    │  resolver por tool │  ← mapa declarativo (tool → tier)
                    └─────────┬──────────┘
              ┌───────────────┼────────────────┐
        Tier 1│         Tier 2│          Tier 3│
   ┌──────────▼───────┐ ┌─────▼──────────┐ ┌───▼─────────────────┐
   │ Spicetify.Platform│ │Spicetify.GraphQL│ │ CosmosAsync/Web API│
   │ (store local,    │ │ (Pathfinder,    │ │ (fallback + único  │
   │  ~zero rede)     │ │  1 call = N pg) │ │  caminho p/ upload)│
   └──────────────────┘ └─────────────────┘ └────────────────────┘
```

**Regra de resolução:** cada tool declara a ordem `[tier1, tier2, tier3]`. O resolver tenta em ordem, **para no primeiro resultado não-vazio** e grava a origem (`source`) no payload — preservando o requisito de transparência do `PLAN.md` §2.5.

**Taxonomia de fallback (1 nível, como em `PLAN.md` §3.5):** `Platform` ausente/mudou de assinatura → `GraphQL` → `Web API`. Nunca mais que isso.

### 2.1 Tier 1 — `Spicetify.Platform` (preferido)
Lê o store interno; frequentemente **zero network**.
- `LibraryAPI.getContents({ filters, limit, offset })` → playlists + pastas
- `LibraryAPI.getTracks({ offset, limit })` → curtidas
- `PlaylistAPI.getMetadata(uri)` / `PlaylistAPI.getContents(uri, { offset, limit })`
- `PlaylistAPI.add(uri, uris, { after })` / `PlaylistAPI.remove(uri, tracks)`
- `RootlistAPI.createPlaylist(name, opts)`
- `AuthorizationAPI.getState().token.accessToken` (já usado em `:79`)
- Candidatos a confirmar na Fase 0: `ArtistAPI`, `History`, `PlayerAPI`

### 2.2 Tier 2 — `Spicetify.GraphQL` (Pathfinder, 1 chamada rica)
```js
const { FetchPlaylistContents } = Spicetify.GraphQL.Definitions;
await Spicetify.GraphQL.Request(FetchPlaylistContents, { uri, offset: 0, limit: 1000 }, { persistCache: true });
```
`Definitions` relevantes (presentes na `Query` do spicetify): `FetchPlaylistContents`, `FetchPlaylistMetadata`, `queryArtistRelated`, `searchModalResults`, `getAlbum`, `queryArtistOverview`, `queryArtistDiscographyAll`, `decorateContextTracks`, `browsePage`.

> ⚠️ `Spicetify.GraphQL` pode não existir em versões antigas. Fallback obrigatório com try/catch.

### 2.3 Tier 3 — `CosmosAsync` / Web API (fallback + exceções)
Mantém o `api()` atual. Necessário para: `set_playlist_cover` (upload de imagem — sem equivalente interno confirmado) e para qualquer tier superior indisponível. Opcionalmente usa protocolos internos (`sp://core-playlist/v1/rootlist`).

---

## 3. Especificação do adapter

**Restrição arquitetural:** `app/install.mjs:51-53` copia **apenas** `euterpe.js` para `spicetify/Extensions/`. Adicionar um segundo arquivo exigiria mudar o instalador **e** garantir ordem de carga. **Decisão: manter arquivo único** e introduzir a camada como região interna bem delimitada.

Estrutura interna a criar dentro de `euterpe.js` (antes de `execSpotifyTool`):

```js
// ===== Internal API access layer =====
const Access = {
  platform: { available(), library:{contents,tracks}, playlist:{metadata,contents,add,remove}, rootlist:{createPlaylist}, artist:{...} },
  graphql:  { available(), request(defName, vars) },
  web:      { get, post, put, del },   // encapsula o api() atual, com backoff
};
function resolveTool(name, args) { /* mapa declarativo tool → [tier1,tier2,tier3] */ }
// =====================================
```

Contratos:
- `Access.*.available()` → `boolean`, checado **em runtime** (nunca assumir).
- `Access.graphql.request` → resolve a definition por **nome**, cai para **hash hardcoded** se `Definitions` não existir (padrão já usado pelo próprio spicetify no custom app *new-releases*).
- Todo resultado carrega `{ data, source }`, onde `source ∈ {"platform","graphql","webapi"}`.
- `execSpotifyTool` passa a ser um `switch` fino que delega a `resolveTool`.

---

## 4. Mapa de reescrita por tool

| Tool | Tier 1 (Platform) | Tier 2 (GraphQL) | Tier 3 (Web) | Ação |
|---|---|---|---|---|
| `get_playlists` | `LibraryAPI.getContents` | — | `/me/playlists` | **mover** p/ adapter (lógica já existe) |
| `get_playlist_tracks` | `PlaylistAPI.getContents` | `FetchPlaylistContents` | `/playlists/{id}/tracks` | mover + adicionar GraphQL |
| `get_saved_tracks` | `LibraryAPI.getTracks` | — | `/me/tracks` | mover |
| `get_top_artists` | confirmar na Fase 0 | — | `/me/top/artists` | **novo Tier 1**, Web como fallback |
| `get_top_tracks` | confirmar na Fase 0 | — | `/me/top/tracks` | idem |
| `search_spotify` | — | `searchModalResults` | `/search` | **novo Tier 2** |
| `get_related_artists` ⚠️ | — | `queryArtistRelated` | (atual) | **migrar — sai do endpoint deprecado** |
| `get_artist` | confirmar (`ArtistAPI`) | `queryArtistOverview` | `/artists/{id}` | novo Tier 1/2 |
| `get_recommendations` ⚠️ | — | (sem def estável) | (atual) | manter Web + **flag de degradação** |
| `get_audio_features_bulk` ⚠️ | **sem equivalente** | **sem equivalente** | (atual) | manter Web, cache 24h, **declarar fallback** |
| `get_several_artists` | `ArtistAPI` (confirmar) | `browseArtist`/`queryArtistMinimal` | `/artists?ids=` | novo Tier 1/2 |
| `get_several_tracks` | — | `decorateContextTracks`/`browseTrack` | `/tracks?ids=` | novo Tier 2 |
| `new_releases` | — | `browsePage` / `queryArtistDiscographyAll` | `/browse/new-releases` | novo Tier 2 |
| mutações (create/add/remove/details/replace) | `RootlistAPI`/`PlaylistAPI` | `MutationDefinitions` | (atual) | migrar p/ Platform |
| `set_playlist_cover` | ❌ | ❌ | `/playlists/{id}/images` | **permanece Web** (exceção documentada) |

**Limitação honesta:** `get_audio_features_bulk` **não tem** substituto interno — nem um clone teria. Fica em Web + cache agressivo, e o agente já deve degradar para inferência por gênero (`PLAN.md` §3.4, coluna *Fallback*).

---

## 5. Cache e rate limiting

| Problema | Correção |
|---|---|
| Retry 429 fixo (`:147`) | **Token bucket** + **backoff exponencial com jitter** (base 500ms, cap 30s), respeitando `retry-after` |
| Requisições duplicadas em voo | **Coalescing**: mapa `chave → Promise` compartilhada |
| Cache em `localStorage` (`:96`) | Manter cache curto no client (Tier 1/2) **e** criar **cache durável no agente (SQLite)** para enriquecimento caro (sobrevive a restart do Spotify) |
| `paginate()` sempre REST | Preferir Tier 1/2; manter `paginate` só no Tier 3 |

---

## 6. Fases, critérios de aceite e verificação

> **Fase 0 é obrigatória** — `Spicetify.Platform` muda entre versões; as assinaturas devem ser descobertas no client real do usuário, não inferidas.

| Fase | Entregável | Critério de aceite | Comando de verificação |
|---|---|---|---|
| **0. Descoberta** | Dump, no DevTools do Spotify, de `Object.keys(Spicetify.Platform)`, de `Object.keys(Spicetify.GraphQL?.Definitions ?? {})` e das assinaturas das APIs usadas | Lista anexada ao plano (apêndice §9) preenchida | manual (DevTools) |
| **1. Adapter** | Região `Access` + `resolveTool` + `source` no payload; tools atuais migradas p/ o adapter **sem mudança de comportamento** | Smoke test do fluxo F2→F3 continua verde | `node --check app/euterpe-extension/euterpe.js` + smoke manual |
| **2. Top/Search** | `get_top_artists`, `get_top_tracks`, `search_spotify` em Tier 1/2 | Mesmos dados retornados; `source` ≠ `webapi` no caminho normal | smoke manual |
| **3. Deprecados** | `get_related_artists` → `queryArtistRelated`; `get_several_*` e `new_releases` em Tier 1/2 | `related_artists` retorna dados **sem** tocar `/related-artists` | smoke manual + log de `source` |
| **4. Mutações** | `create/add/remove/details/replace` via `Platform`, com `snapshot`/`undo` intactos | Mutação + `undo_last_mutation` funcionam | smoke manual + `agent/tests/mutation-gate.mjs` |
| **5. Cache/rate limit** | Backoff+jitter, coalescing, cache durável no agente | Teste de rajada não estoura 429 | `cd agent && npm test` |
| **6. Blindagem** | try/catch por tier, hashes hardcoded de persisted query, docs no `CHANGES.md` | App funciona com `GraphQL` desabilitado (força Tier 3) | smoke manual |

**Verificadores do projeto:** extensão/app são **JS puro** (copiados direto por `install.mjs`) → validar com `node --check`. O agente tem typecheck e testes: `cd agent && npx tsc --noEmit && npm test`. Reinstalação: `node app/install.mjs`.

---

## 7. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| `Spicetify.Platform` muda de assinatura entre versões | Adapter único + `available()` em runtime + fallback por tier |
| `Spicetify.GraphQL` ausente/renomeado | try/catch + **hashes de persisted query hardcoded** (padrão spicetify) |
| Update do Spotify quebra tudo | `spicetify restore backup apply` (já documentado em `app/README.md`) |
| `get_audio_features_bulk` deprecado | cache 24h + degradação para inferência (`PLAN.md` §3.4) |
| Regressão silenciosa | Todo payload carrega `source`; log de origem na UI |
| Escopo inflar | Migração **tool a tool**, cada fase verde antes da seguinte |

---

## 8. Definição de pronto

1. Nenhuma tool de **leitura** usa `api.spotify.com/v1` no caminho feliz (exceto `audio_features`, documentado).
2. Todo resultado traz `source` (`platform`/`graphql`/`webapi`).
3. Backoff+jitter e coalescing implementados; teste de rajada passa.
4. `get_related_artists` não toca `/related-artists`.
5. Fluxo F2→F3 (criar playlist curada) verde no client **e** `cd agent && npx tsc --noEmit && npm test` em **exit 0**.
6. `PLAN.md` §5 (tabela de riscos) e `CHANGES.md` atualizados com a mudança.

---

## 9. Apêndice — APIs internas validadas

Fontes: docs do spicetify (`spicetify.co/docs/development/api-wrapper/methods/platform`, `.../graphql`) e referência de extensões. **Assinaturas marcadas "confirmar" devem ser validadas na Fase 0.**

| API | Status | Fonte |
|---|---|---|
| `Platform.LibraryAPI.getContents/getTracks` | validado (uso real) | doc *Platform* + `Spices/Services/Library.ts` |
| `Platform.PlaylistAPI.getMetadata/getContents/add/remove` | validado (uso real) | idem |
| `Platform.RootlistAPI.createPlaylist` | validado (uso real) | idem |
| `Platform.AuthorizationAPI.getState().token.accessToken` | validado (já em uso, `:79`) | código do projeto |
| `GraphQL.Definitions` / `GraphQL.Request(def, vars, ctx)` | validado | doc *GraphQL* |
| `searchModalResults`, `getAlbum`, `queryArtistOverview`, `decorateContextTracks` | ✅ confirmado no client real (com `sha256Hash`) | Fase 0 — §11.3 |
| `queryArtistRelated`, `FetchPlaylistContents`, `FetchPlaylistMetadata`, `browsePage`, `browseTrack`, `browseArtist`, `queryArtistDiscographyAll`, `queryArtistMinimal`, `searchDesktop` | ❌ **inexistentes neste client** | Fase 0 — §11.1 |
| `Platform.ArtistAPI`, `Platform.SearchAPI`, `Platform.AlbumAPI`, `Platform.TrackAPI` | ❌ **inexistentes neste client** | Fase 0 — §11.1 |
| `Platform.History` | ⚠️ é o **router**, não histórico de reprodução | Fase 0 — §11.1 |
| `Platform.PlayerAPI` | ✅ `getState(0)`, `play(2)`, `addToQueue(2)` | Fase 0 — §11.2 |
| `GraphQL.QueryDefinitions/MutationDefinitions/ResponseDefinitions` | ❌ ausentes — só `{Context, Definitions, Handler, Request}` | Fase 0 — §11.2 |
| `Platform.LibraryAPI.getAlbums`, `Platform.PlaylistAPI.setPermission` | ❌ ausentes | Fase 0 — §11.1 |

**Não existe** substituto interno conhecido para: `audio-features`, upload de capa (`set_playlist_cover`).

> ⚠️ **Esta tabela foi corrigida pela Fase 0.** Onde ela conflitar com o resto do documento, **vale a §11**.

---

## 10. Fase 0 — script de descoberta

`scripts/phase0-discovery.js` (fora do install — `install.mjs` não o copia).

Como rodar:
1. Abrir o DevTools do Spotify desktop (Console), com o contexto JS no **frame superior** ("top") — é onde `Spicetify` existe.
2. Colar o arquivo inteiro e dar Enter.
3. A saída é **copiada para a área de transferência** e impressa. Colar o JSON de volta.

Garantias: **zero rede, zero mutação**; cada probe em `try/catch` (API ausente → `null`).
O bloco **OPTIONAL** no fim (comentado, **faz chamadas de rede**) captura o *shape* das respostas para garantir paridade com `mapTrack` — rodar só se quiser os nomes exatos de campo.

Saída esperada (preenche este apêndice com os valores reais do client):
`guard` (versões + flags) · `platform.keys` · `platform.probes.{LibraryAPI,PlaylistAPI,RootlistAPI,ArtistAPI,History,PlayerAPI,AuthorizationAPI,SearchAPI,AlbumAPI,TrackAPI,LocalFilesAPI}` · `graphql.members/definitionCount/names/wanted`.
Para cada definition em `wanted`: `present`, `type`, `keys` e `sha256` (hash da persisted query, quando embutido — insumo da blindagem da Fase 6).

---

## 11. Fase 0 — resultados verificados (2026-10-13)

Ambiente medido: spicetify **2.45.3**, Spotify **1.3.4.258**, Chromium 151, Windows.
Coleta: `scripts/phase0-discovery.js` (pass 1) + `scripts/phase0-discovery-2.js` (pass 2, protótipo).

### 11.1 Premissas do plano REFUTADAS

| Suposição do plano | Realidade no client |
|---|---|
| `Platform.ArtistAPI` / `SearchAPI` / `AlbumAPI` / `TrackAPI` | ❌ **não existem** |
| `Platform.History` = histórico de reprodução | ❌ é o **router** (`go/push/replace/listen/block/canGo`) |
| `Platform.LibraryAPI.getAlbums` | ❌ ausente |
| `Platform.PlaylistAPI.setPermission` | ❌ ausente |
| `GraphQL.FetchPlaylistContents` / `FetchPlaylistMetadata` | ❌ ausentes (72 defs; **nenhum** de playlist) |
| `GraphQL.queryArtistRelated` | ❌ ausente |
| `GraphQL.browsePage` / `browseTrack` / `browseArtist` | ❌ ausentes |
| `GraphQL.queryArtistDiscographyAll` / `queryArtistMinimal` | ❌ ausentes |
| `GraphQL.searchDesktop` | ❌ ausente |
| `GraphQL.QueryDefinitions` / `MutationDefinitions` / `ResponseDefinitions` | ❌ ausentes (só `{Context, Definitions, Handler, Request}`) |

### 11.2 Confirmado (assinaturas reais)

| API | Métodos (aridade) |
|---|---|
| `Platform.LibraryAPI` | `getContents(1)`, `getTracks(0)`, `add(1)`, `remove(1)`, `contains(0)` |
| `Platform.PlaylistAPI` | `getMetadata(2)`, `getContents(2)`, `add(4)`, `remove(2)` |
| `Platform.RootlistAPI` | `createPlaylist(3)`, `getContents(0)`, `add(2)`, `remove(1)`, `move(3)` |
| `Platform.PlayerAPI` | `getState(0)`, `play(2)`, `addToQueue(2)` |
| `Platform.AuthorizationAPI` | `getState(0)`, `tryAuthorize(0)`, `onTokenChanged`, `onAuthenticationFailed` |
| `Platform.LocalFilesAPI` | presente |
| `Spicetify.GraphQL` | `{ Context, Definitions, Handler, Request }` — **72** definitions |

> Nota de implementação: as `Platform.*API` são **instâncias de classe** — os métodos vivem no **protótipo**, não nas own-keys. Enumerar com `Object.getOwnPropertyNames(Object.getPrototypeOf(api))`.
>
> Cada definition do GraphQL expõe `{ name, operation, sha256Hash, value, __apiType }` — o **hash é acessível direto** via `d.sha256Hash` (simplifica a blindagem da Fase 6, sem precisar escanear o AST).

### 11.3 GraphQL — definitions presentes (com hash)

| Definition | sha256Hash (prefixo) |
|---|---|
| `searchModalResults` | `9a79751378a306d8…` |
| `getAlbum` | `6a74b456cd1735c9…` |
| `queryArtistOverview` | `9f8134ef565e7862…` |
| `decorateContextTracks` | `383de00240775c39…` |

Também presentes, com hash já coletado no pass 2: `getTrack`, `getAlbumNameAndTracks`, `getArtistNameAndTracks`, `queryAlbumTracks`, `queryAlbumTrackUris`, `queryTrackArtists`, `queryArtistAboutModal`, `searchSuggestions`, `searchModalEntityPage`, `decorateQueuedByUsers`, `recentSearches`, `home`, `homeSection`, `npvPageContent`, `watchFeedView`, `canvas`, `concert`, `trackPreview`, `similarAlbumsBasedOnThisTrack`, `seoRecommendedTrackPlaylistDesktop`, `lookupChildEntities`, `showItemsPlayedState`.

### 11.4 Mapa FINAL (tool → API interna)

| Tool | Alvo interno | Tier |
|---|---|---|
| `get_playlists` | `LibraryAPI.getContents({limit,offset})` | 1 |
| `get_playlist_tracks` | `PlaylistAPI.getContents(uri, {offset,limit})` | 1 |
| `get_saved_tracks` | `LibraryAPI.getTracks()` | 1 |
| mutações `create/add/remove` | `RootlistAPI.createPlaylist(3)` · `PlaylistAPI.add(4)/remove(2)/move(3)` | 1 |
| `set_playlist_details` | `PlaylistAPI.updateDetails(2)` | 1 |
| `set_playlist_cover` | **`PlaylistAPI.uploadImage(1)`** ✅ *(era Web API)* | 1 |
| `get_recommendations` | **`PlaylistAPI.getRecommendedTracks(4)`** ou `AssistedCurationAPI.getRecommendations(2)` ✅ *(era Web API)* | 1 |
| `search_spotify` | `GraphQL.searchModalResults` | 2 |
| `get_artist` | `GraphQL.queryArtistOverview` | 2 |
| `get_several_tracks` | `GraphQL.getTrack` · `decorateContextTracks` (batch por URI) | 2 |
| `new_releases` | `GraphQL.home` / `homeSection` ✅ | 2 |
| `get_top_artists` / `get_top_tracks` | ❓ candidatos `PlayHistoryAPI.getContents()`, `RecentsAPI.getContents(4)` — exige probe de **shape** (§11.6) | ? |
| `get_related_artists` ⚠️ | ✅ **resolvido no pass 3**: `GraphQL.queryArtistOverview` → `data.artistUnion.relatedContent.relatedArtists.items` (mata o endpoint deprecado) | 2 |
| `get_audio_features_bulk` ⚠️ | ❌ **sem equivalente em nenhum lugar** — permanece Web API + cache 24h | 3 |

**Leitura:** o mod pode virar **praticamente livre da Web API** — só `audio_features` fica para trás. As três tools de maior volume e **todas as mutações** são Tier 1. Duas que eu tinha dado como perdidas (`set_playlist_cover`, `get_recommendations`) **têm equivalente interno**.

### 11.5 Pass 2 — inventário por protótipo

Métodos reais por namespace (aridade entre parênteses; só os relevantes):

| Namespace | Métodos-chave |
|---|---|
| `LibraryAPI` (21) | `getContents(1)`, `getTracks(0)`, `getArtistView(1)`, `contains(0)`, `add(1)`, `remove(1)`, `pin(2)`, `markAsPlayed(1)` |
| `PlaylistAPI` (23) | `getContents(2)`, `getMetadata(2)`, `getPlaylist(3)`, `add(4)`, `remove(2)`, `move(3)`, **`uploadImage(1)`**, `updateDetails(2)`, `getRecommendedTracks(4)`, `setAttributes(2)` |
| `RootlistAPI` (18) | `createPlaylist(3)`, `createFolder(2)`, `getContents(0)`, `add(2)`, `remove(1)`, `move(3)`, `setPublishedState(2)` |
| `PlayerAPI` (33) | **playback completo**: `play(2)`, `pause(1)`, `resume(1)`, `skipToNext(1)`, `seekTo(1)`, `setShuffle(1)`, `setRepeat(1)`, `addToQueue(2)`, `getQueue(0)`, `reorderQueue(2)` |
| `PlayHistoryAPI` (4) | `getContents(0)`, `getCapabilities()`, `getEvents()` |
| `RecentlyPlayedAPI` (3) | `getContexts(0)`, `startListening(0)` |
| `RecentsAPI` (2) | `getContents(4)`, `getCapabilities()` |
| `CollectionPlatformAPI` (8) | `get(1)`, `add(2)`, `remove(2)`, `contains(2)`, `subscribe(2)` |
| `FollowAPI` (7) | `followUsers(1)`, `unfollowUsers(1)`, `isFollowing(1)` |
| `UserAPI` (1) | `getUser()` — perfil |
| `AssistedCurationAPI` (11) | `getRecommendations(2)`, `search(2)`, `getRecentlyPlayedTracks(1)`, `getSearchArtistContent(1)` |
| `CurationAPI` (11) | `curateItems(4)`, `curateDefault(2)`, `getAvailableSortOrders()` |
| `PlaybackAPI` (11) | `getFiles(1)`, `getVolume()`, `setVolume(1)`, `getPlaybackInfo()` |
| `PubSubAPI` (11) | `subscribe(1)`, `getMessages()`, `createSubscription(3)` |
| `ShowAPI` (15) | `getContents(2)`, `getMetadata(1)`, `getBookContents(2)` |
| `ListPlatformAPI` (14) | `getList()`, `getListContents()`, `add()`, `remove()`, `move()` |
| `Registry` (9) | `resolve(1)` — container DI interno (escape hatch) |
| `LocalFilesAPI` (27) | `getTracks(2)`, `addFolder(1)`, `browseForFolder()` |

Bônus que o plano não previa: **controle de playback nativo** (`PlayerAPI`), **upload de capa** (`PlaylistAPI.uploadImage`), **recomendações internas** (`getRecommendedTracks` / `AssistedCurationAPI`), **pub/sub** (`PubSubAPI`), **follow/unfollow** (`FollowAPI`).

### 11.6 Resíduos (exigem probe de **shape**, não de assinatura)

Apenas dois itens não fecham por assinatura — dependem do bloco OPTIONAL de `scripts/phase0-discovery.js` (chamada de rede que devolve o shape):

1. ~~**`get_related_artists`** — `queryArtistOverview` inclui artistas relacionados no payload?~~ ✅ **RESOLVIDO (pass 3)**: sim — `data.artistUnion.relatedContent.relatedArtists.items`. A tool migra para Tier 2 e o endpoint Web deprecado sai de cena.
2. **`get_top_artists` / `get_top_tracks`** — `PlayHistoryAPI.getContents()` devolve top ou histórico bruto? (`RecentsAPI.getContents(4)` é o outro candidato.)

Ambos **não bloqueiam a Fase 1**: as tools desses três itens permanecem no Tier 3 (Web API) até o shape confirmar, e migram depois sem tocar no resto.

---

## 12. Status de implementação

| Fase | Estado |
|---|---|
| 0. Descoberta | ✅ passes 1–3 (`scripts/phase0-*.js`) + **probe-in-mod** (`GET /probe`) |
| **1. Adapter + Tier 1** | ✅ implementada — 9 tools |
| **2. Tier 2 (GraphQL)** | ✅ **encerrada** — só `get_related_artists` migrou (§12.4) |
| **3. Endpoints deprecados** | ✅ `related_artists` com rede GraphQL; `new_releases`/`recommendations` decididos |
| 4. Mutações via Platform | ✅ incluída na Fase 1 |
| **5. Rate limiting (cliente)** | ✅ implementada |
| 5b. Cache durável no agente | ⛔ **não aplicável** — §12.7 |
| **6. Blindagem** | ✅ hash de persisted query + fallback CosmosAsync — §12.8 |
| **7. Testes** | ✅ `npm test` + 6 testes de adapter — §12.6 |

### 12.1 O que a Fase 1 entregou

Camada `Access` (região única, antes de `execSpotifyTool`) com Tier 1 para:

| Tool | Método interno |
|---|---|
| `get_playlists` | `LibraryAPI.getContents` |
| `get_playlist_tracks` | `PlaylistAPI.getContents` |
| `get_saved_tracks` | `LibraryAPI.getTracks` |
| `create_playlist` | `RootlistAPI.createPlaylist` + `PlaylistAPI.updateDetails/add` |
| `add_tracks` | `PlaylistAPI.add` |
| `remove_tracks` | `PlaylistAPI.remove` (resolve o `uid` via `getContents`) |
| `set_playlist_details` | `PlaylistAPI.updateDetails` |
| `set_playlist_cover` | `PlaylistAPI.uploadImage` |
| `get_recommendations` | `PlaylistAPI.getRecommendedTracks` (**guardado** — shape não confirmado) |

- `replace_playlist_tracks` permanece no Tier 3: a `PlaylistAPI` tem `add/remove/move`, mas **nenhum replace atômico** foi medido.
- Todo resolver responde `null` em indisponibilidade, vazio **ou exceção** → o caminho Web API original roda. Se uma assinatura divergir do medido, **não há regressão**: apenas fica no Tier 3 como antes.
- `get_playlists` agora devolve `source: "platform" | "webapi"` — é o campo que prova qual tier atendeu.

### 12.2 Como verificar

1. Reiniciar o Spotify.
2. No chat do Euterpe: *"lista minhas playlists"* → o payload deve trazer `source: "platform"`.
3. Não-regressão: criar, renomear e remover faixa numa playlist de teste.

### 12.3 Fase 5 — rate limiting (cliente)

Implementada no helper `api()` da extensão:

| Mecanismo | Efeito |
|---|---|
| **Throttle** (`WEB_MIN_SPACING_MS = 120`) | espaçamento mínimo entre chamadas Web (PLAN.md §2.5) |
| **Coalescing** (`webInFlight`) | GETs idênticos concorrentes compartilham a mesma promise |
| **Backoff exponencial + jitter** (`WEB_MAX_ATTEMPTS = 4`, base 500 ms, cap 30 s) | 429/502/503/504 recuam sem rajada sincronizada |
| **`Retry-After`** | respeitado quando presente (limitado ao cap) |
| **401** | re-autentica via `AuthorizationAPI.tryAuthorize` e repete a tentativa |

Como o Tier 1 removeu a maior parte das chamadas Web, a Fase 5 é a **segunda linha de defesa** — protege o que sobrou (`audio_features`, `related_artists`, `top_*`).

### 12.4 Fase 2 — resultado: **não compensa** (com 1 exceção)

> ⚠️ **CORRIGIDO em 2026-10-13 — ver §12.11.** Este veredito estava **errado**: ele assumia que a Web API "funciona". Medição em uso real mostrou `/artists/{id}` e `/tracks?ids=` devolvendo **429 com `Retry-After`**. O Tier 3 é o tier quebrado. `get_artist` e `get_several_tracks` **foram migrados** para o GraphQL (§12.11).

O pass 3 fechou os shapes. Veredito por tool:

| Tool | Alternativa interna | Veredito |
|---|---|---|
| `get_artist` | `queryArtistOverview` | ❌ **sem `genres`** (a curadoria usa) — fica Web |
| `get_several_tracks` | `getTrack` | ❌ 1 chamada/faixa vs `/tracks?ids=` (1 p/ 50) — fica Web |
| `search_spotify` | `searchModalResults` | ❌ variáveis desconhecidas (400) + Web é 1 chamada — fica Web |
| `get_related_artists` | `queryArtistOverview.relatedContent.relatedArtists` | ⚠️ perde `genres`/`popularity`, **mas escapa do endpoint deprecado** → **Web primeiro, GraphQL como rede** |

Os endpoints restantes **não são deprecados** e o interno é pior ou igual em custo. A Fase 2 fica **encerrada com uma única migração** (`get_related_artists`, por resiliência). O ganho real era a **Fase 1**.

### 12.5 Probe dentro do mod (sem copy-paste)

`GET http://127.0.0.1:8337/probe` → o agente chama a tool `probe` do cliente via WS e **grava `agent/data/probes/probe-<ts>.json`**. Resposta HTTP minúscula (`{ok, file, bytes}`); o payload é lido do disco. `scripts/phase0-shapes*.js` continua disponível para uso manual no DevTools, mas o caminho normal agora é o endpoint.

Shape confirmado em `PlaylistAPI.getContents.items[]`:
`{ uri, name, artists[].name, album.name, duration.milliseconds, uid, addedAt }`
— é **exatamente** o que `mapTrack` já esperava, o que valida a Fase 1 empiricamente.

Também confirmado: `queryArtistOverview.relatedContent.relatedArtists.items[] = { id, uri, profile.name }` (len 20, sem genres) e `getTrack.trackUnion = { uri, name, duration.totalMilliseconds, albumOfTrack.name, firstArtist.items[].profile }`.

### 12.6 Testes (fase 7)

`npm test` (novo) roda `tsx tests/parse-suggestions.mjs` + `node --test tests/`.
`npm run test:integration` roda os 3 que sobem servidor (`orchestrators`, `mutation-gate`, `agent-loop`).

**O furo encontrado:** não existia `npm test` — e `tests/parse-suggestions.mjs` importa `../src/agent.ts` (`.ts` direto), então **nunca rodaria sob `node` puro**; exige `tsx`. Foi corrigido.

**Novo:** `tests/extension-adapter.test.mjs` carrega a extensão dentro de um cliente Spotify **stubado** (`node:vm`) e trava a garantia central da Fase 1:

| Teste | Garante |
|---|---|
| `get_playlists` Platform ok | `source: "platform"` e **nenhuma** chamada à Web API |
| `get_playlists` Platform lança | cai na Web API (`source: "webapi"`) |
| `get_saved_tracks` Platform vazio | cai na Web API |
| `add_tracks` Platform ok | muta via `PlaylistAPI.add`, **nenhuma** chamada Web |
| `get_related_artists` Web 403 | responde pela via GraphQL |
| tool desconhecida | devolve `tool_not_implemented`, não lança |

Armadilha documentada no teste: objetos vindos do `vm` são de **outro realm**, então `deepStrictEqual` falha por identidade de protótipo — os asserts comparam campos.

### 12.7 Fase 5b (cache durável no agente) — não aplicável

O racional original era tirar o cache do `localStorage` "volátil". Ele é **incorreto**: `localStorage` sobrevive a restart do Spotify. E, depois da Fase 1, **a maior parte do tráfego saiu da Web API** — só `audio_features` (já com `CACHE_24H`) e as tools decididamente mantidas na Web seguem por lá. Um bridge HTTP extensão↔agente só para cache adicionaria round-trip e complexidade **sem carga que o justifique**. Marcada como **não aplicável**, não "pendente".

### 12.8 Fase 6 — blindagem

- `GRAPHQL_HASHES.queryArtistOverview` fixado (§11.3), com caminho alternativo que emite a *persisted query* por hash via `CosmosAsync` quando a `Definitions` do spicetify não traz a def — sobrevive a uma versão do spicetify que a remova.
- Todo tier já é guardado (`try/catch` → `null`), então nenhuma falha de Tier 1/2 vira erro: cai no tier seguinte.

**Desvio consciente do DoD (§8.2):** o item pede `source` no *payload* de todo resultado. Só `get_playlists` (que já devolve objeto) recebeu o campo; os demais devolvem **array**, e embrulhá-los quebraria o contrato com o LLM. A proveniência foi implementada como **log estruturado** (`[tier] webapi <url>`, emitido uma vez por URL) — mesma observabilidade, zero quebra de contrato.

### 12.9 Correção pós-smoke — timeout e contexto atual (2026-10-13)

O primeiro smoke real no client expôs **dois problemas** (um deles regressão da Fase 5).

**Bug — chamada Web sem timeout.** `get_top_tracks` e `get_top_artists` devolviam `client_timeout` opaco. Evidência no log do agente: as duas sondas separadas por **30.006 ms** exatos — o `fetch` da primeira **pendurou** e consumiu o timeout de 30 s do agente sem produzir status nenhum.

| Antes | Depois |
|---|---|
| `fetch` sem timeout; 1 hang = orçamento inteiro do agente | `AbortController` por tentativa (`WEB_ATTEMPT_TIMEOUT_MS = 6000`) |
| retry podia dormir `Retry-After` de até 30 s | **orçamento total** `WEB_TOTAL_BUDGET_MS = 20000`, menor que o timeout do agente |
| `WEB_MAX_ATTEMPTS = 4` | `= 3` |
| falha invisível | `code: "timeout"` / `"network_error"` **e** log `[web] <status> <url>` por URL |

**Lacuna — sem contexto de reprodução.** O agente dizia "não tenho acesso a now playing" porque **não existia** tool para isso. Adicionada **`get_currently_playing`** (client tool), lida de `Spicetify.Player.data` — a mesma fonte que o listener `songchange` já usa — com `PlayerAPI.getState()` como reserva. **Sem chamada à Web API**, logo imune a rate limit. Registrada em `agent/src/tools/defs.ts`; coberta por 2 testes.

`npm test` passou de 6 para **8** casos.

### 12.10 Camada de player (2026-10-13)

Shapes **medidos no probe** (não supostos) e expostos ao agente. **Tudo lê o estado do próprio client** — zero chamada à Web API, logo imune a rate limit.

| Tool | Fonte | Tipo |
|---|---|---|
| `get_currently_playing` | `Spicetify.Player.data` | leitura (leve) |
| `get_player_state` | `Player.data` → `PlayerAPI.getState()` | leitura (completa) |
| `get_player_queue` | `PlayerAPI.getQueue()` → `{current, nextUp, queued}` | leitura |
| `get_connect_devices` | `ConnectDevicesAPI.getDevices()` → array | leitura |
| `player_control` | `Spicetify.Player.*` (+ `PlayerAPI.setSpeed/setSleepTimer`) | escrita |
| `player_queue_control` | `PlayerAPI.addToQueue/insertIntoQueue/removeFromQueue/reorderQueue/clearQueue` | escrita |

Campos confirmados pelo probe — **corrigiram 2 bugs antes de subir**:

| Real (medido) | Suposto (o que eu tinha escrito) |
|---|---|
| `positionAsOfTimestamp` + `timestamp` | `d.position` ❌ |
| `duration` como **número de ms** (259000) | `d.duration.milliseconds` ❌ |

Também medidos: `isPaused`, `shuffle`, `repeat`, `speed`, `sleepTimer`, `playbackQuality`, `restrictions`; `PlaybackAPI.getPlaybackInfo()` → `{status, playing, buffering, codecName, gainAdjustment, …}`; `ConnectDevicesAPI` → `getActiveDevice/getConnectState/getDevices`, e `ConnectTransferAPI` → `transferPlayback/transferToRemote/pullToLocalDevice` (transferência ainda **não** exposta — assinatura não medida).

**Política de confirmação:** controle de player **não** entra em `MUTATING_TOOLS`. O gate existe para mutação **destrutiva** de playlist (com snapshot/undo); controle de reprodução é transiente e reversível num clique, e exigir aprovação tornaria a feature inútil. `player_queue_control` segue a mesma regra, mas é **best-effort**: as assinaturas de argumento não foram medidas (só a aridade), então cada ação devolve `{ok:false, code}` explícito quando falha, em vez de falhar em silêncio.

`npm test`: **11** casos.

### 12.11 O Tier 3 é o tier quebrado (2026-10-13)

Primeiro uso real (chat: *"o que está tocando? me fale sobre a música e o artista"*). O log de sessão (`agent/data/sessions/*.log`) deu a evidência:

| tool | code | duration_ms |
|---|---|---|
| `get_several_tracks` | `rate_limited` | 8635 |
| `get_artist` | `rate_limited` | 8629 |
| `get_audio_features_bulk` | `rate_limited` | **0** |
| `artist_info` (servidor) | `rate_limited` | **0** |
| `lyrics_lookup` (servidor) | `rate_limited` | **0** |

Os `0 ms` são a chave: após o **primeiro** `rate_limited` o agente **curto-circuita** os tools seguintes. Logo, `artist_info` e `lyrics_lookup` — que são tools de **servidor** (Last.fm/LRICS) — não estavam quebrados: **nunca foram executados**. A linha de "debug" na UI foi escrita pelo próprio LLM e misturou causa com efeito.

**Diagnóstico:** `/artists/{id}` e `/tracks?ids=` devolvem **429 com `Retry-After: ~4s`** com o token do client. O Tier 3 é inutilizável, não os tools de servidor.

Mudanças:

| Antes | Depois |
|---|---|
| `get_artist` → `/artists/{id}` (Web) | **GraphQL `queryArtistOverview` primeiro** (e ganha `biography`, `monthly_listeners`) com Web como reserva |
| `get_several_tracks` → `/tracks?ids=` (Web) | **GraphQL `getTrack`** para ≤10 ids (batch grande segue na Web, que é 1 chamada) |
| 429 com `Retry-After: 4` dormia ~8,6 s e falhava | `Retry-After > WEB_RETRY_AFTER_MAX_MS (2s)` ⇒ **falha imediata** (janela esgotada) |

**Sem equivalente interno (permanecem na Web e vão falhar sob rate limit):** `get_audio_features_bulk`, `get_top_artists`, `get_top_tracks`.

**Sem fonte interna de `genres`/`popularity`:** `queryArtistOverview` não os expõe. Cobertura vem de **`artist_info` (Last.fm, tool de servidor)**, que não é afetada pelo rate limit da Web API — a descrição de `get_artist` em `defs.ts` já aponta para lá.

`npm test`: **13** casos.

### 12.12 Auditoria do Tier 3 e substituições (2026-10-13)

Varredura de todos os `api()` da extensão: **17 pontos** tocavam a Web API. O que mudou:

| Tool | Antes | Agora | Fonte interna |
|---|---|---|---|
| `search_spotify` | `/search` | ✅ **GraphQL `searchModalResults`** | `searchV2.topResultsV2.itemsV2[].item` |
| `get_several_artists` | `/artists?ids=` | ✅ **GraphQL `queryArtistOverview`** (≤10 ids) | `artistUnion` |
| `replace_playlist_tracks` | `PUT /playlists/{id}/tracks` | ✅ **Platform** (`PlaylistAPI.remove` de todos os `uid` + `add`) | store do client |
| `get_audio_features_bulk` | `/audio-features` | ⛔ **REMOVIDO** | **nenhuma** |

**Medições que embasaram cada decisão:**

- **`searchModalResults` dava 400 por variável faltando.** Com o conjunto completo (`searchTerm, limit, offset, numberOfTopResults, includeArtistHasConcertsField, includeAudiobooks, includeAuthors, includePreReleases`) **funciona**. O aninhamento real é `searchV2.topResultsV2.itemsV2[].item` — os ramos que eu supus (`tracksV2`/`albumsV2`/`artists`/`playlists`) são todos `undefined`. Como o wrapper interno não foi enumerado, a extração é **estrutural**: coleta nós com `uri` + `name` e classifica pelo prefixo do URI.
- **`GraphQL.home` → 400.** Não há caminho interno para *new releases*.
- **`PlayHistoryAPI.getContents().items`** → 49 itens com faixa completa (`uri, name, duration.milliseconds, album, artists[]`).
- **`RecentsAPI.getContents().items`** → 4116 itens com `addedAt`, `fullyPlayed`, `resumePositionMs`.
- **`getTrack.associationsV3.audioAssociations.items` → `[]`** — não há features de áudio internas (`valence`/`energy`/`tempo`).

`get_audio_features_bulk` foi removido **de ponta a ponta**: `case` na extensão, def em `defs.ts`, dependência em `enrichTracks` (`server.ts`) e o campo `audio_features` da entidade normalizada. A leitura de mood passa a ser **inferida** (gênero/tags da Last.fm + letra), e o agente já rotula como inferência.

**Permanecem na Web (sem fonte interna medida):** `get_top_artists`, `get_top_tracks` (consumidos por `weekly_report`) e `new_releases` (radar F11). Com o *fast-fail* de 429, cada tentativa custa ~0,2 s em vez de 8,6 s — mas eles **não entregam dado** enquanto a quota estiver esgotada.

`npm test`: **14** casos.

### 12.13 `get_top_*` substituídos por recentes reais (2026-10-13)

`get_top_artists` e `get_top_tracks` sempre foram consumidos por `weekly_report` (server). Ambas as chamadas Web API devolvem **429** sob uso real (medido no §12.11). Não há equivalente interno de "mais ouvidas" (`PlayHistoryAPI` = histórico, `RecentsAPI` = recentes).

Mudança:

| Antes | Agora |
|---|---|
| `get_top_artists` (Web) | **`get_listening_recents`** (Platform `RecentsAPI.getContents`) |
| `get_top_tracks` (Web) | **`get_listening_recents`** (Platform `RecentsAPI.getContents`) |

**`RecentsAPI.getContents()`** medido no probe: **4.116 itens** com `uri, name, addedAt, fullyPlayed, resumePositionMs, duration` — histórico real de reprodução, sem rate limit.

`weeklyReport` (server) migrou de `get_top_artists/tracks` → `get_listening_recents` + `get_saved_tracks`. O relatório passa a trazer **o que você realmente ouviu** (com `fullyPlayed`, `addedAt`, `resumePositionMs`) em vez de "top" (rate limited). O campo `top_artists`/`top_tracks` no payload do relatório foi renomeado para `recent_tracks` + `saved_tracks`.

**`get_top_artists` / `get_top_tracks` (client tools) foram REMOVIDAS** — `defs.ts` atualizado, sem substituto Web. O agente agora usa `get_listening_recents` (alias semântico: "o que eu realmente ouvi"). A descrição da tool explica: "histórico ilimitado, sem rate limit".

### 12.14 Nova tool: `get_listening_recents`

| Campo | Valor |
|---|---|
| Fonte | Platform `RecentsAPI.getContents({ limit, offset })` |
| Itens medidos | 4.116 (probe) |
| Campos | `uri, name, artists[], artist_ids, album, duration_ms, added_at, fully_played, resume_position_ms` |
| Rate limit | **zero** (lê o store local do client) |
| Time range | ignorado — histórico ilimitado |

`npm test`: **14** casos.
