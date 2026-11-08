# Euterpe Web

Aplicação web para conversar com o agente e gerenciar playlists com Spotify headless.
A interface em português tem três áreas: conversas, área de trabalho e seleção em revisão.

## MCP remoto com OAuth

Clientes como Gemini podem conectar a URL pública `/mcp` usando descoberta OAuth
e registro dinâmico, sem preencher o ID/segredo do cliente nas opções avançadas.
O gateway publica `/.well-known/oauth-protected-resource/mcp` (também na raiz) e
`/.well-known/oauth-authorization-server`. Os endpoints `/oauth/register`,
`/oauth/authorize`, `/oauth/token` e `/oauth/revoke` implementam authorization code
com PKCE S256, consentimento e renovação. O modo de autenticação do cliente é
`none`; a prova de posse do código é obrigatória. Configure `WEB_PUBLIC_ORIGIN`
com a origem HTTPS canônica; descoberta local aceita apenas loopback.

A autorização reutiliza o login RDA e solicita consentimento antes de emitir
credenciais. O usuário é definido pela sessão autenticada; IDs e cabeçalhos
enviados pelo cliente não selecionam outra conta. Escopos: `read` (padrão),
`write`, ou `read write`. Escritas exigem aprovação por padrão. Em **Ajustes →
Operações e autorizações**, o proprietário pode desativar essa confirmação para
as próximas operações de sua conta, tanto no agente quanto nas conexões MCP.
Tokens de leitura continuam sem poder escrever. A preferência é persistida no
compute pessoal; mudanças em outras preferências não a redefinem.

Access tokens expiram em uma hora; a autorização para renovação dura 30 dias.
Cada renovação substitui os tokens e invalida o access token anterior. Reutilizar
um refresh token consumido ou um código já trocado revoga toda a autorização.
O cliente deve serializar renovações e guardar o novo refresh token recebido.
Reenviar o formulário de consentimento com a mesma conta/sessão retorna o mesmo
código ainda não trocado, sem criar outra autorização. Após a troca, o formulário
não reenvia o código; apresenta uma orientação de retorno ao aplicativo. Pedidos
expirados apresentam uma página para reiniciar a conexão em vez de JSON bruto.
Tokens persistem somente como hashes e continuam válidos após reinício do gateway.
Para revogar, use **Ajustes → Acesso remoto MCP**, onde o aplicativo aparece com
o prefixo `MCP:`; a exclusão impede também a renovação. Tokens pessoais existentes
continuam funcionando. Registros de clientes sem uso por 90 dias e sem autorização
ativa podem ser removidos para liberar capacidade de registro.

Um `initialize` autenticado e válido aguarda a prontidão do compute pessoal.
Listar/executar ferramentas também retoma o compute após suspensão por inatividade,
sem cookie, aba ou heartbeat da interface. Descoberta pública e pedidos inválidos
não iniciam compute. Falha ao iniciar retorna 503; mutações de resultado incerto
nunca são repetidas automaticamente.

Verificação local: `python -m unittest discover -v` nesta pasta e `npm test`.
`test_mcp_oauth.py` cobre consentimento/CSRF, SSO, PKCE, códigos de uso único,
rotatividade/revogação, expiração, isolamento entre contas e HTTP sem interface
contra runtime suspenso. A prova visual e de callback em Chromium está em
`artifacts/euterpe-oauth-browser-20261108.mjs` no workspace do ecossistema.

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

## MCP remoto e tokens pessoais

Em **Ajustes → Acesso remoto MCP**, informe um nome, permissões e validade (1–90 dias;
30 por padrão). **Gerar token** exibe o segredo uma única vez. **Listar tokens** mostra
metadados e permite revogar cada token imediatamente para novas requisições. São
permitidos até 20 tokens ativos por conta. Só o hash SHA-256 fica no banco de dados;
o token não é salvo no navegador. Vincular uma conta local ao SSO revoga seus tokens
locais anteriores. Logout da interface não revoga tokens pessoais; use **Revogar**.

Configure um cliente compatível com Streamable HTTP e cabeçalhos personalizados:

```json
{
  "mcpServers": {
    "euterpe": {
      "type": "http",
      "url": "https://SEU_DOMINIO/mcp",
      "headers": { "Authorization": "Bearer TOKEN_GERADO" }
    }
  }
}
```

O formato da configuração depende do cliente. Use a origem de sua instalação e HTTPS
para acesso remoto; depois de publicar esta versão no ambiente RDA, o endpoint será
`https://euterpe.reversodoavesso.com/mcp`. Esta implementação usa tokens pessoais,
sem fluxo OAuth para clientes MCP. Clientes que aceitam somente OAuth precisam de
uma integração adicional.

O endpoint é stateless, responde JSON a POST e aceita notificações com HTTP 202.
GET/DELETE retornam 405; não há stream SSE proativo ou identificador de sessão MCP.
O cliente envia `Accept: application/json, text/event-stream` e, após inicializar,
`MCP-Protocol-Version: 2025-06-18` (também aceita `2025-03-26`). A origem é validada
quando informada. O proxy deve encaminhar `Authorization` e `/mcp` ao gateway e permitir
requisições longas durante a aprovação. Nenhuma credencial do worker é exposta.

Tokens `read` permitem as seis ferramentas de leitura de `READ_TOOLS`. Tokens `write`
acrescentam as sete ferramentas de `WRITE_TOOLS`, incluindo desfazer. Os nomes MCP
têm prefixo `spotify_`. Recursos e prompts do daemon também estão disponíveis.
As ferramentas de workspace, operações, configurações, pareamento e gestão de tokens
não são expostas ao cliente remoto. Tokens não autenticam as APIs da interface.

Cada requisição usa o worker do titular do token. Escritas recebem uma exigência de
confirmação no daemon, inclusive se uma configuração antiga estiver em `allow`;
`deny` continua bloqueando. Aprove a proposta na interface Euterpe. O MCP não oferece
um método remoto de aprovação. Revogar um token impede novas chamadas, mas não
desfaz chamadas já iniciadas ou escritas aprovadas.

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


## Auditoria de conversas

A aba **Auditoria** e o botão **Auditar conversa** no chat abrem o histórico de uma conversa do usuário autenticado. A tela reúne mensagens, modelo selecionado, chamadas e resultados de ferramentas, solicitações e decisões de aprovação, erros, cancelamentos, duração e ID das execuções. Os filtros permitem inspecionar falhas ou ferramentas; **Atualizar** busca o estado atual, inclusive durante uma resposta.

O gateway persiste novos eventos na tabela `chat_audit` do `accounts.sqlite`. A exclusão da conversa também exclui esses registros. O endpoint autenticado `GET /api/conversations/<id>/audit` combina esses eventos com os diagnósticos já persistidos pelo agente. Se o worker estiver indisponível, mensagens e eventos do gateway continuam acessíveis. Conversas anteriores podem ter cobertura parcial; solicitações sem evento de encerramento podem indicar reinício abrupto do serviço.

Os detalhes do agente usam uma lista explícita de campos permitidos. Chaves, cabeçalhos, logs brutos e conteúdo de raciocínio não são expostos pela auditoria. A tela não estima tokens ou custo: esses dados não são fornecidos pelo contrato atual do agente.

Falhas de IA e de ferramentas também deixam um aviso na própria mensagem, com acesso à auditoria. O campo `messages.error_code` é migrado automaticamente e preserva o aviso após recarregar a conversa. Respostas vazias, interrupções e bloqueios de cota não removem a mensagem do agente silenciosamente. O evento `tools.available` registra o catálogo filtrado para o backend de cada execução.
