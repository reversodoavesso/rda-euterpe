# Euterpe — bancada headless

Investigação iniciada em 23/10/2026. Objetivo: substituir a execução de ferramentas
na extensão Spicetify por um backend sem interface gráfica, preservando os contratos
do agente e do MCP.

**Já foi demonstrado:** um daemon Linux inicia em Docker e emite um código de
pareamento real do Spotify; o NTify faz uma busca real no catálogo e a biblioteca
Python lê uma playlist pública pelo Pathfinder, ambos sem login de usuário.
**A sessão do desktop também já foi migrada:** o headless leu as 53 playlists da
conta em três páginas, leu as 31 faixas de uma playlist e reconectou após reinício
usando credencial própria, sem o token temporário na configuração. O NTify leu a
rootlist da conta e uma página de curtidas. Veja [AUTH-MIGRATION.md](AUTH-MIGRATION.md).
**O MCP também já funciona sem extensão:** daemon Rust e serviço Go em containers,
com criação, edição, substituição, remoção e undo verificados na conta real usando
somente playlists descartáveis. Há 12 das 29 ferramentas de cliente implementadas,
incluindo busca, curtidas, metadados em lote e resolução de nomes. O pareamento
de novas instâncias já tem API web; emissão/cancelamento de código real passaram.
Veja [MIGRATION.md](MIGRATION.md) para executar essa integração e consultar os limites.

## Candidatos baixados

Os checkouts completos, com histórico Git superficial, estão em `repos/` e são
ignorados pelo Git do Euterpe. [sources.lock.json](sources.lock.json) registra o
commit exato de cada candidato; [candidates.json](candidates.json) registra a origem.

| Candidato | Papel na investigação | Resultado inicial |
|---|---|---|
| [NTify-SpotAPI](https://github.com/NTifyApp/NTify-SpotAPI) | Curadoria pelas APIs internas, protobuf e Pathfinder | Busca pública, rootlist da conta e curtidas passaram; 9 cenários offline passaram; 2 limitações reproduzidas |
| [librespot](https://github.com/librespot-org/librespot) | Sessão, autenticação e transporte nativo Rust | 24 testes de core/OAuth passaram |
| [go-librespot](https://github.com/devgianlu/go-librespot) | Daemon headless, pareamento e API HTTP | 332 casos offline passaram; sessão migrada, reconexão, biblioteca e faixas validadas com a conta |
| [spotify-player](https://github.com/aome510/spotify-player) | Referência de CLI, playlists e fallback de API | 45 testes passaram, sem streaming ou áudio |
| [SpotAPI Python](https://github.com/Aran404/SpotAPI) | Metadados e acesso alternativo ao Pathfinder | Leitura pública real passou; 40 testes offline passaram e 4 falharam |

Os números de Go contam **casos folha**, excluindo os eventos de sucesso duplicados
dos suites/pais. São testes de partes diferentes; não representam número de
funcionalidades do Euterpe comprovadas. O resumo gerado está em
[results/summary.json](results/summary.json). A cobertura das 29 ferramentas está em
[CAPABILITIES.md](CAPABILITIES.md).

## O que os testes realmente verificaram

### NTify

Build com Java 21 e Maven 3.9.11 local, sem executar a suíte de integração do
upstream. Essa suíte usa conta real e cria/altera playlists.

[harness/NtifyOfflineSmoke.java](harness/NtifyOfflineSmoke.java) usa um interceptor
OkHttp que responde a **todas** as requisições, sem chamar a rede. Verifica leitura e
paginação da rootlist, protobuf de criação, adição/remoção/reordenação, uso e cache da
revisão, nome/descrição, formato de busca Pathfinder, renovação após 401, limite de
retry e ausência de repetição de mutação após 504.

Também executamos [harness/NtifyPublicRead.java](harness/NtifyPublicRead.java) contra
o Spotify real: `searchDesktop` no Pathfinder v2 retornou uma faixa para uma busca
de catálogo. Foram usados tokens anônimos obtidos pelo SpotAPI Python, enviados ao
processo Java somente por stdin e mantidos em memória. Nenhuma conta foi conectada
nesse primeiro teste público.
Esse teste comprova a busca e a desserialização do retorno atual; não comprova
autenticação de usuário nem autorização para escrever na biblioteca.

Limitações reproduzidas no commit baixado:

- `ModifyPlaylist.validate()` rejeita uma alteração somente de capa, mesmo após
  `setImageBytes(...)`.
- O mesmo ocorre com uma alteração somente de visibilidade, após `setPublic(...)`.
- O índice padrão de inserção é zero; um adaptador que deseje acrescentar ao final
  precisa determinar e informar a posição.
- Criação da playlist e inclusão dela na rootlist são operações distintas.
- Recomendações usam contexto de playlist/Smart Shuffle; não equivalem automaticamente
  à nossa ferramenta baseada em seeds de faixas, artistas e gêneros.
- A biblioteca recebe access token e client token; não implementa o login. O exemplo
  de autenticação do upstream imprime tokens, por isso não foi executado.
- Nenhum arquivo de licença foi localizado na raiz deste checkout. Isso precisa ser
  esclarecido antes de incorporar código ou redistribuir a biblioteca.

O build do upstream regenera fontes protobuf dentro do próprio checkout. Alterações
nesses arquivos gerados são consequência do build; o commit de referência permanece
registrado no lock. Não foi aplicado conserto ao código do candidato nesta rodada.

### go-librespot

Foi construído o Dockerfile original. O processo iniciou com backend de áudio `pipe`,
sem GPU, monitor, Spotify desktop ou sessão gráfica. A API retornou:

- `GET /auth/code`: HTTP 200, com os campos de pareamento `code`, `url` e `expires_at`.
- `GET /status`: HTTP 204 antes do login.
- `GET /library/playlists`: HTTP 204 antes do login.

Esse primeiro teste comprova inicialização e início do fluxo de autenticação. O
container temporário de prova foi parado/removido ao terminar. A rodada posterior
com a conta está em [AUTH-MIGRATION.md](AUTH-MIGRATION.md) e usa outro container.

Os testes upstream selecionados cobrem serviços internos de playlists e coleção,
paginação, revisão, conflito, remoção por posição, retry/autenticação e a API do
daemon. Os cenários sem conta usam servidores locais de teste.

Os endpoints atuais oferecem leitura da biblioteca e adição/remoção de faixas, mas
não encontramos uma API HTTP pronta para criar playlists, editar capa ou substituir
todo o conteúdo. Também há limite configurado de 800 itens na enumeração de contextos;
ele não pode ser herdado silenciosamente por uma migração de bibliotecas grandes.

### librespot e spotify-player

Foram testados sem as features de áudio. Não houve transmissão de música, criação de
dispositivo nem login nesses processos. O `librespot-core` oferece transporte
interno, client token, playlist/rootlist e Login5: é o candidato para integrar a sessão
diretamente no Rust do Euterpe. Os 24 testes aprovados não validam esse login na conta.

O spotify-player usa Web API/rspotify para parte importante da curadoria e um fallback
compartilhado do ncspot; seu título de "full feature parity" não comprova a cobertura
das ferramentas internas do Euterpe. O modo daemon não foi exercitado nesta rodada.

### SpotAPI Python

A importação e a leitura real de uma faixa de playlist pública funcionaram. O teste
exigiu dados válidos em `playlistV2.content.items` e ausência de erros GraphQL; HTTP
200 sozinho não é considerado sucesso. Na execução registrada, a descoberta inicial
dos hashes consultou cerca de 80 URLs, principalmente bundles públicos JavaScript.

Os testes de refresh, armazenamento e anotações foram copiados sem alterações para
`runs/` para contornar o `__init__.py` quebrado do pacote de testes upstream. Resultado:
40 aprovados, 4 falhas de validação de tipos de coleções. Os testes de feature que
fazem login/mutações não foram importados nem executados.

A classe `PrivatePlaylist` deste commit não expõe adição/remoção/reordenação de
faixas nem alteração de capa. Portanto, o sucesso de leitura pública não a torna
substituta completa da extensão.

## Reproduzir

Execute a partir da raiz do Euterpe. Ferramentas usadas nesta máquina: Python 3.12
isolado via uv, Java 21, Rust 1.99 GNU, Go com toolchain 1.25.5 e Docker Linux. Maven é
baixado para a bancada com verificação SHA-512. Não foram instalados pacotes Python
globalmente nem modificados arquivos do daemon/mod.

```powershell
# Baixar os mesmos repositórios e revisar as revisões fixadas.
python headless-lab/scripts/sources.py fetch

# Build e testes offline de todos os candidatos.
python headless-lab/scripts/checks.py

# Testes específicos.
python headless-lab/scripts/checks.py --only ntify
python headless-lab/scripts/checks.py --only go --containers
python headless-lab/scripts/checks.py --only spotapi --public

# Após construir NTify e preparar o venv: busca pública real pelo Java.
headless-lab/envs/spotapi/Scripts/python.exe headless-lab/scripts/probe_ntify_public.py

# Regenerar apenas o resumo das evidências já existentes.
python headless-lab/scripts/summarize.py
```

No commit atual, o comando completo termina com código 1 por causa das quatro falhas
upstream do SpotAPI. Isso é registrado como falha, sem mascará-la com skips.
`--public` acessa o Spotify sem conta; os demais testes de protocolo são offline
após baixar as dependências.

## Alternativa: pareamento de uma nova conta, somente leitura

O ambiente original de pareamento está preparado e desligado. Ele usa a mesma porta
do container migrado: pare `euterpe-headless-lab-desktop-session` antes de iniciar
essa alternativa.

```powershell
docker compose -f headless-lab/compose.yml up -d
Invoke-RestMethod http://127.0.0.1:18378/auth/code
```

Abra a URL retornada e faça o login diretamente no Spotify, usando o código retornado
se necessário. Não envie senha, cookies ou tokens pelo chat. O estado fica em
`headless-lab/private/go-librespot/`, ignorado pelo Git. A API é publicada somente em
`127.0.0.1` nesta bancada.

```powershell
# Após o pareamento: lê uma página da biblioteca e registra só contagens/esquema.
python headless-lab/scripts/read_go_library.py
python headless-lab/scripts/summarize.py

# Encerrar quando terminar.
docker compose -f headless-lab/compose.yml down
```

Esses scripts de leitura não modificam playlists nem iniciam reprodução. A escrita
integrada já foi verificada com snapshots, confirmação, duplicatas e ordem na bancada
de [MIGRATION.md](MIGRATION.md). Capa continua pendente.

## Direção sugerida pelos resultados

O go-librespot é a base mais concreta para testar o serviço headless com pareamento e
API web agora. O librespot-core é a opção de sessão nativa para o backend Rust. O
NTify é o candidato com operações de curadoria interna mais amplas nesta rodada.
A leitura autenticada do NTify funcionou com o token temporário do desktop. A sessão
persistente do serviço Go já funciona sem esse token; as limitações do NTify continuam
registradas como referência para operações ainda não migradas.

O caminho integrado atual usa um serviço próprio sobre go-librespot. As ferramentas
MCP mantêm os nomes originais; as operações não implementadas falham explicitamente.
Capa, recomendações e player ainda precisam de migração. A interface web, seu gateway
e a conclusão do login de uma nova conta são os próximos componentes a validar.
