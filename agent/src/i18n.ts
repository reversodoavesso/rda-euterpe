// Locale support for agent-facing interface strings.
// Default: en. Supported: pt-br (from Spotify config via the hello handshake).
export type LocaleKey = "en" | "pt-br";

export type Translator = (key: string, vars?: Record<string, string | number>) => string;

export function normalizeLocale(raw?: string | null): LocaleKey {
  const lang = String(raw ?? "").split("-")[0].trim().toLowerCase();
  return lang === "pt" ? "pt-br" : "en";
}

type Dict = Record<string, { en: string; "pt-br": string }>;

export function makeT(dict: Dict, locale: LocaleKey): Translator {
  return (key, vars) => {
    const entry = dict[key];
    let out = (entry && (entry[locale] ?? entry.en)) || key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll(`{${k}}`, String(v));
      }
    }
    return out;
  };
}

/** Every user-facing string the agent emits (chat.status detail, fallback
    replies, proposal titles). Keep keys stable across locales. */
export const AGENT_STRINGS: Dict = {
  "status.thinking": { en: "Analyzing…", "pt-br": "Analisando…" },
  "status.working": { en: "Working…", "pt-br": "Trabalhando…" },
  "status.invalidMessage": { en: "Invalid message", "pt-br": "Mensagem inválida" },
  "status.clientAuthenticated": { en: "client authenticated", "pt-br": "cliente autenticado" },
  "status.handshakeRejected": { en: "handshake rejected", "pt-br": "handshake rejeitado" },
  "status.messageReceived": { en: "message received", "pt-br": "mensagem recebida" },
  "status.clientDisconnected": { en: "client disconnected", "pt-br": "cliente desconectado" },
  "status.agentListening": { en: "Euterpe agent listening on ws://{host}:{port}", "pt-br": "Agente Euterpe ouvindo em ws://{host}:{port}" },

  "tool.get_playlists": { en: "reading your playlists…", "pt-br": "lendo suas playlists…" },
  "tool.get_playlist_tracks": { en: "reading playlist tracks…", "pt-br": "lendo faixas da playlist…" },
  "tool.get_saved_tracks": { en: "reading saved tracks…", "pt-br": "lendo músicas salvas…" },
  "tool.get_top_artists": { en: "analyzing your artists…", "pt-br": "analisando seus artistas…" },
  "tool.get_top_tracks": { en: "analyzing your tracks…", "pt-br": "analisando suas músicas…" },
  "tool.search_spotify": { en: "searching on Spotify…", "pt-br": "procurando no Spotify…" },
  "tool.get_related_artists": { en: "looking up related artists…", "pt-br": "buscando artistas relacionados…" },
  "tool.get_artist": { en: "fetching artist info…", "pt-br": "buscando informações do artista…" },
  "tool.get_recommendations": { en: "building recommendations…", "pt-br": "montando recomendações…" },
  "tool.get_audio_features_bulk": { en: "analyzing track features…", "pt-br": "analisando características musicais…" },
  "tool.get_several_artists": { en: "fetching artists…", "pt-br": "buscando artistas…" },
  "tool.get_several_tracks": { en: "fetching tracks…", "pt-br": "buscando faixas…" },
  "tool.new_releases": { en: "fetching new releases…", "pt-br": "buscando lançamentos…" },
  "tool.create_playlist": { en: "creating playlist…", "pt-br": "criando playlist…" },
  "tool.add_tracks": { en: "adding tracks…", "pt-br": "adicionando faixas…" },
  "tool.remove_tracks": { en: "removing tracks…", "pt-br": "removendo faixas…" },
  "tool.set_playlist_details": { en: "updating playlist…", "pt-br": "atualizando playlist…" },
  "tool.replace_playlist_tracks": { en: "updating tracks…", "pt-br": "atualizando faixas…" },
  "tool.set_playlist_cover": { en: "updating cover…", "pt-br": "atualizando capa…" },
  "tool.web_search": { en: "searching the web…", "pt-br": "pesquisando na web…" },
  "tool.similar_artists": { en: "finding similar artists…", "pt-br": "buscando artistas similares…" },
  "tool.artist_info": { en: "fetching artist bio…", "pt-br": "buscando biografia do artista…" },
  "tool.enrich_tracks": { en: "enriching track data…", "pt-br": "enriquecendo dados das faixas…" },
  "tool.lyrics_bulk": { en: "fetching lyrics…", "pt-br": "buscando letras…" },
  "tool.lyrics_lookup": { en: "fetching lyrics…", "pt-br": "buscando letra…" },
  "tool.chart_lookup": { en: "checking charts…", "pt-br": "consultando rankings…" },
  "tool.image_search": { en: "looking for images…", "pt-br": "procurando imagens…" },
  "tool.weekly_report": { en: "generating report…", "pt-br": "gerando relatório…" },
  "tool.prepare_cover": { en: "preparing cover…", "pt-br": "preparando capa…" },
  "tool.undo_last_mutation": { en: "undoing change…", "pt-br": "desfazendo alteração…" },

  "fallback.noApiKey": {
    en: "Configure DEEPSEEK_API_KEY in agent/.env so the agent can reply.",
    "pt-br": "Configure DEEPSEEK_API_KEY no agent/.env para o agente responder.",
  },
  "fallback.noAnswer": { en: "I could not generate an answer.", "pt-br": "Não consegui gerar uma resposta." },
  "fallback.stepLimit": {
    en: "I reached the step limit. Here is what I have so far — refine the request if you need.",
    "pt-br": "Atingi o limite de passos. Respondo com o que consegui até aqui — refinem o pedido se precisar.",
  },
  "fallback.llmError": {
    en: "Sorry, I had a problem talking to the model just now. Try again in a moment.",
    "pt-br": "Desculpe, tive um problema ao me comunicar com o modelo agora. Tenta de novo em instantes.",
  },

  "proposal.createPlaylist": {
    en: "Create playlist \"{name}\" with {count} tracks",
    "pt-br": "Criar playlist \"{name}\" com {count} faixas",
  },
  "proposal.addTracks": { en: "Add {count} tracks to the playlist", "pt-br": "Adicionar {count} faixas à playlist" },
  "proposal.removeTracks": { en: "Remove {count} tracks from the playlist", "pt-br": "Remover {count} faixas da playlist" },
  "proposal.setDetails": { en: "Update playlist name/description", "pt-br": "Atualizar nome/descrição da playlist" },
  "proposal.replaceTracks": {
    en: "Replace all tracks in the playlist ({count} tracks)",
    "pt-br": "Substituir todas as faixas da playlist ({count} faixas)",
  },
  "proposal.setCover": { en: "Change the playlist cover", "pt-br": "Alterar a capa da playlist" },
  "proposal.execute": { en: "Run {name}", "pt-br": "Executar {name}" },
};
