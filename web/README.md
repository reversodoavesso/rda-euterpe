# Euterpe Web

Aplicação web para conversar com o agente e gerenciar playlists com Spotify headless.
A interface em português tem três áreas: conversas, área de trabalho e seleção em revisão.

## Executar

É necessário Docker com containers Linux, acesso à internet durante o build e uma conta Spotify.
Na raiz do projeto:

```powershell
docker compose -f headless-lab/compose.web.yml up -d --build
```

Abra **http://127.0.0.1:18339**. O build é independente das imagens locais do laboratório:
baixa o [go-librespot](https://github.com/devgianlu/go-librespot/tree/bd3fa7407eb1ab595295446e1be50cb9663e69cb)
na revisão `bd3fa7407eb1ab595295446e1be50cb9663e69cb`, aplica o serviço em
`headless-lab/sidecar/` e compila o daemon em `core/`. O runtime usa Python 3 e biblioteca
padrão; os pacotes npm são ferramentas de desenvolvimento e testes.

1. Crie uma conta Euterpe com usuário e senha de pelo menos 12 caracteres.
2. Clique em **Conectar Spotify → Gerar código**. O código aparece assim que o Spotify
   o disponibilizar; a janela acompanha o andamento automaticamente.
3. Abra o endereço de autorização do Spotify e autorize a conta desejada. A senha Spotify
   é informada na página do Spotify. É possível cancelar o código antes da autorização.
4. Em **Ajustes**, escolha provedor e modelo, informe a chave quando necessária e salve.
   Há teste de conexão e listagem de modelos. O teste pode consumir uma pequena requisição
   do provedor. Servidores locais precisam ser acessíveis de dentro do container.

Cada cadastro começa com uma conexão Spotify vazia. Uma conta já conectada permanece
associada àquele usuário; outro cadastro permite usar outra conta Spotify.

### Acesso local já provisionado

A migração autorizada nesta máquina importou a sessão existente para o usuário `local`.
Sua senha gerada está em **`headless-lab/private/web/bootstrap-credentials.json`**,
ignorado pelo Git. Para emitir um link local de acesso válido por dez minutos e um único uso:

```powershell
python web/bootstrap_local.py
```

Esse comando reutiliza o usuário e a sessão já existentes. A senha e as credenciais Spotify
seguem pelo stdin do comando de provisionamento e ficam no diretório privado. O link de
acesso é consumido pelo servidor e redireciona para `/`, com cookie de sessão HttpOnly.
Em uma instalação nova, use o cadastro e o pareamento da interface.

## O que está implementado

| Área | Funcionalidades |
| --- | --- |
| Conversas | Criar, abrir, renomear e excluir; mensagens persistidas por usuário |
| Agente | Streaming SSE, status das ferramentas, propostas no chat e botão para parar no servidor |
| Biblioteca | Todas as páginas de playlists, filtro, faixas de cada playlist e curtidas paginadas |
| Explorar | Busca de músicas, artistas, álbuns e playlists; metadados das músicas; links para Spotify |
| Seleção | Criar rascunho, adicionar/remover músicas, arrastar ou usar botões para reordenar e eliminar repetidas |
| Revisão | Comparação de quantidades, adições/remoções e lista na ordem final; aprovar, recusar ou editar |
| Playlists | Criar, atualizar faixas e ordem, alterar nome/descrição, remover da biblioteca e desfazer a última edição |
| Atividade | Decisões e resultados separados; inclui mutações executadas pelo agente |
| Ajustes | Provedor, modelo, chave, endereço, preferências musicais, contexto e limite de etapas |
| Contas | Cadastro/login/logout, sessões e CSRF, isolamento de arquivos e processos por UID |

As 12 ferramentas Spotify disponíveis são `get_playlists`, `get_playlist_tracks`,
`get_saved_tracks`, `get_several_tracks`, `search_spotify`, `resolve_tracks`,
`create_playlist`, `delete_playlist`, `add_tracks`, `remove_tracks`,
`replace_playlist_tracks` e `set_playlist_details`. O daemon acrescenta o desfazer com
snapshots. O agente continua usando o mesmo loop e o servidor MCP do projeto.

A criação e a substituição de faixas preservam a ordem e as repetições da seleção
aprovada. O botão **Remover repetidas** elimina as repetições por escolha do usuário.

Uma revisão que altere músicas e também nome/descrição é aplicada em duas etapas,
cada uma com aprovação e snapshot próprios. A aprovação autoriza a operação; o estado
**Concluído** só é registrado após a resposta da ferramenta. Operações diretas pendentes
são retomadas no acompanhamento da interface após atualizar a página.

## Arquitetura e persistência

```text
Navegador — cookie de sessão + CSRF
   │ mesma origem, /api/*
   ▼
Gateway Python :8080 — contas, mensagens, atividade, operações pendentes
   │
   ├─ Usuário A, UID próprio: daemon Rust ↔ serviço Spotify Go
   └─ Usuário B, UID próprio: daemon Rust ↔ serviço Spotify Go
```

Apenas o gateway publica uma porta. Cada worker escuta no loopback do container, recebe
segredos de serviço próprios e usa diretórios privados. O serviço Go exige seu bearer
inclusive nas rotas de autenticação; o daemon exige outro bearer. O gateway entrega ao
navegador somente os dados de interface. As chaves de provedor e credenciais Spotify
permanecem no servidor. O processo supervisor tem acesso administrativo ao volume.

O volume **`headless-lab/private/web/`** contém:

- `accounts.sqlite`: usuários, hashes scrypt de senha, hashes de sessão e links de acesso,
  conversas, mensagens, operações e atividade;
- `users/<uuid>/daemon/`: configuração, chaves de IA, histórico do agente e snapshots;
- `users/<uuid>/spotify/state.json`: sessão Spotify daquela conta;
- logs locais dos processos, com permissões privadas.

Os diretórios de usuários usam `0700` e os arquivos de credenciais `0600`; os trabalhadores
executam com UIDs diferentes e grupos suplementares vazios. A base de contas e a senha
de bootstrap são inacessíveis aos workers. O container mantém a raiz somente leitura,
`no-new-privileges` e as capacidades necessárias para criar processos com UIDs próprios.
Workers ociosos são encerrados após vinte minutos; suas sessões persistidas são reutilizadas.
O limite padrão é de 16 usuários ativos por instância.

Para parar e iniciar preservando os dados:

```powershell
docker compose -f headless-lab/compose.web.yml stop
docker compose -f headless-lab/compose.web.yml up -d
```

## Hospedar em outro servidor

Use o mesmo compose no servidor Linux e configure um proxy HTTPS para
`127.0.0.1:18339`. Preserve o streaming de `/api/chat`, desative o buffering dessa rota
e permita conexões de longa duração. Configure o domínio e os cookies antes de iniciar:

```powershell
$env:WEB_PUBLIC_ORIGIN = 'https://musica.seu-dominio.example'
$env:WEB_COOKIE_SECURE = '1'
$env:WEB_REGISTRATION = 'closed' # depois de cadastrar os usuários desejados
docker compose -f headless-lab/compose.web.yml up -d
```

No shell Linux, use `export WEB_PUBLIC_ORIGIN=...`, `export WEB_COOKIE_SECURE=1` e
`export WEB_REGISTRATION=closed`. Faça backup do volume privado completo com o serviço
parado e restrinja o acesso a esse backup: ele inclui sessões e chaves. Para migrar a
instalação, restaure esse volume e suas permissões no mesmo caminho do compose.

## Limites atuais

- Player, capas personalizadas, recomendações nativas, top tracks e demais ferramentas
  Spotify ainda não implementadas retornam indisponibilidade explícita no headless.
- O editor da seleção mantém o rascunho na memória da aba. As mensagens, preferências,
  operações enviadas e sessões Spotify persistem no servidor.
- O desfazer restaura o último snapshot de uma playlist existente. A criação e a remoção
  da biblioteca têm semânticas próprias; remover da biblioteca deixa de seguir a playlist.
- Parar o chat cancela chamadas em espera e retira propostas ainda pendentes. Uma escrita
  já aprovada pode ter chegado ao Spotify. Resultados incertos exigem conferir a playlist;
  escritas não são repetidas automaticamente.
- A janela de pareamento deve ser autorizada pelo dono da conta. Os testes geram e
  cancelam códigos; o login já migrado foi validado com a sessão real persistida.
- O transporte Spotify usa APIs internas e uma revisão fixa do go-librespot. Mudanças
  nessas APIs podem exigir atualização do serviço. A licença GPL-3.0 do upstream está
  incluída na imagem em `/usr/share/doc/euterpe-headless/LICENSE`; os fontes modificados
  estão em `headless-lab/sidecar/`, com a revisão original indicada acima.

## Validação

```powershell
python -m unittest discover -s web -p test_server.py -v
cd web
npm ci --ignore-scripts
npm test
cd ../core
cargo +1.99.0 test --all-targets
cargo +1.99.0 clippy --all-targets -- -D warnings
```

O Dockerfile executa os testes Go com `-race` durante o build. Para a validação integrada
nesta máquina, com o usuário `local` provisionado:

```powershell
Get-Content web/probe_runtime.py -Raw | docker compose -f headless-lab/compose.web.yml exec -T -e PYTHONPATH=/opt/euterpe-web web python3 -
```

Esse teste cria contas QA isoladas, importa a sessão local para uma delas, exercita as
APIs reais do Spotify e toca somente playlists descartáveis com um identificador exclusivo.
A parte de IA usa um provedor simulado local: valida streaming, chamadas de ferramentas,
aprovação, cancelamento e persistência sem consumir uma API paga. A limpeza verifica a
contagem original da biblioteca. O relatório público não inclui chaves, cookies ou códigos.
