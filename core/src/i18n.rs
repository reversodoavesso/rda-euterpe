//! i18n do daemon — contrato C11. Mesmo conjunto de chaves e valores de
//! `agent/src/i18n.ts`; `parity_prompts.rs` compara esta tabela com o golden
//! `core/tests/fixtures/i18n_keys.json` (drift é falha de teste).

/// `(key, en, pt-br)`.
pub const STRINGS: &[(&str, &str, &str)] = &[
    // Tom de voz: BRAND-VOICE.md. Registro de ESPERA — nunca use em erro,
    // quota, perda de dado ou confirmação.
    ("status.thinking", "Picking the next record…", "Escolhendo o próximo disco…"),
    ("status.working", "Fiddling with the records…", "Mexendo nos discos…"),
    ("status.invalidMessage", "Invalid message", "Mensagem inválida"),
    ("status.clientAuthenticated", "client authenticated", "cliente autenticado"),
    ("status.handshakeRejected", "handshake rejected", "handshake rejeitado"),
    ("status.messageReceived", "message received", "mensagem recebida"),
    ("status.clientDisconnected", "client disconnected", "cliente desconectado"),
    (
        "status.agentListening",
        "Euterpe agent listening on ws://{host}:{port}",
        "Agente Euterpe ouvindo em ws://{host}:{port}",
    ),
    (
        "status.clientOffline",
        "Spotify is not answering here. Reopen the client and try again.",
        "O Spotify não está respondendo aqui. Reabra o client e tente de novo.",
    ),
    // Linhas de sabor por ferramenta (BRAND-VOICE.md §6) — uma por tool real do
    // catálogo. Sem rótulo, o cartão cai em `status.working`.
    ("tool.get_playlists", "Opening the playlist drawer…", "Abrindo a gaveta das playlists…"),
    ("tool.get_playlist_tracks", "Counting tracks without losing the hook…", "Contando as faixas sem perder o refrão…"),
    ("tool.get_saved_tracks", "Revisiting what you saved (and forgot)…", "Revisitando o que você salvou (e nem lembra)…"),
    ("tool.get_top_artists", "Weighing plays on the scale…", "Pesando os plays no prato da balança…"),
    ("tool.get_top_tracks", "Settling the podium…", "Definindo o pódio…"),
    ("tool.get_listening_recents", "Rewinding the last few spins…", "Rebobinando o que passou há pouco…"),
    ("tool.get_currently_playing", "Checking what's on air right now…", "Checando o que está no ar agora…"),
    ("tool.get_player_state", "Peeking at the transport controls…", "Espiando o transporte (play, pause e afins)…"),
    ("tool.get_player_queue", "Reading the queue, professionally…", "Lendo a fila com cara de quem fiscaliza…"),
    ("tool.get_connect_devices", "Hunting the speaker that wandered off…", "Procurando a caixa de som que fugiu…"),
    ("tool.player_control", "Pressing the button (the right one)…", "Apertando o botão (o certo, dessa vez)…"),
    ("tool.player_queue_control", "Rearranging the queue carefully…", "Mexendo na fila com cuidado…"),
    ("tool.search_spotify", "Digging the whole catalog for one line…", "Vasculhando o catálogo inteiro por uma linha…"),
    ("tool.resolve_tracks", "Matching tracks in the crate…", "Cruzando faixas no baú…"),
    ("tool.get_related_artists", "Pulling the thread to the next artist…", "Puxando o fio até o artista vizinho…"),
    ("tool.get_artist", "Reading the official bio (sourced)…", "Lendo a biografia oficial (com fonte)…"),
    ("tool.get_recommendations", "Testing combos at the counter…", "Testando combinações no balcão…"),
    // Nome aposentado que o modelo ainda alucina (core/tests/replay_sessions.rs).
    ("tool.get_audio_features_bulk", "Weighing the audio features…", "Pesando as características musicais…"),
    ("tool.get_several_artists", "Filling out the index cards…", "Montando a ficha de cada um…"),
    ("tool.get_several_tracks", "Filling out the track cards…", "Montando a ficha de cada faixa…"),
    ("tool.new_releases", "Checking what just dropped…", "Verificando o que acabou de sair…"),
    ("tool.create_playlist", "Building a new playlist (with a label)…", "Montando a playlist nova (com etiqueta)…"),
    ("tool.add_tracks", "Shelving the tracks…", "Arrumando as faixas na estante…"),
    ("tool.remove_tracks", "Taking them out carefully…", "Tirando com cuidado…"),
    ("tool.set_playlist_details", "Rewriting the description nicely…", "Reescrevendo a descrição bonitinha…"),
    ("tool.replace_playlist_tracks", "Swapping the whole setlist…", "Trocando o repertório inteiro…"),
    ("tool.set_playlist_cover", "Pasting the cover on…", "Colando a capa…"),
    ("tool.web_search", "Stepping out to ask someone…", "Saindo para a rua perguntar a alguém…"),
    ("tool.similar_artists", "Looking for the sonic next of kin…", "Procurando o parentesco sonoro…"),
    ("tool.artist_info", "Checking the Last.fm take…", "Conferindo a versão da Last.fm…"),
    ("tool.enrich_tracks", "Filing the proper index cards…", "Colocando ficha catalográfica nas faixas…"),
    ("tool.lyrics_bulk", "Reading all the lyrics before judging…", "Lendo as letras todas antes de julgar…"),
    ("tool.lyrics_lookup", "Reading the lyrics before judging…", "Lendo a letra antes de julgar…"),
    ("tool.chart_lookup", "Checking the scoreboard…", "Olhando o placar…"),
    ("tool.image_search", "Finding a cover that survives a zoom…", "Procurando uma capa que aguente o close…"),
    ("tool.weekly_report", "Wrapping up the week…", "Fechando a semana em revista…"),
    ("tool.prepare_cover", "Framing it properly…", "Ajustando o enquadramento…"),
    ("tool.undo_last_mutation", "Undoing (the most underrated button)…", "Voltando atrás (o botão mais subestimado)…"),
    (
        "fallback.noApiKey",
        "Configure DEEPSEEK_API_KEY in agent/.env so the agent can reply.",
        "Configure DEEPSEEK_API_KEY no agent/.env para o agente responder.",
    ),
    // Registro de RISCO: causa + o que fazer. Sem "desculpe", sem hipérbole.
    ("fallback.noAnswer", "I could not put an answer together.", "Não consegui montar uma resposta."),
    (
        "fallback.stepLimit",
        "I hit the step limit. Here is what I have so far — refine the request if you need.",
        "Atingi o limite de passos. Aqui está o que consegui até agora — refine o pedido se precisar.",
    ),
    (
        "fallback.llmError",
        "I could not reach the model just now. Try again in a moment.",
        "Não consegui falar com o modelo agora. Tente de novo em instantes.",
    ),
    (
        "fallback.noApiKeyRust",
        "Configure an LLM provider API key in the Euterpe setup panel so the agent can reply.",
        "Configure a chave de API de um provider no painel de setup do Euterpe para o agente responder.",
    ),
    (
        "proposal.createPlaylist",
        "Create playlist \"{name}\" with {count} tracks",
        "Criar playlist \"{name}\" com {count} faixas",
    ),
    ("proposal.addTracks", "Add {count} tracks to the playlist", "Adicionar {count} faixas à playlist"),
    ("proposal.removeTracks", "Remove {count} tracks from the playlist", "Remover {count} faixas da playlist"),
    (
        "proposal.setDetails",
        "Update playlist name/description",
        "Atualizar nome/descrição da playlist",
    ),
    (
        "proposal.replaceTracks",
        "Replace all tracks in the playlist ({count} tracks)",
        "Substituir todas as faixas da playlist ({count} faixas)",
    ),
    ("proposal.setCover", "Change the playlist cover", "Alterar a capa da playlist"),
    ("proposal.execute", "Run {name}", "Executar {name}"),
];

/// Normaliza o locale recebido no handshake. `pt*` → `pt-br`, resto → `en`.
pub fn normalize_locale(raw: Option<&str>) -> &'static str {
    let lang = raw
        .unwrap_or("")
        .split('-')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if lang == "pt" {
        "pt-br"
    } else {
        "en"
    }
}

/// Traduz `key` interpolando `{var}`. Chave ausente devolve a própria chave
/// (mesmo comportamento de `makeT` no Node).
pub fn t(locale: &str, key: &str, vars: &[(&str, &str)]) -> String {
    let entry = STRINGS.iter().find(|(k, _, _)| *k == key);
    let mut out = match entry {
        Some((_, en, pt)) => {
            if locale == "pt-br" {
                (*pt).to_string()
            } else {
                (*en).to_string()
            }
        }
        None => key.to_string(),
    };
    for (k, v) in vars {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// `friendlyToolLabel()` de `agent/src/agent.ts`: se existe rótulo amigável,
/// usa; senão cai em `status.working`.
pub fn friendly_tool_label(locale: &str, name: &str) -> String {
    let key = format!("tool.{name}");
    if STRINGS.iter().any(|(k, _, _)| *k == key) {
        t(locale, &key, &[])
    } else {
        t(locale, "status.working", &[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_normalization_matches_node() {
        assert_eq!(normalize_locale(Some("pt")), "pt-br");
        assert_eq!(normalize_locale(Some("pt-BR")), "pt-br");
        assert_eq!(normalize_locale(Some("en-US")), "en");
        assert_eq!(normalize_locale(Some("ES")), "en");
        assert_eq!(normalize_locale(Some(" fr ")), "en");
        assert_eq!(normalize_locale(None), "en");
        assert_eq!(normalize_locale(Some("")), "en");
    }

    #[test]
    fn interpolation_and_fallback() {
        assert_eq!(
            t(
                "en",
                "status.agentListening",
                &[("host", "127.0.0.1"), ("port", "8337")]
            ),
            "Euterpe agent listening on ws://127.0.0.1:8337"
        );
        assert_eq!(
            t("pt-br", "status.thinking", &[]),
            "Escolhendo o próximo disco…"
        );
        assert_eq!(t("en", "does.not.exist", &[]), "does.not.exist");
    }

    #[test]
    fn friendly_label_falls_back_to_working() {
        assert_eq!(
            friendly_tool_label("en", "get_playlists"),
            "Opening the playlist drawer…"
        );
        assert_eq!(
            friendly_tool_label("en", "totally_unknown"),
            "Fiddling with the records…"
        );
    }
}
