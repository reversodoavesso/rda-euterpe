# Sessão do desktop → headless

Etapa seguinte já implementada: [MCP headless integrado](MIGRATION.md).

Em 23/10/2026, com autorização explícita do usuário, a autenticação do Spotify aberto
foi transferida para o go-librespot em Docker Linux e validada somente com leituras.

## Resultado

- Conta correspondente ao desktop confirmada sem publicar o identificador.
- Credencial persistente própria criada pelo headless.
- Token temporário removido da configuração antes do reinício.
- Reconexão e retorno da mesma página da biblioteca após reiniciar o container.
- 53 playlists lidas integralmente em três páginas.
- Uma playlist lida com as 31 faixas e os 31 metadados completos.
- NTify: rootlist com 55 itens, dos quais 53 são referências a playlists, e uma página
  de músicas curtidas lidas com o token temporário do desktop.

Não foram modificadas playlists nem solicitada reprodução. Isso comprova sessão e
leituras headless; a integração ao MCP, a interface web e a paridade de escrita
continuam pendentes. A durabilidade por dias ou após revogação não foi medida.

## Como foi feito

1. Um receptor HTTP de uso único foi aberto somente em `127.0.0.1`, com caminho
   aleatório, limite de tamanho e validação do Origin do Spotify.
2. Pelo DevTools do aplicativo, o access token da `AuthorizationAPI` foi enviado
   diretamente a esse receptor. A operação não imprime o token, não usa senha e não
   modifica a extensão. O identificador da conta veio somente de `Spotify/prefs`.
3. O token iniciou a sessão via `credentials.type=spotify_token`. O accesspoint e o
   Login5 forneceram a credencial própria persistida pelo go-librespot.
4. A configuração foi alterada para `device_auth`, sem o access token, e o container
   foi reiniciado usando seu estado persistido. A biblioteca continuou disponível.
5. O NTify também fez duas leituras autenticadas. Depois, a cópia temporária do
   access token foi descartada. O receptor terminou e o DevTools foi fechado.

O diretório `private/desktop-migration/` é ignorado pelo Git e tem ACL restrita ao
usuário atual e SYSTEM. Os relatórios publicáveis contêm só resultados, contagens e
esquemas. Não há credenciais em argumentos de processo ou arquivos versionáveis.

## Serviço disponível

Container: `euterpe-headless-lab-desktop-session`.
API: `http://127.0.0.1:18378` (somente loopback).
Estado persistente: `private/desktop-migration/go-librespot/state.json`.
Configuração: `private/desktop-migration/go-librespot/config.yml`.

```powershell
# Repetir as leituras com a sessão própria do headless.
python headless-lab/scripts/read_go_library.py --all --context
python headless-lab/scripts/summarize.py

# Parar e retomar o container existente, preservando a credencial.
docker stop euterpe-headless-lab-desktop-session
docker start euterpe-headless-lab-desktop-session
```

O compose original da bancada usa a mesma porta e outro diretório de estado.
Pare este container antes de iniciar o compose de pareamento de uma nova conta.

## Evidências e scripts

- [Migração e reconexão](results/desktop-migration.json).
- [Paginação e faixas](results/go-account-read.json).
- [Leituras autenticadas do NTify](results/ntify-account-read.json).
- [Receptor local](scripts/capture_desktop_auth.py) e
  [bootstrap do container](scripts/migrate_desktop_session.py).
- [Teste do NTify](scripts/probe_ntify_account.py) e
  [harness Java](harness/NtifyAccountRead.java).

Uma nova captura precisa ser explícita. Os scripts não extraem autenticação
automaticamente durante os checks offline. O teste opcional do NTify precisa de
uma nova captura depois do descarte do token; ele ainda não usa a renovação do daemon.
