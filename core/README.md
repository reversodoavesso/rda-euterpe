# euterpe (daemon Rust)

Daemon **autocontido** do Euterpe: um único `euterpe.exe` que

1. assume a **porta 8337** e o bridge WS da extensão (contrato congelado C1–C5);
2. serve o **servidor MCP** (Streamable HTTP em `POST /mcp` **e** `euterpe mcp --stdio`);
3. roda o **loop LLM agentic** com os 4 wires de provider (openai-compat, anthropic, gemini, ollama);
4. executa as **tools de servidor** (`web_search` com fallback próprio, letras, charts, capa, enrich…).

Nada de Docker. O SearXNG vira **opcional** (`searxng/`, ver abaixo).

Referências: [`../PLAN-REFACTOR.md`](../PLAN-REFACTOR.md) (especificação), [`../PLAN.md`](../PLAN.md) (decisões), [`../CHANGES.md`](../CHANGES.md) (o que mudou e ajustes pendentes).

---

## 1. Toolchain (receita exata desta máquina)

O host é **`x86_64-pc-windows-gnu`** porque instalar o MSVC Build Tools exige admin (indisponível). Isso exige um GCC do MinGW-w64 no PATH:

```powershell
# 1) Toolchain de C (uma vez)
winget install --id BrechtSanders.WinLibs.POSIX.UCRT --scope user --accept-package-agreements --accept-source-agreements
# anote o diretório ...\mingw64\bin e coloque no PATH (ele traz libgcc/libgcc_eh)

# 2) Rust (uma vez)
rustup toolchain install 1.99.0-x86_64-pc-windows-gnu --profile minimal -c rustfmt -c clippy
rustup default stable-x86_64-pc-windows-gnu
```

`core/.cargo/config.toml` já fixa o alvo, o linker (`x86_64-w64-mingw32-gcc`) e o `ar` (`gcc-ar`).
`core/rust-toolchain.toml` fixa o canal (**1.99.0**).

> ⚠️ **Antivírus:** o perfil de release **não** usa `strip = true` de propósito. O binário
> *stripped* de ~5 MB foi classificado pelo Windows Defender como
> `Trojan:Win32/Bearfoos.A!ml` (falso-positivo de ML em binário não assinado) e teve a execução
> **bloqueada**, inclusive na cópia em `%APPDATA%` e no atalho de Startup. Com `strip = false`
> + `lto = "thin"` (13,5 MB, com símbolos) a execução funciona. Se acontecer de novo:
> `Add-MpPreference -ExclusionPath "$env:APPDATA\euterpe"` (precisa de admin) ou
> "Permitir no dispositivo" no Windows Security. Ver P17 em `../CHANGES.md`.

> ⚠️ `LLVM-MinGW` **não serve** para linkar o std do Rust: ele não traz `libgcc.a`.
> Foi a primeira tentativa, e ela falha com `lld: error: unable to find library -lgcc`
> — daí o WinLibs (GCC de verdade) acima. O `LLVM-MinGW` continua útil para o
> `clang`, mas não é o linker do projeto.

### Comandos

```powershell
cd core
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                    # 258 testes (124 unit + 134 de integração)
cargo build --release         # target/x86_64-pc-windows-gnu/release/euterpe.exe (~13,5 MB, com símbolos)
```

Smoke tests (o daemon precisa estar de pé para o segundo):

```powershell
powershell -ExecutionPolicy Bypass -File tools\smoke-daemon.ps1   # daemon isolado, 24 checagens
node tools\smoke-bridge.mjs                                       # bridge WS real na 8337, 14 checagens
```

## 2. Uso

```powershell
euterpe serve                 # sobe o daemon (127.0.0.1:8337)
euterpe --ensure              # idempotente: sobe se não houver, exit 0 se já houver
euterpe mcp --stdio           # servidor MCP por stdio (stdout = só protocolo)
euterpe install-startup       # atalho na pasta Startup do usuário
euterpe install-startup --remove
euterpe version
```

### Variáveis de ambiente

| Variável | Default | Para quê |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8337` | endereço do bridge |
| `EUTERPE_DATA_DIR` | `%APPDATA%\euterpe` | diretório de dados (banco, sessões, probes, segredos) |
| `EUTERPE_PORTABLE=1` | — | dados ao lado do executável |
| `CHAT_UPSTREAM` | vazio | `ws://127.0.0.1:8338/ws` ⇒ o chat é espelhado para o agente Node (**Fase 2 / D6**) |
| `EUTERPE_MUTATION_POLICY` | `allow` | `allow` \| `confirm` \| `deny` (gate de mutação do MCP) |
| `EUTERPE_WEB_SEARCH` | `auto` | `auto` \| `searxng` \| `brave` \| `tavily` \| `duckduckgo` \| `off` |
| `MAX_TOOL_STEPS` | `12` | passos do loop agentic |
| `EUTERPE_SUGGESTIONS` | `true` | pills de sugestão |
| `SEARXNG_URL` | `http://127.0.0.1:8888` | só é usado no backend `searxng`/`auto` |
| `CHAT_HISTORY` | `0` | turnos de histórico por sessão |
| `EUTERPE_DEBUG` | `false` | prompts em modo debug + detalhes técnicos |
| `WS_SECRET` | arquivo `data/ws-secret` | força o segredo do handshake |
| `DEEPSEEK_API_KEY` (ou `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …) | — | back-compat: vira chave do provider |

## 3. Layout

```
src/
  main.rs  cli.rs  paths.rs  config.rs  secrets.rs  logging.rs  i18n.rs  startup.rs  upstream.rs
  protocol/   protocolo WS (C1/C2/C4) — espelho de agent/src/protocol.ts
  bridge/     registry de clientes, pending map, mutation_lock, gates de confirmação
  ws/         handshake + fila serial por conexão
  store/      SQLite (C10): history, snapshots, cache, settings
  tools/      catalog.rs (catálogo único, D5) + server/ (tools de servidor)
  llm/        canonical, sse, prompts, loop, suggestions, adapters/{4 wires}
  mcp/        jsonrpc, server, catalog, gate, http, stdio
  http/       health, bridge_config, probe, sessions, chat_sse, providers, settings
  assets/     tools.json e prompts.json (GERADOS — não editar à mão)
tests/        parity_*, bridge_concurrency, replay_sessions, mcp_*, llm_loop_degrade, cover, fixtures/
```

### Assets gerados

`src/assets/tools.json` e `src/assets/prompts.json` são **gerados** da fonte de verdade
Node (`agent/src/tools/defs.ts` e `agent/src/agent.ts`) por
`agent/tools/export-goldens.mjs`. Os testes `parity_tools.rs`/`parity_prompts.rs`
comparan o runtime com `tests/fixtures/*` — se alguém editar o asset à mão, os
testes falham. Para regenerar:

```bash
cd agent && npm run goldens      # tsc + export-goldens.mjs
```

## 4. Desvios conscientes do plano

| Item do plano | O que foi feito | Por quê |
|---|---|---|
| `rustls-tls` no `reqwest` | **`native-tls`** (SChannel) | `rustls` 0.23 traz `aws-lc-rs` por padrão, que exige **cmake + nasm** para compilar; o contrato HTTP não muda com o backend de TLS |
| `keyring` do Windows para as chaves | **arquivo** `data/secrets.json` com ACL restrita (`icacls`), fallback por env | evita a árvore `windows-sys` no build; `GET` nunca devolve a chave (`hasKey` apenas). *Ponto de ajuste registrado em `../CHANGES.md`* |
| catálogo/prompts escritos à mão em Rust | **gerados** como asset JSON a partir do Node | garante paridade por construção (D5) e mantém os goldens como gate; o imutável é a *lógica* (loop, gates, parsers), que é Rust e testada |
| `core/src/http/mcp.rs` | **`core/src/mcp/http.rs`** | o servidor MCP ficou autocontido (transporte + protocolo juntos) |
| `agent/` → `legacy/agent-node/` | **mantido** em `agent/` | o flip da Fase 2 (D6) precisa do Node vivo como upstream do chat; mover quebraria o gerador de goldens e o espelho |
| `better-sqlite3` → `rusqlite` com o **mesmo arquivo** | feito (C10) | `tests/parity_store.rs` abre o banco escrito pelo Node |

## 5. Registrar no MCP

```
opencode:     opencode mcp add euterpe --url http://127.0.0.1:8337/mcp
claude-code:  claude mcp add --transport http euterpe http://127.0.0.1:8337/mcp
json (stdio): {"mcpServers":{"euterpe":{"command":"C:\\Users\\<user>\\AppData\\Roaming\\euterpe\\euterpe.exe","args":["mcp","--stdio"]}}}
```

Smoke rápido:

```bash
curl -sX POST http://127.0.0.1:8337/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
curl -sX POST http://127.0.0.1:8337/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## 6. SearXNG é opcional

Sem `docker compose`, `web_search` cai sozinho na cadeia
`SearXNG (se configurado) → Brave (chave) → Tavily (chave) → DuckDuckGo HTML`.
Se quiser o SearXNG local:

```bash
cd searxng && docker compose up -d      # http://127.0.0.1:8888
```
