# Euterpe — Plano Completo do Projeto

Centro agentic pessoal dentro do client oficial do Spotify (desktop, Windows/Linux), onde o usuário conversa por chat com um agente (DeepSeek) que lê seus dados musicais, cruza com websearch, letras e metadados de áudio, e produz curadoria — sugestões justificadas e criação de playlists, incluindo capa — mantendo o app original via spicetify.

---

## 1. Decisões travadas (log)

| Tema | Decisão |
|---|---|
| Nome | **Euterpe** |
| Plataforma | Spicetify desktop (Windows + Linux), extensão única |
| UI | Custom App (chat em painel React nativo) + Extension (eventos `songchange`) |
| Base de código | Fork estrutural de `harbassan/spicetify-apps` + scaffold `create-spicetify-app` |
| Agente | Servidor local Node/TS, **Fastify + ws** (100% open-source) → *superseded por D1/D6 (`PLAN-REFACTOR.md`): daemon Rust autocontido + extensão fina* |
| LLM | DeepSeek via SDK `openai` (`baseURL https://api.deepseek.com`); `deepseek-v4-flash` (chat) / `deepseek-v4-pro` (curadoria) |
| Dados Spotify | API interna via `Spicetify.CosmosAsync` (sem OAuth) |
| Mutações | Sempre com confirmação + snapshot/undo |
| Websearch | **SearXNG** self-hosted (Docker), JSON API |
| Letras | Cadeia: `color-lyrics` (nativo) → LRCLIB → Lyrics.ovh (sem key) |
| Capa | Conceito → **Openverse** (anônimo + cache, `license_type=commercial`) → seleção → JPEG ≤256KB → upload |
| Similares | Spotify `related_artists` + Last.fm (score 0–1) + Deezer `related` + TasteDive (key opcional) |
| Radar | SearXNG + **Spotify Charts** (`charts-spotify-com-service.spotify.com/public/v0/charts`) + `browse/new-releases` |
| Persistência | SQLite (`better-sqlite3`) no agente |
| WS local | `127.0.0.1:8337` + segredo de handshake |
| Visão p/ capas | Pós-MVP (`deepseek-v4-flash-vision-exp`) |
| Embeddings/MCP | Embeddings fora do MVP; **MCP passa a ser escopo** — ver D5/D6 em `PLAN-REFACTOR.md` |
| Distribuição | Uso pessoal, repositório privado/local |
| Idioma | PT-BR |
| **D2 (atualizado: multiplataforma)** | **Autostart nativo por usuário**: atalho oculto no Windows, systemd de usuário com fallback XDG no Linux, LaunchAgent no macOS. O instalador registra e inicia o daemon; a extensão apenas conecta e reconecta, sem depender de Node no renderer. `--ensure` verifica a saúde da instância; o bind exclusivo impede servidores duplicados. Detalhes em `docs/platforms.md`. |
| **D1/D5/D6 (refatoração v2)** | Aplicadas: daemon Rust autocontido (`core/`), catálogo único de tools (D5) consumido pelo loop LLM e pelo MCP, e a chave da 8337 com `/chat` espelhável via `CHAT_UPSTREAM` (D6). Detalhes em `PLAN-REFACTOR.md` e o que ficou pendente em `CHANGES.md`. |

> **Refatoração v2 (especificação aprovada):** `PLAN-REFACTOR.md` — MCP nativo, providers de LLM
> configuráveis, UI de setup e daemon autocontido em Rust. Decisões D1-D6, contrato congelado
> C1-C12, fases F0-F7 e pendências com gatilho. Este documento segue canônico para a v1.

---

## 2. Requisitos de negócio

### 2.1 Objetivos
- Gerir playlists por linguagem natural sem sair do Spotify.
- Transformar dados do usuário (playlists/salvas/top artists) em descoberta musical contextual.
- Curadoria temática com justificativa (letras, gênero, mood, semelhança de artistas).
- Automação discreta (event-driven) e relatórios periódicos.

### 2.2 Usuário
Único, uso pessoal, conta Spotify própria (Free/Premium), desktop Windows ou Linux, com chave DeepSeek.

### 2.3 Features v1 (critérios de aceite)

| # | Feature | Critério de aceite |
|---|---|---|
| F1 | Chat agentic | Painel no Spotify; mensagens com streaming; status visível de cada tool |
| F2 | Fluxo "términos" | Comando → playlist X → artistas/gêneros → similares + websearch → candidatos → letras → filtra por tema → resposta justificada por faixa |
| F3 | Criar playlist via comando | Agente propõe (nome, descrição, faixas, justificativa) → aprova → cria via API interna → link clicável |
| F4 | Websearch (SearXNG) | `q + format=json`; artistas similares, tendências, shows |
| F5 | Análise de letras | color-lyrics → LRCLIB → Lyrics.ovh; agente julga tema/mood |
| F6 | Contexto do usuário | Playlists, salvas, top artists/tracks (limite configurável) |
| F7 | Music DNA | Audio features → descrição textual da "personalidade" da playlist |
| F8 | Playlist morpher | Transforma playlist em outro gênero/vibe preservando intenção |
| F9 | Merge/dedupe | Junta 2+ playlists removendo duplicatas (por URI), preserva ordem |
| F10 | Higiene | Identifica faixas não disponíveis/sem plays e propõe remoção com confirmação |
| F11 | Radar de lançamentos | Charts + websearch de releases de artistas similares aos top → playlist de descobertas |
| F12 | Roteamento automático (Backlog/Desativado) | *Desativado por padrão (delicado/custoso). Redesenho inteligente futuro requer heurística pré-LLM (verificar se faixa já pertence à playlist tocada ou à biblioteca antes de chamar LLM; filtrar apenas faixas recém-descobertas/rádios; debounce/cooldown).* |
| F13 | Relatório semanal | Resumo em texto natural (gêneros, artistas, novidades), sob demanda ou agendado |
| F14 | Título/descrição | Gerados pelo agente ao criar playlist |
| F15 | Capa da playlist | Conceito+termos → Openverse (fallback SearXNG images) → galeria → seleção → resize → upload |
| F16 | Playlist por letras×mood×artistas/gêneros | Comando composto combina F2+F5+F6+F7 |

### 2.4 Fora de escopo (v1) e Backlog
- Roteamento ingênuo por songchange (desativado: chamava LLM para qualquer música sem verificar contexto de reprodução ou duplicações).
- Controle de playback/queue (premium-only; adicionável depois).
- Geração de imagem por IA (capa vem de busca de imagens reais).
- Extensão de browser / mobile / multi-usuário / distribuição pública.
- OAuth da Web API oficial (usamos API interna do client).
- Embeddings locais e exposição MCP (roadmap futuro).

### 2.5 Regras de negócio
- **Toda mutação exige confirmação** (F3, F9, F10, F12); leituras são livres.
- Toda sugestão traz **justificativa por faixa** (letra/gênero/fonte).
- Mutações sempre precedidas de **snapshot** (SQLite) com opção de desfazer.
- Respeitar rate limits (espaçamento ≥100ms; lotes via endpoints batch).
- Token do Spotify **nunca** sai do client; chaves de LLM **nunca** vão pro client.
- Transparência de origem: toda resposta marca a fonte dos dados ("Last.fm", "inferido por metadados").
- Proibido inventar letra; se não achar, rotular como inferência por metadados.
- Modelo: `deepseek-v4-flash` p/ chat/tools triviais; `deepseek-v4-pro` p/ curadoria.
- Idioma da UI: PT-BR.

---

## 3. Requisitos técnicos

### 3.1 Arquitetura

```
┌─ Spotify desktop (spicetify) ─────────────────────────────────┐
│ Custom App "euterpe" (React/TS)   Extension "euterpe"         │
│  • chat + streaming + aprovações  • escuta songchange          │
│  • galeria de capas               • executa tools Spotify      │
│  • executa tools Spotify (CosmosAsync, token do client)        │
└──────────────┬─────────────────────────────────────────────────┘
               │ WebSocket ws://127.0.0.1:8337 (JSON-RPC + handshake)
┌──────────────▼─────────────────────────────────────────────────┐
│ Agente "euterpe" — Node 20+ / TypeScript, Fastify + ws         │
│  • loop agentic DeepSeek (openai SDK)                          │
│  • orquestradores batch (enrich, lyrics, similar, charts, img) │
│  • SQLite (histórico, cache, snapshots)                        │
│  • .env: DEEPSEEK_API_KEY, modelos, portas, segredo (gitignored)│
└──────────────┬─────────────────────────────────────────────────┘
               │ HTTP (localhost)
        ┌──────▼──────┐
        │ SearXNG     │  docker-compose: searxng/searxng,
        │ (Docker)    │  format=json habilitado
        └─────────────┘
```

### 3.2 Stack (100% open-source)

| Componente | Tech |
|---|---|
| Custom App + Extension | TypeScript/React, `create-spicetify-app` (esbuild), plugin `spcr-settings` |
| Servidor do agente | Node 20+ / TS, **Fastify + ws**, `openai` SDK, `sharp`, `better-sqlite3`, `zod`, `dotenv`, `p-limit` |
| Websearch | **SearXNG** (AGPL) via Docker, JSON API |
| Imagens | **Openverse** (sem key) → fallback SearXNG `categories=images` |
| Letras | **color-lyrics** (nativo) → **LRCLIB** → **Lyrics.ovh** |
| LLM | DeepSeek `deepseek-v4-flash` / `deepseek-v4-pro`, tool-calling (modo `strict` beta opcional), streaming |
| Similaridade | Last.fm `artist.getSimilar` · Deezer `artist/{id}/related` · TasteDive (key opcional) · MusicBrainz (desambiguação MBID) |

### 3.3 Protocolo client ↔ agente (WS, JSON-RPC-like)

| Tipo | Direção | Conteúdo |
|---|---|---|
| `hello` | client→agent | Segredo de handshake + versão do app |
| `tool.call` | agent→client | Solicita execução de tool do Spotify (CosmosAsync) |
| `tool.result` | client→agent | Resultado `{ok, data}` ou `{ok:false, code}` |
| `chat.stream` | agent→client | Tokens da resposta do LLM |
| `chat.status` | agent→client | Status da tool em execução ("buscando artistas similares…") |
| `proposal.create` | agent→client | Proposta de mutação (tipo, diff, justificativa) |
| `proposal.decision` | client→agent | Aprovar/rejeitar |
| `undo.request` | client→agent | Desfazer última mutação (restaura snapshot) |
| `event.songchange` | client→agent | Evento do player (F12) |
| `cover.select` | client→agent | Imagem escolhida na galeria |
| `ping` / `pong` | ambos | Keepalive |

Reconnect com backoff; fila por sessão; timeout global por comando.

### 3.4 Catálogo de tools (com fallback por tool)

#### Leitura — executadas no client via `CosmosAsync`

| Tool | Uso | Fallback se falhar/vazio |
|---|---|---|
| `get_playlists` | Lista playlists do usuário | Pedir nome/link ao usuário e resolver via `search_spotify` |
| `get_playlist_tracks(id)` | Faixas paginadas | `get_playlist(id)` (resumo) + confirmação |
| `get_saved_tracks` / `get_top_artists` / `get_top_tracks` | Contexto do usuário | Continuar sem contexto, avisar o usuário |
| `search_spotify(q, types)` | Resolver nome → URI (tool coringa) | Refrasear query (sem acentos, inglês) |
| `get_related_artists(id)` | Similares (primário) | `find_similar_artists` → `web_search` |
| `get_recommendations(seeds, target_*)` | Geração de candidatos | `search_spotify` por gênero/playlist temática |
| `get_audio_features(ids)` | Music DNA / mood | Inferir por gênero + título via LLM |
| `get_several_artists(ids[])` | Batch artists (≤50) | — |
| `get_several_tracks(ids[])` | Batch tracks (≤50) | — |
| `get_audio_features_bulk(ids[])` | Batch features (≤100) | — |
| `get_artist(id)` / `get_track(id)` | Gêneros, imagens, popularidade | Dados já presentes no track da playlist |

#### Mutações — confirmadas, com snapshot

`create_playlist(name, description)` → `add_tracks(playlist_id, uris)` (dedup por URI) → `set_playlist_details` → `set_playlist_cover(id, jpeg_b64≤256KB)`. Sempre precedidas por `snapshot_playlist(id)` (SQLite) e `undo_last_mutation(id)` disponível.

#### Orquestradores no servidor (fan-out, p-limit 4–8, cache-first, throttle)

| Orquestrador | Faz | Fontes cruzadas |
|---|---|---|
| `enrich_tracks(ids[])` | **Tool central de cruzamento**: tracks → batch features → artistas → gêneros → letras (cache) → posições em charts → entidades unidas | Spotify + letras + Charts |
| `lyrics_bulk(tracks[])` | Fan-out na cadeia de letras; origem marcada por faixa | color-lyrics → LRCLIB → ovh |
| `find_similar_artists(artists[])` | Matriz artist→similares com scores por fonte | Spotify + Last.fm + Deezer + TasteDive |
| `chart_lookup(tracks[])` | Parseia Charts uma vez; posições/country | Spotify Charts |
| `image_search_bulk(conceitos[])` | Fan-out Openverse com cache + fallback | Openverse → SearXNG images |
| `web_search(q, categories, time_range)` | Camada genérica L2 | SearXNG |
| `lyrics_single` / `lyrics_ovh_single` | Letra pontual | cadeia acima |

#### Tools genéricas (camada L2 — quando as especializadas falham)

`web_search` (SearXNG) para qualquer pesquisa textual (Music-Map/Gnoosic inclusos, lidos textualmente) · `search_spotify` com query aberta · inferência por metadados via LLM (valência/energia/gênero/título) com rótulo explícito.

#### Entidade normalizada (o que o LLM recebe, nunca fragmentos crus)

```
Track {
  uri, name, album, artists[], duration_ms, popularity,
  audio_features {valence, energy, danceability, ...},
  genres[],                      // união de gêneros dos artistas
  lyrics {text, source},         // "spotify" | "lrclib" | "ovh" | null+inferido
  similar_artists {name, uri, score_by_source[]},
  chart {country, position},     // quando aplicável
  cover_url
}
```

### 3.5 Política de orquestração

1. Coleção de >1 item → tool bulk (nunca loop de chamadas singulares).
2. **1 nível de fallback**: cadeia primária → L2; nunca mais que isso — responde com o que tem, declarando fontes.
3. Rate limits: espaçamento ≥100ms no client; fatiar arrays em 50/100; cache SQLite com TTL.
4. Timeout global por comando; se o loop exceder N steps (default 12), devolve status parcial.
5. Leitura livre; mutação sempre via `proposal` com diff + justificativa.
6. Dedup por URI antes de mutações; join ambíguo → confirmar com o usuário.

### 3.6 Config

`agent/.env`: `DEEPSEEK_API_KEY`, `LLM_CHAT_MODEL` (default `deepseek-v4-flash`), `LLM_CURATION_MODEL` (default `deepseek-v4-pro`), `PORT` (8337), `WS_SECRET`, `SEARXNG_URL` (default `http://localhost:8888`), `LASTFM_API_KEY` (opcional), `TASTEDIVE_API_KEY` (opcional), limites de contexto (max tracks/tool, max playlists), flags de features (roteamento auto on/off).

### 3.7 Segurança
- Bind `127.0.0.1`; handshake com segredo (gerado no 1º run, em `.env` e no LocalStorage do client).
- Chaves só no `.env` (gitignored); token Spotify efêmero, nunca persistido/logado.
- Imagens baixadas em tmp e apagadas após upload; throttling em Openverse/SearXNG.
- Sem telemetria; logs locais rotativos.

### 3.8 Observabilidade e testes
- Status de tool em tempo real na UI; logs estruturados no servidor.
- Testes unitários (tools, schemas zod, resize sharp); integração do loop com LLM mockado; contrato WS testado.

---

## 4. Roadmap

| Fase | Entregáveis |
|---|---|
| **1. Scaffold** | Monorepo `app/` + `agent/` + `docker-compose` (SearXNG, JSON habilitado); fork estrutural; WS conecta e faz `ping` |
| **2. Agente core** | Loop tool-calling DeepSeek + tools de leitura + orquestradores batch |
| **3. Chat UI** | Painel no Spotify com streaming, status de tools, histórico (SQLite) |
| **4. MVP curadoria** | F2 + F3 + F4 + F5 completos (fluxo "términos" ponta a ponta) |
| **5. Features de dados** | F7, F8, F9, F10, F16 |
| **6. Automação** | F11 (radar), F12 (roteamento auto), F13 (relatório semanal) |
| **7. Capa** | F14 + F15 (conceito → Openverse → galeria → upload) |
| **8. Estabilização** | Config final, testes E2E manuais Win+Linux, docs de uso, `spicetify backup apply` pós-update |

## 5. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Update do Spotify quebra spicetify | `spicetify restore backup apply`; compatibilidades no README |
| API interna muda | **Implementado**: camada única de acesso (`Access`) em `app/euterpe-extension/euterpe.js`, em 3 tiers (Platform → GraphQL → Web) com fallback automático. Medições e resultados em `PLAN-INTERNAL-API.md` §11–§12 |
| LRCLIB/ovh sem letra | Cadeia color-lyrics → LRCLIB → ovh; inferência rotulada |
| DeepSeek tool-calling divergir do schema | `strict` mode (beta) + validação zod |
| Instâncias públicas SearXNG sem JSON | Self-host via docker-compose (default) |
| Openverse 200/dia anônimo | Cache + throttle + fallback SearXNG images |
| Capa >256KB | `sharp` com loop de qualidade até ≤256KB; recusa graciosa |
| ToS Spotify (API não documentada) | Uso pessoal; nenhum bypass de assinatura/ads |

## 6. Definição de pronto (MVP)

Funciona em Windows **e** Linux; fluxo F2→F3 completo com confirmação e undo; chat com streaming; SearXNG local; capa F15; chave DeepSeek em `.env`; zero segredos no repositório; README com setup.

## 7. Fontes validadas

- spicetify CLI (LGPL-2.1) e docs (custom apps, extensions, creator, popup-lyrics) — spicetify.app / github.com/spicetify
- DeepSeek API docs — api-docs.deepseek.com (OpenAI-compatible, tool calls, pricing)
- SearXNG Search API — docs.searxng.org (JSON format)
- Openverse API — api.openverse.org (anon 20/min, 200/dia)
- Last.fm `artist.getSimilar` — last.fm/api (score 0–1)
- Deezer `artist/{id}/related` — api.deezer.com (testado)
- Lyrics.ovh — api.lyrics.ovh (testado)
- Spotify Charts — charts-spotify-com-service.spotify.com (testado)
- Spotify Web API: batch endpoints e upload de capa — developer.spotify.com
- Referências: harbassan/spicetify-apps, jasonmayes/Web-AI-Spotify-DJ, ogulcancelik/claudify, spotify-mcp servers
