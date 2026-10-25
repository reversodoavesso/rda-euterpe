# Cobertura preliminar das ferramentas do Euterpe

Fonte do contrato: `../core/src/assets/tools.json` (29 ferramentas client-side).
Escopo: commits de [sources.lock.json](sources.lock.json), inspecionados em 23/10/2026.

**Código** = implementação localizada; **parcial** = semântica diferente ou composição
necessária; **lacuna** = não encontramos equivalente pronto no escopo inspecionado.
As categorias sem menção a teste real são revisão de fonte. A segunda rodada validou
leituras autenticadas e a reconexão da sessão headless. Uma mesma operação do Euterpe
pode exigir combinar bibliotecas e código novo.

**Terceira rodada:** [MIGRATION.md](MIGRATION.md) documenta o adaptador já integrado
ao MCP. `create_playlist`, `delete_playlist`, `add_tracks`, `remove_tracks`,
`set_playlist_details`, `replace_playlist_tracks`, `get_playlists` e
`get_playlist_tracks` passaram pela conta real via daemon + serviço Go, além de
`undo_last_mutation`. A tabela abaixo compara os projetos upstream antes desse
adaptador; suas lacunas HTTP não significam que o serviço novo também as tenha.

**Quarta rodada:** o serviço integrado agora cobre 12 ferramentas. Busca nas quatro
categorias, `get_saved_tracks`, `get_several_tracks` e `resolve_tracks` passaram
no teste real [headless-catalog.json](results/headless-catalog.json), além de criação
por nome de faixa. O pareamento tem API por instância e teste real de emissão e
cancelamento de código; uma nova conta ainda não concluiu sua aprovação nesse fluxo.

| Ferramenta | NTify-SpotAPI | go-librespot | Observação para a migração |
|---|---|---|---|
| `create_playlist` | Código; protocolo offline passou | Lacuna na API HTTP | NTify cria entidade e faz follow na rootlist separadamente; adicionar faixas é outra etapa |
| `delete_playlist` | Código de unfollow/rootlist | Lacuna na API HTTP | Preservar a distinção entre remover da biblioteca e apagar conteúdo |
| `add_tracks` | Código; protocolo offline passou | Código e testes offline | NTify insere no índice zero por padrão; Euterpe acrescenta ao final |
| `remove_tracks` | Código; protocolo offline passou | Código e testes offline | Tratar duplicatas: remoção por URI e por posição não são equivalentes |
| `set_playlist_details` | Código; protocolo offline passou | Lacuna na API HTTP | Nome/descrição estão cobertos no NTify |
| `replace_playlist_tracks` | Parcial | Parcial | Compor leitura/remoção/adição com snapshot; não encontramos replace atômico pronto |
| `set_playlist_cover` | Código com falha de validação reproduzida | Lacuna na API HTTP | Alteração somente de capa é rejeitada no NTify; upload/registro ainda não validados |
| `get_listening_recents` | Código `RecentlyPlayed` | Lacuna no endpoint HTTP | Comparar campos/ordem com RecentsAPI atual; contexto de retomada não é histórico de escuta |
| `get_currently_playing` | Lacuna de player completo | Código `/status` | Confirmar relação entre player headless e reprodução em outros dispositivos |
| `get_player_state` | Lacuna de player completo | Parcial `/status` | Velocidade, sleep timer, qualidade e restrições precisam de comparação |
| `get_player_queue` | Lacuna | Parcial | Inspecionar fila interna; não assumir equivalência só por existir Spotify Connect |
| `get_connect_devices` | Lacuna | Parcial | Device headless não equivale a listar/controlar todos os dispositivos |
| `player_control` | Lacuna | Parcial; vários endpoints implementados | Play/pause/seek/volume/shuffle/repeat presentes; demais ações pendentes |
| `player_queue_control` | Lacuna | Parcial | HTTP oferece adicionar à fila; remover/reordenar/limpar não localizados |
| `get_playlists` | Rootlist autenticada real passou: 53 playlists | Leitura autenticada e paginação completa passaram: 53 playlists/3 páginas | Comparação de todos os campos, pastas e permissões ainda pendente |
| `get_playlist_tracks` | Parcial; protobuf/revisão, sem getter dedicado localizado | Leitura real passou: 31 faixas e seus metadados | Daemon enumera contexts com cache/limite configurável; não truncar silenciosamente |
| `get_saved_tracks` | Leitura autenticada de uma página passou | Código de collection/context | Paginação completa e `added_at` ainda pendentes |
| `get_top_artists` | Lacuna | Lacuna | Necessário outro endpoint ou preservar caminho Web API conforme acesso |
| `get_top_tracks` | Lacuna | Lacuna | Não substituir por recents fingindo mesma semântica |
| `search_spotify` | Busca pública real e protocolo offline passaram | Lacuna no HTTP de busca | NTify retornou uma faixa via Pathfinder v2 com tokens anônimos; cobertura de todos os tipos ainda pendente |
| `get_related_artists` | Código GraphQL | Lacuna na API HTTP | Hash e payload precisam de teste autenticado |
| `get_artist` | Parcial; endpoints de artista/extended metadata | Parcial; metadata | Cobertura de biografia/ouvintes/followers precisa de verificação campo a campo |
| `get_recommendations` | Parcial; Smart Shuffle por playlist | Parcial; contexto/autoplay | Não equivale automaticamente a seeds de artistas/faixas/gêneros |
| `get_several_artists` | Parcial; extended metadata | Parcial; metadata | Normalizar lotes/campos; não presumir gêneros/popularidade |
| `get_several_tracks` | Parcial; extended metadata | Parcial; metadata | Normalizar lotes/campos e indisponibilidade |
| `new_releases` | Parcial; browse/home | Lacuna equivalente pronta | Feed não é automaticamente o catálogo de lançamentos atual |
| `dump_library` | Composição | Composição | Criar cache/paginação; desempenho instantâneo do store desktop não foi reproduzido |
| `batch_create_playlists` | Composição | Depende de implementar criação | Preservar confirmações, fatiamento e resolução de nomes |
| `resolve_tracks` | Composição sobre busca | Depende de implementar busca | Manter deduplicação, critérios de correspondência e limites |

## Onde conferir no código baixado

- NTify: `repos/ntify-spotapi/src/main/java/com/spotifyxp/spotapi/requests/playlist/`,
  `requests/library/`, `requests/feed/Search.java`, `requests/artist/`,
  `requests/user/RecentlyPlayed.java`, `requests/ExtendedMetadata.java`.
- go-librespot: `repos/go-librespot/api-spec.yml`, `spclient/library_write.go`,
  `spclient/playlist_context.go`, `daemon/library.go`, `daemon/api_server.go`.
- librespot: `repos/librespot/core/src/session.rs`, `core/src/login5.rs`,
  `core/src/spclient.rs`, `oauth/src/lib.rs`, `docs/device-authorization.md`.
- spotify-player: `repos/spotify-player/spotify_player/src/cli/`, `src/client/spotify.rs`
  e `src/auth.rs` (os dois últimos relativos à pasta `spotify_player/`).
- SpotAPI Python: `repos/spotapi-python/spotapi/playlist.py`, `client.py`, `login.py`,
  `player.py`. A interface pública de `PrivatePlaylist` foi inspecionada em runtime.

As 16 ferramentas server-side não desaparecem na migração. Ferramentas compostas
como backup, restore e undo fazem chamadas ao cliente e também precisarão usar o
adaptador novo. Os mesmos contratos MCP devem permanecer até a paridade ser testada.
