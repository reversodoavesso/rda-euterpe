# Euterpe — Plano Diretor de Resiliência, Tier 1 e Governança MCP

**Status:** Aprovado para implementação  
**Arquivos afetados:**  
* `app/euterpe-extension/euterpe.js` (extensão Spicetify)  
* `core/src/mcp/` (servidor MCP e rate limiter do daemon)  
* `core/src/tools/` (catálogo e runners de tools Rust)  
* `core/src/protocol/` (contrato JSON-RPC WebSocket)  
* `core/src/store/` (SQLite snapshots e backups)  
* `agent/src/tools/defs.ts` (definições únicas do catálogo)  

---

## 1. Visão Geral e Princípios Arquiteturais

O Euterpe opera sob o princípio de **"otimizar de dentro do cliente desktop"**. A hierarquia de acesso aos dados do Spotify é estritamente dividida em três níveis (Tiers):

```
+-------------------------------------------------------------------------+
| Tier 1: Spicetify Platform APIs & Cosmos IPC (Zero Rate Limit, Local)   |
|         - Platform.LibraryAPI, Platform.PlaylistAPI, RootlistAPI        |
|         - sp://core-playlist/v1/... (Cosmos direto na memória do C++)   |
+-------------------------------------------------------------------------+
                                    | (se indisponível)
                                    v
+-------------------------------------------------------------------------+
| Tier 2: Spicetify GraphQL (Pathfinder Queries Internas do App)          |
|         - queryArtistOverview, searchModalResults                       |
+-------------------------------------------------------------------------+
                                    | (fallback extremo)
                                    v
+-------------------------------------------------------------------------+
| Tier 3: Spotify Web API HTTP (api.spotify.com/v1 - Sujeito a 429)       |
|         - Requer pacing, fail-fast informativo e headers Retry-After    |
+-------------------------------------------------------------------------+
```

Este documento formaliza as 6 frentes de modernização para eliminar erros `429`, conferir velocidade instantânea de leitura e dar autonomia a agentes inteligentes (Agy, Claude Code, OpenCode, Cursor).

---

## 2. Detalhamento dos 6 Pilares de Melhoria

### 2.1 Resiliência de Rate Limiting & Cooldown Informativo

#### Diagnóstico Atual
* Em `euterpe.js`, a constante `WEB_RETRY_AFTER_MAX_MS = 2000` (2s) descarta qualquer retry quando o Spotify devolve `Retry-After: 10` ou `30`.
* A exceção é capturada como `{ ok: false, code: "rate_limited" }`, perdendo a métrica de tempo e deixando o agente cego.

#### Solução Técnica
1. **Erro Estruturado Rico:**
   Ao receber HTTP 429, capturar o cabeçalho `Retry-After` e propagar:
   ```json
   {
     "ok": false,
     "code": "rate_limited",
     "retry_after_seconds": 30,
     "hint": "Recarregue o Spotify Desktop (Ctrl+R) para um novo token ou aguarde o cooldown."
   }
   ```
2. **Propagação no Protocolo MCP (`core/src/mcp/server.rs`):**
   O MCP encapsula esse objeto diretamente no `content[0].text` com `isError: true`, permitindo que agentes façam sleep programado ou acionem o usuário.
3. **Pacing Proativo no Daemon Rust:**
   Implementar controle de fluxo (Leaky Bucket / intervalo mínimo) nas requisições despachadas para o cliente, prevenindo rajadas.

---

### 2.2 Blindagem Real do Tier 1 Spicetify (Zero Rate Limit)

#### Diagnóstico Atual
* `Access.platform.createPlaylist` (`euterpe.js:424`) invocava `RootlistAPI.createPlaylist(name, { after: "end" })` dentro de um `try/catch` que retornava `null` silenciosamente em caso de erro.
* Em versões recentes do Spotify Desktop (XPUI v1.2+), a assinatura do RootlistAPI mudou ou passou a exigir chamada Cosmos, fazendo o Euterpe cair inadvertidamente na Web API pública (`POST /v1/users/{id}/playlists`).

#### Solução Técnica
1. **Cascata de Resolução no Spicetify:**
   * **Tentativa 1:** `RootlistAPI.createPlaylist(name, { after: "end" })`
   * **Tentativa 2:** `RootlistAPI.createPlaylist(name, {})` ou `RootlistAPI.createPlaylist(name)`
   * **Tentativa 3:** Barramento IPC interno: `Spicetify.CosmosAsync.post("sp://core-playlist/v1/rootlist", { name })`
2. **Log Diagnóstico Ativo:**
   Registrar falhas via `dbg("[tier] platform createPlaylist failed: " + err)` para visibilidade no console do agente.

---

### 2.3 Operações em Lote e Chunking Automático Nativo

#### Diagnóstico Atual
* A Web API só permite até 100 músicas por requisição. Criar e preencher playlists grandes exige múltiplas chamadas manuais ou orquestração complexa pelo agente.

#### Solução Técnica
1. **`spotify_create_playlist` com Auto-Chunking:**
   * Aceita arrays arbitrários (ex: 500 faixas).
   * Fatiamento automático em lotes de 100 tanto no Tier 1 quanto no Tier 3.
   * Resposta enriquecida:
     ```json
     {
       "ok": true,
       "playlist_id": "37i9dQZF1DXcBWIGoYBM5M",
       "name": "Nova Curadoria",
       "added": 340,
       "batches": 4
     }
     ```
2. **Nova Tool: `spotify_batch_create_playlists`:**
   * Criação atômica de múltiplas playlists em um único comando MCP:
   ```json
   {
     "playlists": [
       { "name": "Deep Focus", "description": "Ambient instrumental", "tracks": ["spotify:track:..."] },
       { "name": "Night Drive", "description": "Synthwave vibes", "tracks": ["spotify:track:..."] }
     ],
     "delay_between_ms": 1500
   }
   ```

---

### 2.4 Suporte a Arquivos Locais para Capas (`file_path` / `data_uri`)

#### Diagnóstico Atual
* `core/src/tools/server/cover.rs` aceita apenas `url` remota e faz `reqwest::get`.
* Imagens geradas localmente por IA (Stable Diffusion, DALL-E salvo em disco, subagents locais) não podiam ser usadas sem upload para servidor externo.

#### Solução Técnica
1. **Suporte Polimórfico em `prepare_cover`:**
   * Se inicia com `http://` ou `https://` $\rightarrow$ Download HTTP.
   * Se inicia com `data:image/` $\rightarrow$ Decodificação Base64 inline.
   * Se for caminho existente no sistema de arquivos local $\rightarrow$ Leitura com `tokio::fs::read`.
2. **Processamento Seguro em Rust:**
   * Redimensionamento nativo para no máximo 600x600 pixels.
   * Compressão JPEG iterativa (qualidades 85 $\rightarrow$ 35) garantindo $\le 256$ KB.
3. **Facilidade em `set_playlist_cover`:**
   * Aceitar diretamente `file_path`, codificando em JPEG 256KB no daemon antes do envio à extensão.

---

### 2.5 Extração Instantânea da Biblioteca (`spotify_dump_library`)

#### Diagnóstico Atual
* Mapear 60 playlists e 3.500 faixas levava minutos e consumia ~70 requisições Web API paginadas de 50 em 50.

#### Solução Técnica
* **Nova Tool MCP:** `spotify_dump_library`
* **Mecanismo:** Acesso direto via `Spicetify.Platform.LibraryAPI.getContents()` e `PlaylistAPI.getContents()` no processo do Spotify Desktop.
* **Performance:** Retorna a biblioteca completa em formato estruturado em menos de 2 segundos, com **zero chamadas de rede HTTP externas**.
* **Contrato:**
  ```json
  {
    "include_tracks": true,
    "include_saved_tracks": false,
    "max_playlists": 100
  }
  ```

---

### 2.6 Ferramentas Analíticas de Curadoria e Governança

#### Solução Técnica
1. **`spotify_find_orphans`:**
   * Compara listas de IDs de playlists originais vs. novas playlists geradas.
   * Retorna músicas esquecidas durante a curadoria:
     ```json
     {
       "orphans_count": 12,
       "orphans": [
         { "uri": "spotify:track:...", "name": "...", "original_playlist": "Antiga 2021" }
       ]
     }
     ```
2. **`spotify_analyze_overlap`:**
   * Matriz de intersecção e coeficiente de similaridade de Jaccard entre playlists.
   * Detecta redundâncias sonoras ou repetições excessivas.
3. **`spotify_backup_library` e `spotify_restore_library`:**
   * `spotify_backup_library()`: Gera snapshot com timestamp em disco (`~/.euterpe/backups/snapshot-<timestamp>.json`).
   * `spotify_restore_library(backup_id)`: Restaura o estado da conta caso o usuário queira desfazer grandes alterações.

---

## 3. Especificação dos Contratos MCP (`agent/src/tools/defs.ts`)

```typescript
// 1. Extração instantânea
def(
  "dump_library",
  "Extrai instantaneamente todas as playlists, faixas e metadados da biblioteca local via Spicetify em <2s sem consumir rate limit da Web API.",
  {
    include_tracks: { type: "boolean", description: "Inclui faixas completas de cada playlist (default: true)" },
    include_saved_tracks: { type: "boolean", description: "Inclui músicas curtidas (default: false)" },
    max_playlists: { type: "integer", description: "Limite de playlists a extrair (default: 100)" }
  },
  [],
  "client"
);

// 2. Criação em lote
def(
  "batch_create_playlists",
  "Cria múltiplas playlists em lote com fatiamento e delay controlado em uma única execução.",
  {
    playlists: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          tracks: { type: "array", items: { type: "string" } }
        },
        required: ["name", "tracks"]
      }
    },
    delay_between_ms: { type: "integer", description: "Pausa entre criações em ms (default: 1500)" }
  },
  ["playlists"],
  "client"
);

// 3. Auditoria de órfãos
def(
  "find_orphans",
  "Identifica faixas que estavam nas playlists de origem mas foram esquecidas nas playlists de destino.",
  {
    source_playlist_ids: { type: "array", items: { type: "string" } },
    target_playlist_ids: { type: "array", items: { type: "string" } }
  },
  ["source_playlist_ids", "target_playlist_ids"],
  "server"
);

// 4. Análise de sobreposição
def(
  "analyze_overlap",
  "Calcula matriz de intersecção e similaridade Jaccard entre playlists.",
  {
    playlist_ids: { type: "array", items: { type: "string" } }
  },
  ["playlist_ids"],
  "server"
);

// 5. Backup e restauração
def(
  "backup_library",
  "Salva um snapshot completo com data/hora da biblioteca local para restauração segura.",
  {},
  [],
  "server"
);

def(
  "restore_library",
  "Restaura a estrutura da biblioteca a partir de um backup prévio.",
  {
    backup_id: { type: "string", description: "ID ou timestamp do snapshot" }
  },
  ["backup_id"],
  "server"
);
```

---

## 4. Fases de Execução e Verificação

| Fase | Foco Principal | Entregáveis | Critério de Sucesso |
|---|---|---|---|
| **Fase 1** | Resiliência & Tier 1 | • Tratamento 429 com `retry_after_seconds`<br>• Cascata Platform API / Cosmos em `euterpe.js`<br>• Pacing preventivo no daemon | Erro 429 informa segundos de espera; criação de playlist não consome Web API `/me` |
| **Fase 2** | Capas Locais & Dump | • `prepare_cover` com `file_path`/`data_uri`<br>• Tool `spotify_dump_library` | Capas locais funcionam direto do disco; dump de 60+ playlists em <2s |
| **Fase 3** | Operações em Lote | • Auto-chunking em `create_playlist`<br>• Tool `spotify_batch_create_playlists` | Criação de 500 faixas sem erro; criação de N playlists em lote |
| **Fase 4** | Governança | • `find_orphans` & `analyze_overlap`<br>• `backup_library` & `restore_library` | Matriz de sobreposição calculada; backup e restauração funcionais |
