//! i18n do daemon — contrato C11. Mesmo conjunto de chaves e valores de
//! `agent/src/i18n.ts`; `parity_prompts.rs` compara esta tabela com o golden
//! `core/tests/fixtures/i18n_keys.json` (drift é falha de teste).

/// `(key, en, pt-br)`.
pub const STRINGS: &[(&str, &str, &str)] = &[
    ("status.thinking", "Analyzing…", "Analisando…"),
    ("status.working", "Working…", "Trabalhando…"),
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
    ("status.clientOffline", "Spotify client is not connected", "Cliente do Spotify não está conectado"),
    ("tool.get_playlists", "reading your playlists…", "lendo suas playlists…"),
    ("tool.get_playlist_tracks", "reading playlist tracks…", "lendo faixas da playlist…"),
    ("tool.get_saved_tracks", "reading saved tracks…", "lendo músicas salvas…"),
    ("tool.get_top_artists", "analyzing your artists…", "analisando seus artistas…"),
    ("tool.get_top_tracks", "analyzing your tracks…", "analisando suas músicas…"),
    ("tool.search_spotify", "searching on Spotify…", "procurando no Spotify…"),
    ("tool.get_related_artists", "looking up related artists…", "buscando artistas relacionados…"),
    ("tool.get_artist", "fetching artist info…", "buscando informações do artista…"),
    ("tool.get_recommendations", "building recommendations…", "montando recomendações…"),
    ("tool.get_audio_features_bulk", "analyzing track features…", "analisando características musicais…"),
    ("tool.get_several_artists", "fetching artists…", "buscando artistas…"),
    ("tool.get_several_tracks", "fetching tracks…", "buscando faixas…"),
    ("tool.new_releases", "fetching new releases…", "buscando lançamentos…"),
    ("tool.create_playlist", "creating playlist…", "criando playlist…"),
    ("tool.add_tracks", "adding tracks…", "adicionando faixas…"),
    ("tool.remove_tracks", "removing tracks…", "removendo faixas…"),
    ("tool.set_playlist_details", "updating playlist…", "atualizando playlist…"),
    ("tool.replace_playlist_tracks", "updating tracks…", "atualizando faixas…"),
    ("tool.set_playlist_cover", "updating cover…", "atualizando capa…"),
    ("tool.web_search", "searching the web…", "pesquisando na web…"),
    ("tool.similar_artists", "finding similar artists…", "buscando artistas similares…"),
    ("tool.artist_info", "fetching artist bio…", "buscando biografia do artista…"),
    ("tool.enrich_tracks", "enriching track data…", "enriquecendo dados das faixas…"),
    ("tool.lyrics_bulk", "fetching lyrics…", "buscando letras…"),
    ("tool.lyrics_lookup", "fetching lyrics…", "buscando letra…"),
    ("tool.chart_lookup", "checking charts…", "consultando rankings…"),
    ("tool.image_search", "looking for images…", "procurando imagens…"),
    ("tool.weekly_report", "generating report…", "gerando relatório…"),
    ("tool.prepare_cover", "preparing cover…", "preparando capa…"),
    ("tool.undo_last_mutation", "undoing change…", "desfazendo alteração…"),
    (
        "fallback.noApiKey",
        "Configure DEEPSEEK_API_KEY in agent/.env so the agent can reply.",
        "Configure DEEPSEEK_API_KEY no agent/.env para o agente responder.",
    ),
    ("fallback.noAnswer", "I could not generate an answer.", "Não consegui gerar uma resposta."),
    (
        "fallback.stepLimit",
        "I reached the step limit. Here is what I have so far — refine the request if you need.",
        "Atingi o limite de passos. Respondo com o que consegui até aqui — refinem o pedido se precisar.",
    ),
    (
        "fallback.llmError",
        "Sorry, I had a problem talking to the model just now. Try again in a moment.",
        "Desculpe, tive um problema ao me comunicar com o modelo agora. Tenta de novo em instantes.",
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
        assert_eq!(t("pt-br", "status.thinking", &[]), "Analisando…");
        assert_eq!(t("en", "does.not.exist", &[]), "does.not.exist");
    }

    #[test]
    fn friendly_label_falls_back_to_working() {
        assert_eq!(
            friendly_tool_label("en", "get_playlists"),
            "reading your playlists…"
        );
        assert_eq!(friendly_tool_label("en", "totally_unknown"), "Working…");
    }
}
