# Euterpe — Refatoração: MCP + Providers + UI + daemon Rust

**Status:** especificação aprovada, nenhuma pendência bloqueante. Baseline commitado em `12dd2ae`.
**Destino do código:** `C:\workspace\spotify-euterpe`.
**Derivado de:** `novas features e refatoracoes propostas.txt` (versionado desde `12dd2ae`).
**Referências internas:** `PLAN.md`, `PLAN-INTERNAL-API.md`, skill `euterpe-maintenance`.

## Decisões travadas (não reabrir sem nova decisão registrada)

| # | Decisão | Valor |
|---|---|---|
| D1 | Linguagem do daemon | **Rust desde o início** (`core/`), com migração *strangler fig* (não big-bang) |
| D2 | Autostart | **Definido pela Fase 0**: se o renderer tiver acesso a Node → spawn pela extensão; senão → atalho de Startup + `euterpe --ensure` |
| D3 | Política de mutação via MCP | **`allow` por padrão**, configurável (`allow`/`confirm`/`deny`), **sempre** com snapshot + `spotify_undo_last_mutation` exposto |
| D4 | Bundle do custom app | esbuild (`app/build.mjs` → `dist/index.js`); `install.mjs` copia o bundle (evita depender da resolução de `import` relativo do spicetify) |
| D5 | Catálogo de tools | **Um só** (`core/src/tools/catalog.rs`), com dois consumidores: loop LLM interno e servidor MCP |
| D6 | Fase 2 — como virar a chave | **B**: o Rust assume a 8337 e faz *proxy* de `/chat` para o Node na 8338. **A (replay de tráfego real) é o gate de aceite do flip**, não uma fase separada. A extensão e a UI não mudam uma linha (porta e contrato idênticos) e o flip é reversível por 1 variável (`CHAT_UPSTREAM`) |

## Fato incontornável (limite de arquitetura)

As APIs internas do Spotify (`Spicetify.Platform.*`, `PlayerOps`, GraphQL interno) existem **apenas no renderer do client**. Rust/WASM não alcançam isso. Portanto:

- a **extensão continua JS** e vira "mãos finas" (`Access` + `PlayerOps` + `execSpotifyTool` + WS bridge);
- o **daemon** (chat agentic + MCP + tools de servidor + providers) é o que vira `euterpe.exe`.

O requisito "autocontido, sem Docker" se aplica ao daemon; a extensão não é reescrevível.

## Estratégia de migração (strangler fig)

```
Fase 2: euterpe.exe (Rust) assume a PORTA 8337 e o bridge WS (contrato congelado).
        /chat é PROXY para o agente Node em 8338 (CHAT_UPSTREAM) — a UI não percebe.
Fase 4: loop LLM + providers nativos no Rust; Node fica só como oráculo de teste.
Fase 7: legacy/agent-node removido; resta apenas agent/tools/export-goldens.mjs.
```

Cada fase fecha com `cargo test` + verificadores do mod verdes. A extensão nunca perde o bridge.

### Alternativas consideradas para a virada (D6)

| Opção | Mecanismo | Veredito |
|---|---|---|
| **A — sombra viva na 8338** (fan-out da extensão para os dois daemons) | A extensão autentica nas duas portas e envia o resultado para ambas | **Descartada**: duplica toda chamada às APIs internas do Spotify — injeta carga justamente onde o 429 já é regra no tier Web — e mutação duplicada é inaceitável |
| **A' — espelho no lado servidor** | O Node notifica o Rust da tool call | **Descartada**: não prova o que importa, porque quem responde a tool é a extensão |
| **A'' — replay de tráfego real gravado** | O corpus de tool calls já executados (`agent/data/sessions/*.log`) é reproduzido contra o Rust e comparado | **Escolhida como gate de B** (~150 LOC, sem daemon extra, sem chamada duplicada, nada no caminho do usuário) |
| **B — chave na 8337 com `/chat` em proxy** | O Rust assume o bridge; o Node vira backend do chat atrás dele | **Escolhida como entrega da Fase 2** |

**Sequência travada:** implementa-se **B**; o flip só é aceito depois que **A''** rodar os tool calls reais contra o Rust com paridade estrutural. Reversibilidade: o flip é 1 linha (`CHAT_UPSTREAM`/`PORT`) — se algo travar, o Node volta à 8337 sem tocar em extensão nem UI.

---

## Contrato congelado (o que NÃO pode mudar de comportamento)

Cada item vira um golden test.

| # | Contrato | Origem (referência) | Validação |
|---|---|---|---|
| C1 | WS bridge: `hello{secret,appVersion,locale}`→`hello.ok{version}`; `tool.call{id,name,args}`/`tool.result{id,ok,data,code}`; `event.songchange{uri}`; `ping/pong`; `client.debug` | `agent/src/protocol.ts:5-73`, `agent/src/index.ts:184-303` | `core/tests/parity_bridge.rs` |
| C2 | Handshake inválido ⇒ `close(1008,"unauthorized")`; msg inválida ⇒ `chat.status{status:"error"}` sem derrubar a conexão | `agent/src/index.ts:231-255` | `parity_bridge.rs` |
| C3 | Timeout de tool = **30 s** ⇒ `{ok:false,code:"client_timeout"}`; proposta de mutação = **120 s** ⇒ `reject` | `agent/src/index.ts:89,130` | `parity_errors.rs` |
| C4 | Códigos: `client_timeout`, `rate_limited`, `user_rejected`, `no_snapshot`, `unknown_tool:<n>` (+ novo `client_offline`) | `agent/src/agent.ts:379-403`, `agent/src/tools/server.ts:413` | golden JSON |
| C5 | `/config`→`{secret,version}`; `/health`→`{ok:true,app:"euterpe",version}`; `/sessions`; `/sessions/:id`; `/probe`→503 `no_client_connected` / 502 / `{ok,file,bytes}` gravando em `data/probes/` | `agent/src/index.ts:137-182` | `parity_http.rs` |
| C6 | Catálogo: **25 client tools + 11 server tools = 36** (contagem medida em `defs.ts`), mesmos `name`/`parameters`/`required`/`side` | `agent/src/tools/defs.ts` | `parity_tools.rs` (JSON diff) |
| C7 | `trimFinal(text,4000)`: nunca corta dentro de `{{...}}`, prefere `\n\n`/espaço, sufixo `…` | `agent/src/agent.ts:138-151` | `parity_prompts.rs` (tabela de casos) |
| C8 | `parseSuggestions`: tira fences, aceita `[...]` solto, trailing comma, descarta `{{spotify:}}`, máx 3, máx 60 chars | `agent/src/agent.ts:109-134` | `parity_prompts.rs` |
| C9 | Prompt de sistema (EN + pt-BR debug on/off), prompt de sugestões, prompt de roteamento | `agent/src/agent.ts:35-104,448` | golden string |
| C10 | SQLite: `conversations`/`snapshots`/`cache`/`settings` com mesmos nomes/colunas, **mesmo arquivo** (histórico sobrevive) | `agent/src/db.ts:14-47` | `parity_store.rs` |
| C11 | i18n: mesmo conjunto de chaves e valores | `agent/src/i18n.ts` | golden de chaves |
| C12 | `get_playlists` pode devolver **vazio legítimo**; as demais tools devolvem `null`/erro em falha (fail-closed) | skill `euterpe-maintenance` §5 | review + teste |

Mudanças **aditivas** permitidas: `/health` ganha `app`; novo código `client_offline`; rotas `/mcp`, `/chat` (SSE), `/providers`, `/models`, `/settings`.

---

## Fase 0 — Preflight (bloqueia Fases 2 e 5)

**Objetivo:** medir as duas incógnitas que mudam o desenho.

- **R1** — o renderer do Spotify tem acesso a Node? (`typeof require === "function"`, `process.versions`).
- **R2** — toolchain: `cargo --version`, `rustc --version`, `node -v`.

**Arquivos**
- MODIFY `app/euterpe-extension/euterpe.js` — em `runProbe()` (~l.986, bloco `// Phase 0 probe`), adicionar nó:
  ```js
  runtime: {
    node: (typeof require === "function") || (typeof process !== "undefined"),
    electron: (typeof process !== "undefined" && process.versions && process.versions.electron) || null,
    nodeVersion: (typeof process !== "undefined" && process.versions && process.versions.node) || null,
  }
  ```
- CREATE `core/rust-toolchain.toml` (canal fixo, ex.: `channel = "1.83.0"`), `core/Cargo.toml` mínimo, só para validar toolchain.

**Comandos**
```
cargo --version && rustc --version
node --check app/euterpe-extension/euterpe.js
cd agent && npx tsc --noEmit
curl -s http://127.0.0.1:8337/probe      # LER agent/data/probes/probe-<ts>.json (a resposta HTTP é minúscula por design)
cd core && cargo check
```

**Saída que decide D2:** `runtime.node == true` ⇒ autostart por spawn da extensão (com guarda de porta). `false` ⇒ `tools/install-startup.ps1`. Registrar em `PLAN.md` §1.

**DoD:** probe com o nó `runtime` gravado em `agent/data/probes/`; `cargo check` exit 0; D2 registrada.

---

## Fase 1 — Goldens do agente Node (fonte de verdade do Rust)

Sem isso, "paridade" é opinião.

**CREATE** `agent/tools/export-goldens.mjs` → gera `core/tests/fixtures/`:
`tools_client.json`, `tools_server.json`, `system_prompt_en.txt`, `system_prompt_ptbr.txt`, `system_prompt_debug.txt`, `suggestions_prompt.txt`, `routing_prompt.txt`, `trim_final_cases.json` (`[{in,max,out}]`), `parse_suggestions_cases.json`, `i18n_keys.json`, `schema.sql`.

**Comando/validação**
```
cd agent && node tools/export-goldens.mjs
git status --porcelain core/tests/fixtures    # limpo após commit ⇒ determinístico
```

### Corpus de replay (insumo do gate da Fase 2)

**CREATE** `agent/tools/export-replay-corpus.mjs` → extrai os eventos `tool.call` (args completos — ver `agent/src/logging.ts:88`) dos `agent/data/sessions/*.log` para `core/tests/fixtures/sessions/` (JSONL). Medido: **368 tool calls reais** disponíveis no corpus local.

**Privacidade (importante):** `tool.call.args` contém termos de busca, IDs e nomes de playlists — dado pessoal de escuta. Portanto:
- `core/tests/fixtures/sessions/` **é gitignored** (evidência local, não vai para o repo/clone);
- `core/tests/replay_sessions.rs` **pula com mensagem explícita** quando o corpus não existe, para clone limpo continuar verde;
- a comparação é **estrutural** (campos presentes, `ok`/`code`, paths de degradação), não byte-a-byte: nos logs, `tool.result` guarda `name/ok/code/size/duration_ms` + `preview` de 400 chars, não o payload inteiro.

**DoD:** fixtures determinísticas commitadas; corpus de replay gerado localmente e **fora** do índice do git.

---

## Fase 2 — `euterpe.exe` assume a porta 8337 (bridge + proxy de chat)

### 2.1 Crate e dependências

**CREATE** `core/Cargo.toml`:
```toml
[package]
name = "euterpe"
version = "0.2.0"
edition = "2021"

[[bin]]
name = "euterpe"
path = "src/main.rs"

[dependencies]
axum = { version = "0.7", features = ["ws"] }
tokio = { version = "1", features = ["rt-multi-thread","macros","signal","process","time","fs","sync"] }
tower-http = { version = "0.5", features = ["cors","trace"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.32", features = ["bundled"] }     # sqlite estático: sem DLL externa
reqwest = { version = "0.12", features = ["json","stream","rustls-tls"], default-features = false }
tokio-util = { version = "0.7", features = ["io"] }         # StreamReader p/ SSE
futures-util = "0.3"
image = { version = "0.25", features = ["jpeg"] }           # substitui sharp
base64 = "0.22"
rand = "0.8"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter","json"] }
anyhow = "1"
thiserror = "1"
async-trait = "0.1"
chrono = "0.4"
urlencoding = "2"

[dev-dependencies]
tokio-tungstenite = "0.23"
wiremock = "0.6"
tempfile = "3"
```

### 2.2 Módulos (um por responsabilidade; nada de `main.rs` gordo)

| Arquivo | Responsabilidade | Assinatura-âncora |
|---|---|---|
| `core/src/main.rs` | composition root | `#[tokio::main] async fn main() -> anyhow::Result<()>` → `cli::run()` |
| `core/src/cli.rs` | `serve \| mcp --stdio \| --ensure \| install-startup` | `pub enum Cmd { Serve, McpStdio, Ensure, InstallStartup }` |
| `core/src/paths.rs` | data dir (`%APPDATA%\euterpe`; `EUTERPE_PORTABLE=1` → ao lado do exe) | `pub fn data_dir() -> PathBuf` |
| `core/src/config.rs` | env + `config.json`; back-compat `DEEPSEEK_API_KEY` → provider `deepseek` | `pub struct Config { host, port, ws_secret, providers, active_model, mutation_policy, web_search, chat_history_turns, max_tool_steps, suggestions, auto_routing, debug }` |
| `core/src/protocol/mod.rs` | C1/C2/C4 tipados | `#[serde(tag="type")] pub enum ClientMsg` / `pub enum ServerMsg` |
| `core/src/bridge/mod.rs` | registry de sockets, pending map, mutation lock, offline | `pub async fn call_tool(&self, name:&str, args:Value) -> ToolResult`; `pub fn register(&self, sid:Uuid, tx:UnboundedSender<ServerMsg>)` |
| `core/src/ws/mod.rs` | axum `/ws`, handshake, fila serial por conexão de chat | `pub async fn ws_handler(ws: WebSocketUpgrade, state: AppState) -> Response` |
| `core/src/store/db.rs` | schema C10 | `pub fn open(path:&Path) -> anyhow::Result<Connection>` |
| `core/src/store/history.rs` | `save_message`, `get_history`, `clear_history` | paridade com `agent/src/db.ts` |
| `core/src/store/snapshots.rs` | `save_snapshot`, `get_latest_snapshot`, `mark_snapshot_undone` | idem |
| `core/src/store/cache.rs` | `get_cache`, `set_cache` | idem |
| `core/src/store/settings.rs` | `get_setting`, `put_setting` | nova: guarda `mutation_policy`, provider ativo, backend de busca |
| `core/src/http/mod.rs` | `pub fn router(state: AppState) -> Router` | monta todas as rotas |
| `core/src/http/health.rs` | C5 + `app:"euterpe"` | — |
| `core/src/http/bridge_config.rs` | `/config` C5 | — |
| `core/src/http/probe.rs` | `/probe` C5 | — |
| `core/src/http/sessions.rs` | `/sessions`, `/sessions/:id` (lê `data/sessions/*.log`) | — |
| `core/src/http/chat_sse.rs` | `/chat` SSE + proxy p/ `CHAT_UPSTREAM` (Fase 2) | `pub async fn chat(State, Json<ChatReq>) -> Sse<impl Stream<Item=Event>>` |
| `core/src/logging.rs` | `tracing` → arquivo + stderr | — |
| `core/src/i18n.rs` | C11 | `pub fn t(locale:&str, key:&str, vars:&[(&str,&str)]) -> String` |

### 2.3 Invariantes de estado (as que já custaram caro)

1. **Um** socket de extensão autenticado; **N** chamadores em `pending: HashMap<Uuid, oneshot::Sender<ToolResult>>`. Nenhum id reaproveitado.
2. `mutation_lock: Mutex<()>` — **exatamente uma** mutação de playlist em voo (protege snapshot × escrita).
3. Sem extensão viva ⇒ tool de client devolve `{ok:false, code:"client_offline"}` **imediato** (fail-closed). Nunca cache velho, nunca esperar 30 s.
4. `tools/call` do MCP **não** entra na fila serial do chat (MCP é paralelo).
5. `chat.done` é **sempre** emitido (timeout, erro de API, limite de passos, rate-limit).
6. Nenhum array vira objeto para carregar metadado.
7. `activeClient` (singular, hoje em `agent/src/index.ts:32`) → `clients: HashMap<Uuid, ClientHandle>`.

### 2.4 Testes

**CREATE** `core/tests/parity_bridge.rs` (C1/C2), `core/tests/parity_errors.rs` (C3/C4), `core/tests/parity_http.rs` (C5), `core/tests/parity_store.rs` (C10: abre o DB escrito pelo Node e lê as sessões), `core/tests/bridge_concurrency.rs` (2 chamadores simultâneos; kill da extensão no meio ⇒ `client_offline`; 2 mutações concorrentes ⇒ serializadas), `core/tests/replay_sessions.rs` (**gate do flip** — D6: reproduz o corpus de `core/tests/fixtures/sessions/` contra o bridge novo e exige paridade estrutural; pula com aviso se o corpus estiver ausente).

**Comandos**
```
cd core && cargo fmt --check && cargo clippy -- -D warnings && cargo test
cd core && cargo test --test parity_bridge --test parity_errors --test parity_http --test parity_store --test bridge_concurrency
node --check app/euterpe-extension/euterpe.js
cd agent && npx tsc --noEmit && npm test
```

**DoD:** extensão (inalterada) conversa com `euterpe.exe`; UI continua funcionando com `/chat` proxied; `replay_sessions` verde nos 368 tool calls reais (**gate D6**); todos os testes acima verdes.

**Nota de transitório:** durante a Fase 2 a UI depende de dois processos (Rust na frente, Node atrás). Se o Node não subir, o **chat** falha com erro explícito, mas o bridge e o MCP seguem de pé. Isso acaba na Fase 4.

---

## Fase 3 — MCP server

**CREATE** `core/src/mcp/jsonrpc.rs`, `core/src/mcp/server.rs`, `core/src/mcp/catalog.rs`, `core/src/mcp/stdio.rs`, `core/src/mcp/gate.rs`, `core/src/http/mcp.rs`.

**Superfície**
- Métodos: `initialize` (negociação de `protocolVersion` com whitelist; `capabilities.tools.listChanged=false`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `resources/list` (`euterpe://playlists`, `euterpe://currently-playing`), `prompts/list` (`euterpe://curate-playlist`).
- Transportes: `POST /mcp` (Streamable HTTP — `Accept: application/json` → JSON; `Accept: text/event-stream` → SSE; header `Mcp-Session-Id` opcional) **e** `euterpe mcp --stdio` (shim de proxy; logs **somente** em stderr).
- Nomes: `spotify_<name>` derivado do catálogo único (`core/src/tools/catalog.rs`). Contrato congelado: renomear = breaking change (versionar em `/config`).
- Anotações: `readOnlyHint` (`get_*`), `destructiveHint` (as 6 mutantes + `replace_playlist_tracks`), `idempotentHint` (`get_*`, `set_playlist_details`).

**Contrato de resultado (congelado)**
- sucesso: `content:[{type:"text", text: serde_json::to_string(&data)}]`
- falha: `{isError:true, content:[{type:"text", text:"{\"ok\":false,\"code\":\"...\"}"}]}`
- método desconhecido ⇒ `-32601`; tool desconhecida ⇒ `isError` (nunca throw).

**Política de mutação (D3)**
- `mutation_policy: "allow" | "confirm" | "deny"` em `settings`, default **`allow`**; `mutation_allowlist` opcional.
- **Independente da política**: snapshot **antes** de toda mutação; resultado carrega `{snapshot_id, undo_hint:"spotify_undo_last_mutation"}`.
- `spotify_undo_last_mutation` **exposto no MCP** (é o cinto de segurança do default permissivo).
- `confirm` reusa o fluxo `proposal.create` (popup no Spotify, timeout 120 s).

**Testes:** `core/tests/mcp_protocol.rs` (initialize, `tools/list` == catálogo congelado, `-32601`, tool inexistente, `Accept` SSE vs JSON, sessão), `core/tests/mcp_gate.rs` (allow/confirm/deny + snapshot presente em **todos** os caminhos).

**Smoke**
```
curl -sX POST http://127.0.0.1:8337/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
curl -sX POST http://127.0.0.1:8337/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
opencode mcp add euterpe --url http://127.0.0.1:8337/mcp
```

**DoD:** `opencode mcp add` lista e chama `spotify_get_currently_playing`; mutação grava snapshot; undo reverte.

---

## Fase 4 — Loop LLM nativo + providers

**CREATE**
- `core/src/llm/canonical.rs` — coração da portabilidade:
  ```rust
  pub enum Msg {
      System(String),
      User(String),
      Assistant { text: Option<String>, tool_calls: Vec<ToolCall> },
      Tool { id: String, content: String },
  }
  pub enum LlmEvent { Delta(String), Reasoning(String), ToolCall(ToolCall), Usage { input: u32, output: u32 }, Done }
  #[async_trait]
  pub trait LlmAdapter: Send + Sync {
      fn wire(&self) -> Wire;                  // OpenAiCompat | Anthropic | Gemini | Ollama
      fn capabilities(&self) -> Caps;          // streaming, tools, json_mode, reasoning_field
      async fn stream(&self, req: ChatRequest, tx: mpsc::Sender<LlmEvent>) -> anyhow::Result<()>;
      async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>>;
      async fn test(&self) -> anyhow::Result<TestReport>;   // 1 chamada barata; devolve latência
  }
  ```
- `core/src/llm/adapters/{openai_compat,anthropic,gemini,ollama}.rs`
- `core/src/llm/sse.rs` (parser único; tolera chunk cortando no meio de um `data:`)
- `core/src/llm/loop.rs` — paridade com `agent/src/agent.ts:299-446`: `rateLimited: HashSet`, `consecutiveRateLimited >= 2 ⇒ forceAnswer`, `FORCE_ANSWER_MSG`, `MAX_FINAL_LENGTH=4000`, `MAX_TOOL_STEPS` do config, degradação graciosa com `chat.done` sempre.
- `core/src/llm/prompts.rs` (C7/C8/C9 — golden-tested), `core/src/llm/suggestions.rs` (chamada JSON mode + fallback no parser tolerante)
- `core/src/providers/registry.rs`, `core/src/secrets.rs` (keyring Windows + fallback arquivo com ACL; `GET` devolve só `{has_key:true}`)
- `core/src/http/providers.rs` (`GET /providers`, `GET /models?provider=&base_url=`, `POST /providers/test`), `core/src/http/settings.rs` (`GET/PUT /settings`)

**Contratos de provider (principais + o "tradicional" custom)**
1. `openai-compat` — `base_url` + `api_key` + modelo (OpenAI, DeepSeek, Groq, Together, OpenRouter, xAI, vLLM).
2. `anthropic` — Messages API (converte `Msg` ↔ `content` blocks `tool_use`/`tool_result`).
3. `gemini` — `generateContent` + `alt=sse`.
4. `ollama` / `lmstudio` — local, sem chave.
5. **custom** — qualquer dos wires com `base_url`/`headers{}`/`extra_body{}` livres.

**Regras de portabilidade**
- `response_format: json_object` é capability; onde faltar, cai no parser tolerante C8.
- `reasoning_content` (DeepSeek) é campo de adapter: **nunca** reenviar no histórico.
- 429 com `Retry-After` longo: **falhar rápido** (não dormir o `Retry-After`).

**Testes:** `core/tests/adapters_openai.rs`, `adapters_anthropic.rs`, `adapters_gemini.rs` (com `wiremock`: streaming fragmentado, tool_calls, 401, 429), `core/tests/llm_loop_degrade.rs` (2 rate_limit ⇒ forceAnswer e **todos** os `tool_calls` recebem resposta, senão a API devolve 400), `parity_prompts.rs` (C7/C8/C9).

**DoD:** os 4 wires passam nos adapters tests; agente Node passa a ser só oráculo.

---

## Fase 5 — Exe único, autostart, sem Docker

- **Autostart (D2)**: `core/src/startup.rs` + `tools/install-startup.ps1`. `euterpe --ensure` faz `GET /health` e sai 0 se já houver euterpe (comparar `app:"euterpe"`).
- **Sem Docker**: `core/src/tools/server/web_search.rs` com cadeia `SearXNG (se SEARXNG_URL) → Brave/Tavily (se chave) → DuckDuckGo HTML`. `docker-compose.yml` vira **opcional** (mover para `searxng/`, documentar).
- **Cover**: `image` crate, JPEG ≤256 KB, base64; teste afirma `bytes <= 256*1024` e assinatura JPEG válida.
- **Distribuição**: `cargo build --release` → `%APPDATA%\euterpe\euterpe.exe`; migração one-time de `agent/data/euterpe.db` → `%APPDATA%\euterpe\euterpe.db` feita pelo `install.mjs`.

**CREATE** `core/src/tools/server/{web_search,lyrics,charts,enrich,image_search,cover,weekly_report}.rs`, `core/src/tools/server/mod.rs` (`run_server_tool` — paridade com `agent/src/tools/server.ts:404-451`), `core/tests/cover.rs`, `tools/install-startup.ps1`, `core/src/startup.rs`.

**DoD:** um único `euterpe.exe`; `docker compose` **não** é pré-requisito para o chat; `/health` responde `app:"euterpe"`.

---

## Fase 6 — UI (Propostas 2 e 3)

**Decisão D4:** bundle com esbuild.

**CREATE**
- `app/build.mjs` (esbuild → `app/euterpe-app/dist/index.js`)
- `app/euterpe-app/lib/daemon.js` (`streamChat` SSE, `getSettings`, `saveSettings`, `testProvider`, `listModels`, `mcpInfo`)
- `app/euterpe-app/lib/i18n.js`
- `app/euterpe-app/ui/chat.js`
- `app/euterpe-app/ui/settings.js`
- `app/euterpe-app/ui/mcp-panel.js`
- `app/euterpe-app/ui/markdown.js` — **mover verbatim** `renderMarkdown`/`mdInline`/`spotifyChip`/`nativeIcon`/`euterpeLogo` de `index.js`
- `app/euterpe-app/ui/sessions.js` — extrair `useSessions`

**MODIFY**
- `app/euterpe-app/index.js` → só bootstrap + registro no Spicetify (de 1389 linhas para ~80)
- `app/install.mjs` → build (`node app/build.mjs`, `cargo build --release`) + copiar bundle + copiar exe + migrar DB + registrar autostart + imprimir snippets de MCP

**Paridade funcional mínima do chat "robusto" (checklist de aceite)**
- [ ] streaming com botão **stop**
- [ ] copiar mensagem
- [ ] regenerar
- [ ] editar e reenviar
- [ ] tool cards colapsáveis (status + duração)
- [ ] painel de proposta de mutação (já existe) + **diff** do que muda
- [ ] autoscroll com lock
- [ ] seletor de modelo/provider no header
- [ ] pills de sugestão (já existem)
- [ ] erros em toast
- [ ] atalhos (`Enter`, `Shift+Enter`, `Esc` = stop)

**`ui/mcp-panel.js` (Proposta 2)** — chip "MCP ativo · N clientes", URL, snippets copiáveis:
```
opencode:     opencode mcp add euterpe --url http://127.0.0.1:8337/mcp
claude-code:  claude mcp add --transport http euterpe http://127.0.0.1:8337/mcp
json (stdio): {"mcpServers":{"euterpe":{"command":"C:\\Users\\<user>\\AppData\\Roaming\\euterpe\\euterpe.exe","args":["mcp","--stdio"]}}}
```

**DoD:** painel de setup com (a) providers/modelos/chaves + botão "testar" e (b) MCP com instruções; chat com os itens do checklist.

**Camada DS (aplicada) — `app/euterpe-app/ui/ds.js`**

A UI não desenha componente à mão: o que é widget sai de `ui/ds.js`, que é a cópia da tela
de configurações **nativa** do Spotify. Divisão explícita:

| Peça | Origem | Por quê |
|---|---|---|
| texto, toggle, botões, tooltip | `Spicetify.ReactComponent.*` | são os componentes do próprio client, expostos pelo spicetify |
| select, input, textarea, linha de setting, painel, item de lista, badge | markup + CSS copiado | **não** existem em `Spicetify.ReactComponent`; a tela nativa também usa `<select>` cru + classe |
| cor, espaço, raio, tipografia | tokens do Encore (`--encore-*`, `--background-*`, `--text-*`, `--essential-*`, `--decorative-*`) | zero hex inventado no JSX |

Fonte da verdade (ler do client instalado, nunca de memória):

```
%APPDATA%\Spotify\Apps\xpui\xpui-routes-desktop-settings.js    # estrutura (linha de setting, toggle, select)
%APPDATA%\Spotify\Apps\xpui\xpui-routes-desktop-settings.css   # declarações (a classe com hash de origem)
%APPDATA%\Spotify\Apps\xpui\xpui-snapshot.css                  # tokens do Encore sob .encore-dark-theme
%LOCALAPPDATA%\spicetify\jsHelper\spicetifyWrapper.js          # o que o spicetify realmente expõe
```

**Fallback é obrigatório** (`rc()` resolve no render): se o componente nativo não existir
na versão instalada, o markup copiado assume. Motivo medido: o `Toggle` é detectado pelo
wrapper por heurística (`["onSelected", 'type:"checkbox"']`) e o módulo mora no **chunk da
rota de Settings** — se a tela nativa nunca foi aberta, pode não estar no cache. O fallback
usa o **mesmo CSS** nativo, então a aparência não muda.

Gate da camada: `node app/build.mjs` + harness de render (32 passes, com e sem os
componentes nativos). O harness vive fora do repo: `%TEMP%\opencode\euterpe-ui-harness.mjs`.

**Armadilhas pagas nesta camada** (não repita):

| Armadilha | Consequência / correção |
|---|---|
| `nativeIcon(nome)` com nome que não existe no client | devolve `null` **em silêncio** → botão invisível (foi o caso do `ban`). A lista real é `Object.keys(Spicetify.SVGIcons)` (77 ícones em 1.3.4; **não** há `ban`/`trash`/`delete`). Sempre `nativeIcon(...) \|\| fallback` |
| `width: 100%` (do `.ds-item`) + `margin` lateral | estoura a largura e abre **barra horizontal** no rail. O recuo vem do padding do container; texto longo quebra com `ellipsis` |
| Componente do Encore sem `box-sizing: border-box` | `padding` soma à largura declarada e estoura o container — a camada declara border-box para `.ds-*` |
| Backtick dentro do template literal do CSS (mesmo em comentário) | fecha a string e o resto da folha vira código JS. O check de CSS procura backtick cru na fonte |

---

## Fase 7 — Cutover e docs

- Mover `agent/` → `legacy/agent-node/` (ou remover), preservando apenas `agent/tools/export-goldens.mjs`.
- Atualizar `PLAN.md` (§1 decisões D1-D5, roadmap), `README.md`, `app/README.md` (setup em 2 passos, sem Docker), `CHANGES.md`, `PLAN-INTERNAL-API.md` (nada muda no probe).

**DoD:** docs refletem o estado real; nenhum caminho aponta para `npm run dev`.

---

## Comandos de validação (gate de cada fase)

```
# mod
node --check app/euterpe-extension/euterpe.js
cd agent && npx tsc --noEmit && npm test
cd agent && npm run test:integration          # com o daemon PARADO (colide na 8337)
node app/build.mjs && node app/install.mjs    # + reiniciar Spotify

# rust
cd core && cargo fmt --check && cargo clippy -- -D warnings && cargo test
cd core && cargo build --release

# paridade (Fases 2-4)
cd core && cargo test --test parity_tools --test parity_prompts --test parity_errors --test parity_http --test parity_store

# SHA das 3 cópias da extensão deve bater (senão "alterei e não pegou")
#   app/euterpe-extension/euterpe.js
#   %APPDATA%\spicetify\Extensions\euterpe.js
#   %APPDATA%\Spotify\Apps\xpui\extensions\euterpe.js
```

Regra do protocolo global: **duas falhas seguidas no mesmo erro ⇒ parar e escalar** com diff + stderr, sem 3ª tentativa especulativa.

---

## Definition of Done (visão de projeto)

- **F2:** extensão (JS, inalterada) conversa com `euterpe.exe`; `/chat` proxied; C1-C5 + C10 verdes.
- **F3:** `opencode mcp add` funciona; `tools/list` == catálogo congelado; mutação com snapshot; undo reverte.
- **F4:** 4 wires de provider verdes; Node só como oráculo.
- **F5:** um `euterpe.exe`; autostart conforme D2; sem Docker.
- **F6:** painel de setup (providers + MCP) e chat com o checklist completo.
- **F7:** `legacy/agent-node` removido; docs atualizados.

---

## Pendências

Nenhuma pendência **bloqueante**. As quatro restantes têm gatilho definido (nenhuma exige decisão prévia):

| # | Pendência | Tipo | Gatilho / dono |
|---|---|---|---|
| P2 | Autostart: spawn pela extensão **vs** atalho de Startup (D2) | medição | Fase 0 — nó `runtime.node` do probe decide |
| P3 | Corpus de replay precisa ser gerado localmente (dado pessoal, gitignored) | operacional | Fase 1/2 — `agent/tools/export-replay-corpus.mjs` |
| P4 | `sharp` → `image`: provar que o cover sai JPEG ≤256 KB e válido | prova | Fase 5 — `core/tests/cover.rs` |
| P5 | Contratos aditivos (`/health.app`, `client_offline`, rotas novas) só entram nos docs canônicos ao final | doc | Fase 7 — `PLAN.md`/`PLAN-INTERNAL-API.md` |

Fechadas nesta rodada: **P0** baseline sem commit (`12dd2ae`), **P1** decisão da Fase 2 (D6), **P6** ratificação do bundle esbuild (D4), **P7** plano fora do repo (este arquivo), **P5/P7** fontes não versionadas.

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Conversão de mensagens p/ Anthropic (`tool_use`/`tool_result`) | Escrever `canonical.rs` com teste de ida-e-volta **antes** do adapter |
| `sharp` → `image` mudar bytes do cover | Teste afirmando ≤256 KB + JPEG válido, comparando com cover gerado pelo Node |
| `better-sqlite3` → `rusqlite` corromper histórico | `parity_store.rs` abre o DB escrito pelo Node e lê as sessões |
| Quirks de SSE por provider | `sse.rs` único + fixtures fragmentadas no `wiremock` (chunk no meio de um `data:`) |
| Rust "big bang" atrasar entrega | Strangler fig: F2 já é utilizável sozinha com `/chat` proxied |
| Catálogo duplicado (LLM vs MCP) | `core/src/tools/catalog.rs` único + `parity_tools.rs` como gate |
| Fan-out HTTP em `enrich_tracks`/`chart_lookup` | Reusar semântica de `mapLimit` (limite de concorrência explícito) |
| Acesso a Node no renderer é hipótese | Fase 0 mede; autostart por atalho é o plano B — nada depende disso para funcionar |
| Node reaproveitando `activeClient` singular | `clients: HashMap<Uuid, ClientHandle>` + `bridge_concurrency.rs` |

---

## Ordem de execução

`F0 → F1 → F2 → F3 → F5(parcial: autostart + web_search sem Docker) → F6(básico: painel MCP + settings) → F4(providers) → F6(completo) → F7`

## Estimativa de esforço (ordem de grandeza)

| Fase | LOC Rust (aprox.) | Sessões |
|---|---|---|
| F0 | ~30 (JS) | 0,5 |
| F1 | ~150 (JS) | 0,5 |
| F2 | ~1.200 | 2-3 |
| F3 | ~600 | 1-2 |
| F4 | ~1.200 | 2-3 |
| F5 | ~500 | 1 |
| F6 | ~900 (JS) | 2 |
| F7 | docs | 0,5 |
