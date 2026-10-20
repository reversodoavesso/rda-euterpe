# Euterpe

Centro agentic pessoal dentro do Spotify desktop (spicetify): chat com um agente que lê suas
playlists/músicas, cruza com websearch, letras e metadados, cria playlists curadas — com capa.
E, desde a refatoração, **também expõe tudo isso como servidor MCP** para uso por qualquer
agente externo (opencode, Claude Code, …).

Desde `v0.2.0` o backend é **um único `euterpe` (`euterpe.exe` no Windows)** (Rust), sem Docker e sem Node no caminho
crítico. O agente Node continua no repositório como **oráculo de teste** e como backend opcional
do chat (o espelho da Fase 2 / D6).

- Especificação da refatoração: [`PLAN-REFACTOR.md`](./PLAN-REFACTOR.md)
- Decisões e roadmap: [`PLAN.md`](./PLAN.md)
- O que mudou (e o que ficou pendente): [`CHANGES.md`](./CHANGES.md)
- Contratos das APIs internas do Spotify: [`PLAN-INTERNAL-API.md`](./PLAN-INTERNAL-API.md)
- Plano de resiliência e governança MCP: [`PLAN-IMPROVEMENTS.md`](./PLAN-IMPROVEMENTS.md)
- Plano de Diff Engine e Versionamento Incremental: [`PLAN-DIFF-ENGINE.md`](./PLAN-DIFF-ENGINE.md)
- Tom de voz da marca (copy, status, erros): [`BRAND-VOICE.md`](./BRAND-VOICE.md)

## Estrutura

```
core/      daemon Rust: bridge WS (8337) + servidor MCP + loop LLM + tools de servidor
app/       Custom App + Extension do spicetify (interface dentro do Spotify)
agent/     agente Node/TS — oráculo de teste e upstream opcional do chat (CHAT_UPSTREAM)
tools/     instaladores auxiliares e verificações de integração
searxng/   docker-compose opcional do metabuscador (o web_search funciona sem ele)
```

## Setup rápido

```powershell
# 1) daemon (uma vez: instale o toolchain — ver core/README.md §1)
cd core && cargo build --release
cd ..

# 2) mod no Spotify
node app/install.mjs      # instala, registra autostart e inicia o daemon agora
```

Abra **Euterpe** na sidebar do Spotify. O painel de setup cadastra o provider/modelo e mostra as
instruções para plugar o MCP no seu agente externo.

Windows, Linux e macOS usam o mesmo instalador e um binário Rust nativo do host.
O daemon inicia no logon do usuário; a extensão conecta ao abrir o Spotify, sem
depender de Node no renderer. No Windows é criado um atalho oculto; no Linux,
um serviço systemd de usuário (ou XDG Autostart); no macOS, um LaunchAgent.
Use `node app/install.mjs --no-startup` para instalar e iniciar apenas agora.
Veja [instalação e operação multiplataforma](docs/platforms.md), incluindo requisitos de build e desinstalação.

### Pré-requisitos

- **spicetify** instalado e aplicado (uma vez) — ver `app/README.md`.
- **Nada de Docker.** SearXNG é opcional: se você não subir, o `web_search` usa DuckDuckGo
  automaticamente (ou Brave/Tavily, se você cadastrar as chaves no painel).
