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
  // Tom de voz: BRAND-VOICE.md. Estes rótulos são o registro de ESPERA —
  // nunca use este tom em erro, quota, perda de dado ou confirmação.
  "status.thinking": { en: "Picking the next record…", "pt-br": "Escolhendo o próximo disco…" },
  "status.working": { en: "Fiddling with the records…", "pt-br": "Mexendo nos discos…" },
  "status.invalidMessage": { en: "Invalid message", "pt-br": "Mensagem inválida" },
  "status.clientAuthenticated": { en: "client authenticated", "pt-br": "cliente autenticado" },
  "status.handshakeRejected": { en: "handshake rejected", "pt-br": "handshake rejeitado" },
  "status.messageReceived": { en: "message received", "pt-br": "mensagem recebida" },
  "status.clientDisconnected": { en: "client disconnected", "pt-br": "cliente desconectado" },
  "status.agentListening": { en: "Euterpe agent listening on ws://{host}:{port}", "pt-br": "Agente Euterpe ouvindo em ws://{host}:{port}" },

  // Linhas de sabor por ferramenta (BRAND-VOICE.md §6). Uma por tool REAL do
  // catálogo (core/src/assets/tools.json) — sem rótulo, o cartão cai no
  // status.working e o usuário perde a narração.
  "tool.get_playlists": { en: "Opening the playlist drawer…", "pt-br": "Abrindo a gaveta das playlists…" },
  "tool.get_playlist_tracks": { en: "Counting tracks without losing the hook…", "pt-br": "Contando as faixas sem perder o refrão…" },
  "tool.get_saved_tracks": { en: "Revisiting what you saved (and forgot)…", "pt-br": "Revisitando o que você salvou (e nem lembra)…" },
  "tool.get_top_artists": { en: "Weighing plays on the scale…", "pt-br": "Pesando os plays no prato da balança…" },
  "tool.get_top_tracks": { en: "Settling the podium…", "pt-br": "Definindo o pódio…" },
  "tool.get_listening_recents": { en: "Rewinding the last few spins…", "pt-br": "Rebobinando o que passou há pouco…" },
  "tool.get_currently_playing": { en: "Checking what's on air right now…", "pt-br": "Checando o que está no ar agora…" },
  "tool.get_player_state": { en: "Peeking at the transport controls…", "pt-br": "Espiando o transporte (play, pause e afins)…" },
  "tool.get_player_queue": { en: "Reading the queue, professionally…", "pt-br": "Lendo a fila com cara de quem fiscaliza…" },
  "tool.get_connect_devices": { en: "Hunting the speaker that wandered off…", "pt-br": "Procurando a caixa de som que fugiu…" },
  "tool.player_control": { en: "Pressing the button (the right one)…", "pt-br": "Apertando o botão (o certo, dessa vez)…" },
  "tool.player_queue_control": { en: "Rearranging the queue carefully…", "pt-br": "Mexendo na fila com cuidado…" },
  "tool.search_spotify": { en: "Digging the whole catalog for one line…", "pt-br": "Vasculhando o catálogo inteiro por uma linha…" },
  "tool.get_related_artists": { en: "Pulling the thread to the next artist…", "pt-br": "Puxando o fio até o artista vizinho…" },
  "tool.get_artist": { en: "Reading the official bio (sourced)…", "pt-br": "Lendo a biografia oficial (com fonte)…" },
  "tool.get_recommendations": { en: "Testing combos at the counter…", "pt-br": "Testando combinações no balcão…" },
  // Nome aposentado: o modelo ainda alucina esta tool (ver
  // core/tests/replay_sessions.rs) — mantemos o rótulo para o cartão não cair
  // no fallback quando isso acontecer.
  "tool.get_audio_features_bulk": { en: "Weighing the audio features…", "pt-br": "Pesando as características musicais…" },
  "tool.get_several_artists": { en: "Filling out the index cards…", "pt-br": "Montando a ficha de cada um…" },
  "tool.get_several_tracks": { en: "Filling out the track cards…", "pt-br": "Montando a ficha de cada faixa…" },
  "tool.new_releases": { en: "Checking what just dropped…", "pt-br": "Verificando o que acabou de sair…" },
  "tool.create_playlist": { en: "Building a new playlist (with a label)…", "pt-br": "Montando a playlist nova (com etiqueta)…" },
  "tool.add_tracks": { en: "Shelving the tracks…", "pt-br": "Arrumando as faixas na estante…" },
  "tool.remove_tracks": { en: "Taking them out carefully…", "pt-br": "Tirando com cuidado…" },
  "tool.set_playlist_details": { en: "Rewriting the description nicely…", "pt-br": "Reescrevendo a descrição bonitinha…" },
  "tool.replace_playlist_tracks": { en: "Swapping the whole setlist…", "pt-br": "Trocando o repertório inteiro…" },
  "tool.set_playlist_cover": { en: "Pasting the cover on…", "pt-br": "Colando a capa…" },
  "tool.web_search": { en: "Stepping out to ask someone…", "pt-br": "Saindo para a rua perguntar a alguém…" },
  "tool.similar_artists": { en: "Looking for the sonic next of kin…", "pt-br": "Procurando o parentesco sonoro…" },
  "tool.artist_info": { en: "Checking the Last.fm take…", "pt-br": "Conferindo a versão da Last.fm…" },
  "tool.enrich_tracks": { en: "Filing the proper index cards…", "pt-br": "Colocando ficha catalográfica nas faixas…" },
  "tool.lyrics_bulk": { en: "Reading all the lyrics before judging…", "pt-br": "Lendo as letras todas antes de julgar…" },
  "tool.lyrics_lookup": { en: "Reading the lyrics before judging…", "pt-br": "Lendo a letra antes de julgar…" },
  "tool.chart_lookup": { en: "Checking the scoreboard…", "pt-br": "Olhando o placar…" },
  "tool.image_search": { en: "Finding a cover that survives a zoom…", "pt-br": "Procurando uma capa que aguente o close…" },
  "tool.weekly_report": { en: "Wrapping up the week…", "pt-br": "Fechando a semana em revista…" },
  "tool.prepare_cover": { en: "Framing it properly…", "pt-br": "Ajustando o enquadramento…" },
  "tool.undo_last_mutation": { en: "Undoing (the most underrated button)…", "pt-br": "Voltando atrás (o botão mais subestimado)…" },

  "fallback.noApiKey": {
    en: "Configure DEEPSEEK_API_KEY in agent/.env so the agent can reply.",
    "pt-br": "Configure DEEPSEEK_API_KEY no agent/.env para o agente responder.",
  },
  // Registro de RISCO: causa + o que fazer. Sem "desculpe", sem hipérbole.
  // O humor do BRAND-VOICE.md §3 não entra aqui.
  "fallback.noAnswer": { en: "I could not put an answer together.", "pt-br": "Não consegui montar uma resposta." },
  "fallback.stepLimit": {
    en: "I hit the step limit. Here is what I have so far — refine the request if you need.",
    "pt-br": "Atingi o limite de passos. Aqui está o que consegui até agora — refine o pedido se precisar.",
  },
  "fallback.llmError": {
    en: "I could not reach the model just now. Try again in a moment.",
    "pt-br": "Não consegui falar com o modelo agora. Tente de novo em instantes.",
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
