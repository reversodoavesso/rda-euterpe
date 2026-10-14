# Euterpe — Changes

Registro das mudanças, do que foi provado por teste e das pendências com gatilho.
Histórico: v1 = auditoria i18n/prompts/clean-code (seção "v1" abaixo); v2 = refatoração
de `PLAN-REFACTOR.md` (MCP + providers + UI + daemon Rust).

---

# v2 — Refatoração completa (`PLAN-REFACTOR.md`, decisões D1–D6)

**Data:** 2026-10-14 · **Baseline de partida:** `12dd2ae` · **Status:** F0–F5 e F7 aplicadas;
F6 aplicada (UI modularizada + painel de setup/MCP); **todos os gates verdes**.

## Resumo executivo

O backend deixou de ser um servidor Node e virou **um único `euterpe.exe`** (Rust, sem Docker),
que assume a porta `8337`, mantém o contrato WS congelado da extensão, serve o **MCP** por
Streamable HTTP **e** por stdio, roda o **loop LLM agentic** com 4 wires de provider e executa as
tools de servidor com cadeia própria de busca na web. A extensão **não mudou uma linha de
protocolo** — a única alteração nela é o nó `runtime` do probe da Fase 0.

## Fase 0 — Preflight

| O quê | Onde |
|---|---|
| Medição de R1 (`typeof require`, `process.versions`) no nó `runtime` do probe | `app/euterpe-extension/euterpe.js` (`runProbe()`) |
| Toolchain fixado (canal 1.99.0, host `x86_64-pc-windows-gnu`) | `core/rust-toolchain.toml`, `core/.cargo/config.toml` |
| Crate mínimo validando toolchain + toda a árvore de deps | `core/Cargo.toml` |

**Decisão registrada (D2):** o autostart default é o **atalho de Startup**
(`tools/install-startup.ps1`, `euterpe install-startup`). O caminho "spawn pelo renderer" fica
disponível mas não é assumido, porque a medição de `runtime.node` só existe após rodar o mod com
o daemon de pé. Ver `PLAN.md` §1.

**R2 (toolchain) — o que foi descoberto na prática e está documentado em `core/README.md` §1:**
`LLVM-MinGW` **não** serve para linkar o std do Rust (falta `libgcc.a` → `lld: error: unable to
find library -lgcc`); foi instalado **WinLibs POSIX/UCRT** (GCC de verdade) e o host virou
`x86_64-pc-windows-gnu`. Sem MSVC (instalar Build Tools exige admin).

## Fase 1 — Goldens e corpus

| Artefato | Gerado por |
|---|---|
| `core/tests/fixtures/tools_{client,server,mutating,counts}.json` | `agent/tools/export-goldens.mjs` |
| `core/tests/fixtures/system_prompt_{en,ptbr,debug,ptbr_debug}.txt` | idem |
| `core/tests/fixtures/{suggestions,routing}_prompt_{en,ptbr}.txt` | idem |
| `core/tests/fixtures/{trim_final,parse_suggestions,normalize_locale}_cases.json` | idem |
| `core/tests/fixtures/i18n_keys.json`, `schema.sql` | idem |
| `core/src/assets/tools.json`, `core/src/assets/prompts.json` (**runtime**, D5) | idem |
| `core/tests/fixtures/sessions/*.jsonl` (**gitignored** — dado pessoal) | `agent/tools/export-replay-corpus.mjs` |

Para manter os goldens exportáveis, o agente Node ganhou exports **aditivos**
(`buildSystemPrompt`, `SUGGESTIONS_PROMPT`, `buildRoutingPrompt`, `FORCE_ANSWER_MSG`,
`MAX_FINAL_LENGTH`, `STREAM_DELAY_MS`, `SUGGESTIONS_MAX_TOKENS`, `SCHEMA_SQL`). Nenhuma mudança de
comportamento; `npx tsc --noEmit` e `npm test` seguem verdes.

**Números medidos:** catálogo congelado em **25 client + 11 server = 36**; corpus de replay com
**216 tool calls reais** em 8 sessões (o plano estimava 368 — a diferença é que o corpus só conta
`tool.call` já registrados e exclui `probe`).

## Fase 2 — `euterpe.exe` assume a 8337

**Módulos entregues** (um por responsabilidade): `main`, `cli`, `paths`, `config`, `secrets`,
`logging`, `i18n`, `protocol`, `bridge`, `ws`, `store/{db,history,snapshots,cache,settings}`,
`http/*`, `upstream`.

**Invariantes §2.3 implementadas e testadas** (`tests/bridge_concurrency.rs`):

1. registry é `HashMap<Uuid, ClientHandle>` — só o **mais recente** é ativo (sem o bug do
   `activeClient` singular);
2. `mutation_lock` ⇒ **exatamente uma** mutação em voo (o teste mede o pico de propostas
   concorrentes e exige `peak == 1`);
3. sem extensão ⇒ `{ok:false,code:"client_offline"}` **imediato** (teste mede `< 250 ms`);
4. id de chamada em voo não é reaproveitado (`duplicate_call_id`);
5. `pending` global ⇒ o MCP chama tools em paralelo, fora da fila serial do chat
   (8 chamadas concorrentes testadas).

**Espelho / flip (D6):** `CHAT_UPSTREAM=ws://127.0.0.1:8338/ws` faz o daemon abrir **uma**
conexão de saída para o agente Node, encaminhar o chat para cima e retransmitir tudo o que desce
para a extensão, sem duplicar nenhuma chamada às APIs internas do Spotify. Vazio ⇒ loop LLM
nativo. O flip é 1 variável e **não exige mudar o Node** (ele já fala o mesmo WS).

## Fase 3 — MCP

- **Um só catálogo (D5)**: `core/src/tools/catalog.rs` alimenta `tools/list` do MCP **e**
  `allToolSchemas` do loop. Nomes `spotify_<name>`; renomear é breaking change.
- Anotações: `readOnlyHint` (todas as leituras), `destructiveHint` (as 6 mutantes),
  `idempotentHint` (leituras + `set_playlist_details`).
- Transportes: `POST /mcp` (JSON ou SSE conforme `Accept`, sessão via `Mcp-Session-Id`),
  `DELETE /mcp`, `GET /mcp` → 405 com `Allow`, e `euterpe mcp --stdio` (stdout = **só**
  protocolo; logs em stderr).
- Métodos: `initialize` (whitelist 2025-06-18/2025-03-26/2024-11-05, `listChanged:false`), `ping`,
  `tools/list`, `tools/call`, `resources/list|read` (`euterpe://playlists`,
  `euterpe://currently-playing`), `prompts/list|get` (`euterpe://curate-playlist`).
- Contrato de resultado: sucesso `content:[{type:"text",text:<json>}]`; falha
  `{isError:true,...}`; método desconhecido `-32601`; **tool desconhecida nunca é throw**.
- **Gate de mutação (D3):** `mutation_policy` = `allow` (default) | `confirm` | `deny`, com
  `mutation_allowlist` opcional. Snapshot **sempre** antes de mutar (inclusive em `allow`) e o
  resultado carrega `{snapshot_id, undo_hint:"spotify_undo_last_mutation"}`.
  `spotify_undo_last_mutation` é exposto no MCP — é o cinto de segurança do default permissivo.

## Fase 4 — Loop LLM nativo + providers

- `llm/canonical.rs` (tipos + trait), `llm/sse.rs` (parser tolerante a chunk cortado no meio de um
  `data:`), `llm/prompts.rs` (C7/C8/C9), `llm/loop.rs` (paridade com `runAgentLoop`),
  `llm/suggestions.rs`, `llm/adapters/{openai_compat,anthropic,gemini,ollama}`.
- **Portabilidade:** `Wire` é o único switch — adicionar provider é adicionar preset em
  `config.rs`, nunca um `if` no loop. `reasoning_content` (DeepSeek) é campo de adapter e **nunca**
  volta no histórico. `response_format: json_object` é capability; onde falta, vale o parser
  tolerante do C8. 429 falha rápido (não dorme o `Retry-After`).
- **Degradação:** 2 `rate_limited` consecutivos ⇒ `forceAnswer` ⇒ chamada **sem tools**; todos os
  `tool_calls` do lote ainda recebem mensagem `tool` (senão a API devolve 400); `chat.done` é
  **sempre** emitido. Provado em `tests/llm_loop_degrade.rs`.
- **Providers e chaves:** `GET /providers` (nunca devolve chave — só `hasKey`),
  `POST /providers` (upsert + chave), `DELETE /providers/:id`, `GET /models`,
  `POST /providers/test` (testa **antes** de persistir a chave; devolve latência/erro
  classificado). Back-compat: `DEEPSEEK_API_KEY` / `LLM_BASE_URL` / `LLM_CHAT_MODEL` continuam
  valendo.

## Fase 5 — Exe único, autostart, sem Docker

- `euterpe --ensure` (idempotente, compara `app:"euterpe"` no `/health`), `serve` com guarda de
  porta, `install-startup` (atalho `.lnk` via PowerShell/WScript) e `tools/install-startup.ps1`.
- **`web_search` sem Docker:** cadeia `SearXNG (se configurado) → Brave (chave) → Tavily (chave) →
  DuckDuckGo HTML` (parser próprio, sem regex dinâmica, testado com fixture).
- **Cover:** `sharp` → `image` (puro Rust). P4 fechada: `tests/cover.rs` prova JPEG ≤256 KB válido,
  proporção preservada, PNG de entrada aceito, e `cover_too_large` em vez de arquivo quebrado.
- `docker-compose.yml` movido para `searxng/` e documentado como **opcional**.

## Fase 6 — UI

- Bundle com **esbuild** (`app/build.mjs` → `app/euterpe-app/dist/index.js`).
- `index.js` reduzido a bootstrap; UI dividida em `lib/{daemon,i18n}.js` e
  `ui/{chat,settings,mcp-panel,markdown,sessions}.js` (markdown/chips/markdown movidos verbatim).
- Painel de setup (providers/modelos/chaves + "testar" + toggles) e painel **MCP** com os 3
  snippets copiáveis.
- `install.mjs` passou a fazer build, copiar o bundle, copiar o exe, registrar o autostart e
  migrar o banco do Node (sem sobrescrever).

## Fase 7 — Cutover e docs

- `PLAN.md` (§1 com D2/D5/D6), `README.md`, `app/README.md`, `core/README.md` (novo) e este
  `CHANGES.md` refletem o estado real. Nenhum caminho aponta para `npm run dev`.
- **`agent/` NÃO foi movido para `legacy/agent-node/`** — ver "Desvios" abaixo.

## Gates de validação (todos com exit 0)

```
cd core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
         → 258 testes: 124 unit + 134 de integração (18 binários de teste)
node --check app/euterpe-extension/euterpe.js          (e todos os 12 arquivos JS da UI)
cd app && node build.mjs                               → bundle 89,9 KiB
cd agent && npx tsc --noEmit && npm test               → 14/14
node app/install.mjs                                   → mod + daemon + autostart instalados
tools/smoke-daemon.ps1                                 → 24/24
tools/smoke-bridge.mjs                                 → 14/14
```

## Desvios do plano (e por quê)

| Item do plano | Feito | Motivo |
|---|---|---|
| `reqwest` com `rustls-tls` | `native-tls` (SChannel) | `rustls` 0.23 puxa `aws-lc-rs`, que precisa de **cmake + nasm**; sem impacto no contrato HTTP |
| `keyring` Windows para as chaves | `data/secrets.json` com ACL restrita (`icacls`) + fallback por env | evita a árvore `windows-sys`; a API pública só expõe `hasKey` |
| catálogo e prompts escritos à mão em Rust | **gerados** como asset JSON do Node | paridade por construção (D5); a *lógica* (loop, gates, parsers, trim, sugestões) é Rust e testada contra as fixtures |
| `core/src/http/mcp.rs` | `core/src/mcp/http.rs` | deixa o servidor MCP autocontido (transporte junto do protocolo) |
| `agent/` → `legacy/agent-node/` | mantido em `agent/` | (a) o flip da Fase 2 precisa do Node vivo como upstream; (b) `export-goldens.mjs` depende de `../dist` — mover quebraria o gerador de goldens. **Para mover depois:** `git mv agent legacy/agent-node` e ajustar os `resolve(__dirname, "..", "dist", …)` em `legacy/agent-node/tools/export-goldens.mjs` |
| `Tastedive` como fonte de similares | lastfm + deezer mantidos; tastedive só como chave configurável | comportamento idêntico ao Node (ele também não chama a TasteDive hoje) |
| `profile.release` com `strip = true` + `lto = true` | `strip = false` + `lto = "thin"` | o binário *stripped* de 5 MB disparou o ML do Defender como `Trojan:Win32/Bearfoos.A!ml` e teve a execução bloqueada (P17) |
| testes de wire com `wiremock` para streaming fragmentado | `wiremock` para tudo **exceto** os dois casos de chunk fatiado, que usam um servidor TCP mínimo com `Transfer-Encoding: chunked` no próprio teste | o `wiremock` 0.6 entrega o corpo em **um único chunk** (`Full<Bytes>`), então não consegue cortar no meio de uma linha `data:` de forma determinística — o teste alternativo prova mais, não menos |

## Achado real do gate de replay (D6)

O corpus revelou `get_audio_features_bulk` sendo chamada pelo modelo — e **essa tool não existe em
`agent/src/tools/defs.ts`** (só há uma *label* i18n para ela). Ou seja: já era `unknown_tool:<n>` no
Node, e continua sendo aqui. O teste de replay agora carrega uma allowlist explícita
(`LEGACY_HALLUCINATED`) e **falha** se o nome entrar no catálogo sem decisão registrada. Nada a
corrigir — mas era o tipo de divergência que o gate existia para encontrar.

## Validação ao vivo (nesta máquina, ao final da implementação)

| Evidência | Resultado |
|---|---|
| `tools/smoke-daemon.ps1` (daemon isolado, porta 8399, dados em temp) | **24/24** checagens — `/health` com `app:"euterpe"`, MCP `tools/list` = 36, `/probe` 503, PUT `/settings`, `/providers` sem chave, SSE `/chat` com `event: done`, 2ª instância idempotente |
| `tools/smoke-bridge.mjs` (bridge WS real na 8337) | **14/14** checagens — handshake inválido fecha **1008**, `hello.ok`, `ping/pong`, mensagem inválida não derruba, `chat.send`→`chat.done`, `chat.clear`→`chat.cleared` |
| Extensão **real** no Spotify **real** | `INFO euterpe::ws: cliente autenticado locale=pt-br` (3×) — o mod conectou no `euterpe.exe` sem uma linha de mudança na extensão |
| `node app/install.mjs` | exit 0 — bundle (89,9 KiB) + manifest + extensão em `<spicetify>/…`, `spicetify apply` OK, atalho de Startup criado, snippets de MCP impressos |
| SHA-1 das **3 cópias** da extensão | idênticos (`846FBE49…`) — o problema de "alterei e não pegou" está resolvido |
| Banco migrado | `agent/data/euterpe.db` → `%APPDATA%\euterpe\euterpe.db` (65536 bytes, mesmo tamanho); o daemon abriu e criou WAL sem erro |

**Ainda não validado ao vivo:** uma resposta real de LLM (o daemon não tem chave de provider
configurada — ver P18) e o `CHAT_UPSTREAM` com o Node (P9).

## Achados de execução (bugs reais corrigidos durante a validação)

1. **Dois testes escreviam na casa do usuário.** `Config::from_sources` materializava o
   `ws-secret` (gravando em `%APPDATA%\euterpe`) e `persist_provider` gravava `config.json` no
   caminho global. Corrigido: `from_sources` ficou **puro** (o segredo só é resolvido em
   `Config::load()`) e `persist_provider` passa a usar `state.cfg.data_dir`. O resíduo do teste
   (`providers` com um `meu-vllm`) foi limpo do `config.json` real.
2. **`install.mjs` não achava o exe.** Ele só olhava `core/target/release/`, mas neste host o
   alvo é `x86_64-pc-windows-gnu`. Agora tenta os dois caminhos.
3. **`install.mjs` morria com `EBUSY`** ao copiar o exe com o daemon em execução (Windows trava o
   arquivo). Agora avisa, **não aborta** e segue registrando o autostart.
4. **Falso-positivo do Defender.** O exe com `strip = true` foi detectado como
   `Trojan:Win32/Bearfoos.A!ml` e teve a execução bloqueada (inclusive na cópia em `%APPDATA%` e no
   atalho de Startup), e depois também no `target/`. Perfil de release mudado para
   `strip = false` + `lto = "thin"` (13,5 MB, com símbolos) e a execução voltou a funcionar.
   Ver **P17**.

## Pendências e pontos de ajuste

| # | Pendência | Tipo | Como fechar |
|---|---|---|---|
| P8 | **Validação ao vivo com o Spotify** | operacional | **parcialmente fechada**: a extensão conecta no daemon e o bridge responde (ver "Validação ao vivo"). Falta conversar no chat com um provider configurado |
| P9 | **`CHAT_UPSTREAM` nunca foi exercitado com o Node de verdade** | prova | `$env:CHAT_UPSTREAM='ws://127.0.0.1:8338/ws'` no daemon + `cd agent && npm run dev` |
| P10 | **`runtime.node` do probe** (decide o plano A do autostart) | medição | abrir o mod no Spotify e ler `%APPDATA%\euterpe\probes\probe-*.json` (o nó `runtime` já é gravado) |
| P11 | **Chamada real a cada provider** (4 wires) | prova | `POST /providers/test` com uma chave de cada (os testes de wire usam mocks/`wiremock`) |
| P12 | **Cancelamento do SSE** — o botão stop corta o fetch no cliente, mas o loop do daemon segue até o fim | melhoria | propagar um `CancellationToken` da rota `/chat` para `ChatDeps` |
| P13 | **Texto streamado vs. `trimFinal`** — no caminho SSE o cliente vê o texto completo (sem o corte de 4000) | comportamento intencional | documentado; se quiser paridade estrita, cortar também no stream |
| P14 | **Keyring nativo** em vez de arquivo+ACL | hardening | trocar `core/src/secrets.rs` por `keyring` quando a árvore de deps for aceitável |
| P15 | **`agent/` promovido a `legacy/`** | organização | ver a linha correspondente em "Desvios" |
| P16 | Autostart por spawn na extensão (plano A) só depois de P10 | medição | implementar `spawnAvailable` como caminho do handshake |
| P17 | **Falso-positivo do antivírus** — `Trojan:Win32/Bearfoos.A!ml` no binário não assinado; a mitigação aplicada (`strip = false`) resolveu aqui, mas o download de um release para outra máquina pode repetir | ambiente | com admin: `Add-MpPreference -ExclusionPath "$env:APPDATA\euterpe"` (e para `core\target` em dev) ou "Permitir no dispositivo" no Windows Security; a alternativa de longo prazo é assinar o binário |
| P18 | **Chave de provider não é herdada do `agent/.env`** — o agente Node usava `dotenv`; o daemon lê env + `config.json`, e a chave se cadastra pelo painel (`POST /providers`) | migração | abrir o painel de setup do Euterpe no Spotify e colar a chave (ou exportar `DEEPSEEK_API_KEY` antes de subir o daemon). Um leitor de `.env` opcional no data dir cairia bem, mas ficou de fora por ser escopo novo |
| P19 | **`/probe` e `/chat` do modo nativo não publicam os `tool.call` no SSE** — no modo nativo a UI vê `status:"tool"` com o label, não os args (`CHAT_UPSTREAM` publica) | melhoria | publicar `tool.call` no sink do SSE dentro do loop |

## Contratos aditivos que entraram nos docs canônicos (P5)

- `/health` ganhou `app:"euterpe"`, `version`, `clients`, `upstream`;
- `/config` ganhou `app`, `clients`;
- código novo **`client_offline`** (fail-closed quando não há extensão viva);
- rotas novas: `POST /chat` (SSE), `GET/POST/DELETE /mcp`, `GET/POST /providers`,
  `DELETE /providers/:id`, `GET /models`, `POST /providers/test`, `GET/PUT /settings`;
- eventos SSE: `status`, `stream`, `tool`, `proposal`, `cleared`, `done`, `error`;
- i18n: 2 chaves novas no daemon (`status.clientOffline`, `fallback.noApiKeyRust`) — o teste de
  paridade exige que **só** essas duas existam além do golden do Node.

---

# v1 — auditoria i18n / prompts / clean code

Documentação da auditoria, das mudanças pedidas e do plano de implementação da refatoração
"i18n + comentários/prompts em inglês + clean code".

## Mudanças pedidas

1. Usar múltiplos agentes para ajudar a resolver os problemas.
2. Evitar textos de resposta pré-escritos fixos ao máximo; onde o fallback é inevitável, passá-lo
   pelo sistema de locale (ponto 3).
3. Sistema de locale para todo texto de interface: **en** (default) e **pt-br**, resolvido da
   configuração do Spotify.
4. Todo prompt engineering / diretriz de modelo em **inglês**; todos os comentários de código em
   **inglês**.
5. Revisão de clean code seguindo boas práticas.

## Achados da auditoria

### i18n

Todo texto de interface estava fixo em português do Brasil:

| Camada | Strings PT fixas |
|---|---|
| `app/euterpe-app/index.js` | Toda a cópia da UI (botões, status, estado vazio, placeholder, erro, subtítulo do header, fallback de título de sessão) |
| `app/euterpe-extension/euterpe.js` | "agente desconectado", `tool_nao_implementada`, strings de debug |
| `agent/src/*.ts` | `TOOL_LABELS`, detalhes de status ("Analisando…"), respostas de fallback, títulos de proposta do `summarize()`, "mensagem inválida", logs |

O fluxo de locale já existia parcialmente: a extensão lê `Spicetify.Locale.getLocale()` e o envia
ao agente no handshake `hello` (`locale`). Faltava um dicionário `en`/`pt-br` com um helper
`t(key)` em cada camada, com `en` como default.

### Prompts em português chegando ao modelo

- `FORCE_ANSWER_MSG` (instrução de sistema injetada em rate-limit) — reescrita em inglês.
- Mensagem de contexto do roteamento (`Agora tocando: …`) — reescrita para `Now playing: …`.
- Dois fragmentos em português dentro de `SUGGESTIONS_PROMPT` — reescritos.
- `LANGUAGE_RULE` passou a ser dirigida pelo locale: o modelo responde em inglês (default) ou
  português do Brasil conforme o locale do Spotify.
