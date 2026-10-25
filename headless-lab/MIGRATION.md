# Headless — MCP, catálogo e pareamento

O daemon Rust já executa ferramentas Spotify sem uma extensão conectada. O caminho
validado é **cliente MCP → daemon Rust → serviço Go → Spotify**. Ambos os serviços
rodam em containers Linux; o desktop não participa das chamadas nem da renovação de
tokens. A sessão usa as credenciais persistentes migradas na rodada anterior.

## O que passou na conta real

Evidência sanitizada: [results/headless-mcp.json](results/headless-mcp.json).

- Leitura de playlists e metadados de 50 faixas, com zero clientes desktop conectados.
- Criação e remoção da biblioteca de uma playlist descartável.
- Adição ao final, deduplicação da entrada e preservação das duplicatas já existentes.
- Substituição em uma única mudança de revisão, preservando ordem e duplicatas.
- Remoção de todas as ocorrências das URIs solicitadas e substituição por lista vazia.
- Alteração de nome/descrição, incluindo limpar somente a descrição.
- `spotify_undo_last_mutation` usando o snapshot do daemon e o mesmo backend.
- Busca nas quatro categorias, curtidas com datas/offset, metadados em lote e
  resolução de nomes para URIs. A criação de playlist também aceita nomes de faixas.
- Confirmação e rejeição por HTTP. O teste aprova somente propostas que correspondem
  exatamente às chamadas feitas sobre sua playlist descartável.

A biblioteca tinha 53 playlists antes e voltou a 53 após a limpeza. Duas playlists
de tentativas anteriores também foram removidas da biblioteca. Essas tentativas
identificaram que `changes_require_resync=true` pode acompanhar uma escrita já
aplicada: o adaptador não transforma esse aviso em falha e sempre lê novamente a
revisão antes da próxima operação. Não houve controle de reprodução.

## Executar a bancada

Pré-requisitos: Docker Linux, os repositórios nos commits de `sources.lock.json` e o
estado privado já migrado em `private/desktop-migration/go-librespot/state.json`.
Não execute o player headless antigo ao mesmo tempo com o mesmo estado de dispositivo.

Na raiz do projeto:

```powershell
python headless-lab/scripts/sources.py fetch
docker build --target build -t euterpe-headless-lab-go-build:bd3fa74 headless-lab/repos/go-librespot
docker compose -f headless-lab/compose.headless.yml up -d --build

# Leitura apenas; não aprova nem altera playlists.
python headless-lab/scripts/probe_headless_mcp.py
python headless-lab/scripts/probe_headless_catalog.py

# Cria, verifica e remove somente sua própria playlist descartável.
python headless-lab/scripts/probe_headless_mcp.py --mutations
# Inclui resolver uma faixa pelo nome durante a criação:
python headless-lab/scripts/probe_headless_mcp.py --mutations --resolve-create

docker compose -f headless-lab/compose.headless.yml down
```

MCP: `http://127.0.0.1:18337/mcp`. O serviço Go fica acessível apenas na rede
interna do Compose. O daemon aceita `Authorization: Bearer <segredo do daemon>`;
o segredo fica em `private/headless-mcp/ws-secret`, não no Git. O script o lê sem
imprimi-lo. `/health` é a única rota pública e informa `spotify_backend: headless`.
O shim `euterpe mcp --stdio` também encaminha esse segredo quando usa um daemon.

`EUTERPE_HEADLESS_URL` seleciona explicitamente o backend. Sem essa variável, o
caminho desktop continua sendo o padrão. Com ela, não há fallback para uma extensão
conectada, evitando misturar contas e semânticas. Os nomes/esquemas MCP existentes
permanecem iguais; ferramentas ainda sem implementação retornam
`unsupported_in_headless`.

## Contrato para a interface web

- `POST /chat`: SSE existente do agente, usando o bearer do daemon.
- `GET /proposals`: propostas pendentes, com `proposalId`, `name`, `args` e `title`.
- `POST /proposals/{proposalId}`: `{"decision":"approve"}` ou `{"decision":"reject"}`.
- `GET /settings`, `/providers` e rotas de sessões continuam disponíveis com bearer.

A política do Compose é `confirm`: o MCP aguarda a decisão por até 120 segundos.
Expiração, rejeição ou cancelamento da chamada não aprovam alterações. A fila é
removida ao concluir ou cancelar a espera. Snapshots inválidos, incompletos ou que
não puderam ser gravados bloqueiam a escrita headless. Uma resposta perdida retorna
`headless_outcome_unknown`; faça leitura de verificação antes de decidir repetir.

A UI web deverá usar um backend/proxy na mesma origem, mantendo o bearer fora do
JavaScript público. No modo headless o daemon não libera CORS para outras origens.
Esta bancada continua com uma conta por instância e portas publicadas só no loopback.

## Catálogo e biblioteca

As quatro ferramentas adicionadas nesta etapa preservam os nomes e formatos do MCP:

| Ferramenta | Comportamento validado |
|---|---|
| `search_spotify` | Pathfinder autenticado; faixas, artistas, álbuns e playlists; até 50 por categoria |
| `get_saved_tracks` | Lê todas as páginas da coleção, filtra curtidas, ordena por inclusão e aplica `limit`/`offset`; mantém `added_at` |
| `get_several_tracks` | Até 50 IDs/URIs, com ordem, duplicatas e posição das entradas indisponíveis preservadas |
| `resolve_tracks` | Até 100 entradas, com seis buscas simultâneas no máximo; mantém a ordem dos resultados e deduplica `uris` |

Resultados reais: [headless-catalog.json](results/headless-catalog.json). A busca
usa o hash já verificado na bancada, com tokens da própria sessão mantidos em memória.
O teste identificou uma recusa HTTP 403 com o user-agent genérico; o transporte
Pathfinder usa um user-agent de navegador. Não foi necessária nova captura do desktop.
Uma mudança incompatível no hash retorna `search_query_outdated`.

Curtidas sem data recebem `added_at: null`. Paginação em loop ou estados contraditórios
da mesma URI falham explicitamente. Na criação por nome, uma faixa sem correspondência
interrompe a operação antes de criar a playlist.

## Nova conta sem captura do desktop

O daemon expõe, com o mesmo bearer local:

- `GET /spotify/auth`: estado da conexão e, enquanto pendente, URL, código e validade.
- `POST /spotify/auth/start`: inicia um pareamento por código em uma instância vazia.
- `DELETE /spotify/auth`: cancela o pareamento pendente; não desconecta uma conta ativa.

Os estados são `idle`, `pending`, `authenticating`, `authenticated`, `error` e `disabled`.
Repetir `start` enquanto há uma tentativa pendente devolve a mesma tentativa.
Uma conta já conectada retorna HTTP 409 para início/cancelamento: não é substituída.
Credenciais e access tokens nunca fazem parte dessa resposta.

O Compose de pareamento usa diretórios e porta diferentes dos da conta migrada:

```powershell
docker compose -f headless-lab/compose.pairing.yml up -d --wait
# Prova emissão/cancelamento de código real, sem autorizar uma conta:
python headless-lab/scripts/probe_headless_pairing.py
docker compose -f headless-lab/compose.pairing.yml down
```

Para conectar uma conta nessa instância, um backend da futura UI deve ler o segredo
de `private/web-pairing-mcp/ws-secret`, chamar `POST` e consultar `GET` em
`http://127.0.0.1:18338/spotify/auth`. O usuário abre `verification_url` no Spotify e
aprova o acesso. O serviço persiste a sessão em `private/web-pairing/state.json`
com permissão 0600, sem sobrescrever um arquivo de conta existente. Depois disso,
reinicia usando essa sessão. O fluxo só fica habilitado com
`SPOTIFY_PAIRING_ENABLED=true`; a instância migrada continua com seu estado somente leitura.

O [teste real de pareamento](results/headless-pairing.json) passou pela emissão,
validade, repetição e cancelamento do código. **A aprovação de uma nova conta pelo
usuário ainda não foi concluída ponta a ponta.** Persistência após aprovação e
cancelamento com conclusão tardia são cobertos por testes locais com sessão simulada.

## Limites e próxima etapa

Há **12 das 29 ferramentas de cliente** implementadas no serviço Go, além do undo
composto já verificado. Capa, recomendações, dados de artista,
histórico, player e as demais ferramentas ainda exigem implementação e comparação.
As escritas de faixas aceitam URIs `spotify:track:`. A criação também resolve nomes;
episódios e faixas locais ainda não foram migrados. Um undo com esses outros tipos
falha explicitamente antes da escrita.
O catálogo permanece completo por compatibilidade; isso não é promessa de paridade.
Playlists muito grandes podem atingir o timeout: a leitura falha explicitamente e
não fornece um snapshot truncado. Entradas indisponíveis mantêm posição e URI;
o campo `metadata_unavailable` distingue metadados ausentes.

A API de pareamento está implementada por instância. A interface personalizada,
o gateway de usuários e o gerenciamento de várias contas ainda ficam para a próxima
etapa. O agente continua usando as rotas de providers/settings existentes para a
configuração do modelo; esta etapa não migrou chaves de modelos do desktop.

O serviço Go compila contra go-librespot, cuja licença é GPLv3; a imagem inclui a
licença upstream. Seu código-fonte fica em `sidecar/`, separado do daemon Rust.
Não incorporamos o NTify ao produto: ele continua como referência/teste no laboratório.

Testes: `core/tests/headless_backend.rs`, `core/tests/headless_auth.rs`,
`sidecar/main_test.go`, `sidecar/catalog_test.go` e `sidecar/auth_test.go`. A construção
da imagem Go executa os testes com detector de corridas antes de produzir o binário.
O relatório [results/headless-validation.json](results/headless-validation.json)
registra os testes Rust/Go aprovados, fmt/clippy, o proxy stdio autenticado e
a recusa de chamadas MCP sem bearer.
