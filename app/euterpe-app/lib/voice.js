// Voz da Euterpe — pools de copy rotativa. Ver BRAND-VOICE.md §5, §6 e §8.
//
// Regra que governa este arquivo (BRAND-VOICE.md §3): tudo aqui é *registro de
// Espera*. Nada destes textos pode ser usado em erro, quota, perda de dado ou
// confirmação de mutação — nesses casos a Euterpe fica séria.
//
// Armadilha registrada no doc e respeitada aqui: o sorteio acontece UMA vez,
// quando a espera começa — nunca dentro do render. Se você chamar `pick()` no
// corpo de um componente React, o texto troca a cada re-render e pisca.
import { appLocale } from "./i18n.js";

/** Intervalo de troca do verbo de espera no cartão de status. */
export const ROTATE_MS = 2500;

/**
 * Sorteia um item do pool evitando repetir o último (não repetir na mesma tarefa).
 * @param {string[]} pool
 * @param {string} [avoid] item a evitar (o último exibido)
 * @returns {string}
 */
export function pick(pool, avoid) {
  const items = Array.isArray(pool) ? pool.filter((v) => v && v !== avoid) : [];
  if (!items.length) return (Array.isArray(pool) && pool[0]) || "";
  return items[Math.floor(Math.random() * items.length)];
}

// --- Verbo de espera ("pensamento") — BRAND-VOICE.md §5 ---------------------
// Gerúndio, maiúscula inicial, reticências. Camada de ofício + absurdo-técnico.
export const THINKING = {
  "pt-br": [
    "Garimpando…",
    "Sampleando…",
    "Equalizando…",
    "Sequenciando…",
    "Encaixando o BPM…",
    "Catalogando…",
    "Arquivando…",
    "Fichando…",
    "Reticulando splines…",
    "Desenrolando o cabo do fone…",
    "Tirando o pó do vinil…",
    "Contando os 808 que faltam…",
    "Deixando o subwoofer respirar…",
    "Convencendo o cache a cooperar…",
    "Organizando as capas por cor…",
    "Separando o lado A do lado B…",
  ],
  en: [
    "Crate-digging…",
    "Chopping samples…",
    "Equalizing…",
    "Sequencing…",
    "Beatmatching…",
    "Cataloging…",
    "Filing…",
    "Reticulating splines…",
    "Untangling the headphone cable…",
    "Dusting the sleeves…",
    "Counting the missing 808s…",
    "Letting the subwoofer breathe…",
    "Talking the cache into cooperating…",
    "Sorting covers by color…",
    "Separating side A from side B…",
  ],
};

/** Verbo de espera no locale da UI, evitando repetir `avoid`. */
export function thinkingVerb(avoid) {
  return pick(THINKING[appLocale()] || THINKING.en, avoid);
}

// --- Sabor por ferramenta — BRAND-VOICE.md §6 ------------------------------
// Uma linha por tool REAL do catálogo (core/src/assets/tools.json).
// O nome cru da ferramenta continua visível na UI: o sabor é rótulo
// secundário, nunca substituto (ver BRAND-VOICE.md §12.3).
export const TOOL_FLAVOR = {
  // leitura — biblioteca
  get_playlists: { "pt-br": "Abrindo a gaveta das playlists", en: "Opening the playlist drawer" },
  get_playlist_tracks: { "pt-br": "Contando as faixas sem perder o refrão", en: "Counting tracks without losing the hook" },
  get_saved_tracks: { "pt-br": "Revisitando o que você salvou (e nem lembra)", en: "Revisiting what you saved (and forgot)" },
  get_top_artists: { "pt-br": "Pesando os plays no prato da balança", en: "Weighing plays on the scale" },
  get_top_tracks: { "pt-br": "Definindo o pódio", en: "Settling the podium" },
  get_listening_recents: { "pt-br": "Rebobinando o que passou há pouco", en: "Rewinding the last few spins" },

  // leitura — player
  get_currently_playing: { "pt-br": "Checando o que está no ar agora", en: "Checking what's on air right now" },
  get_player_state: { "pt-br": "Espiando o transporte (play, pause e afins)", en: "Peeking at the transport controls" },
  get_player_queue: { "pt-br": "Lendo a fila com cara de quem fiscaliza", en: "Reading the queue, professionally" },
  get_connect_devices: { "pt-br": "Procurando a caixa de som que fugiu", en: "Hunting the speaker that wandered off" },
  player_control: { "pt-br": "Apertando o botão (o certo, dessa vez)", en: "Pressing the button (the right one)" },
  player_queue_control: { "pt-br": "Mexendo na fila com cuidado", en: "Rearranging the queue carefully" },

  // leitura — catálogo
  search_spotify: { "pt-br": "Vasculhando o catálogo inteiro por uma linha", en: "Digging the whole catalog for one line" },
  get_related_artists: { "pt-br": "Puxando o fio até o artista vizinho", en: "Pulling the thread to the next artist" },
  get_artist: { "pt-br": "Lendo a biografia oficial (com fonte)", en: "Reading the official bio (sourced)" },
  get_several_artists: { "pt-br": "Montando a ficha de cada um", en: "Filling out the index cards" },
  get_several_tracks: { "pt-br": "Montando a ficha de cada faixa", en: "Filling out the track cards" },
  get_recommendations: { "pt-br": "Testando combinações no balcão", en: "Testing combos at the counter" },
  new_releases: { "pt-br": "Verificando o que acabou de sair", en: "Checking what just dropped" },

  // ferramentas de servidor
  enrich_tracks: { "pt-br": "Colocando ficha catalográfica nas faixas", en: "Filing the proper index cards" },
  lyrics_lookup: { "pt-br": "Lendo a letra antes de julgar", en: "Reading the lyrics before judging" },
  lyrics_bulk: { "pt-br": "Lendo as letras todas antes de julgar", en: "Reading all the lyrics before judging" },
  similar_artists: { "pt-br": "Procurando o parentesco sonoro", en: "Looking for the sonic next of kin" },
  artist_info: { "pt-br": "Conferindo a versão da Last.fm", en: "Checking the Last.fm take" },
  chart_lookup: { "pt-br": "Olhando o placar", en: "Checking the scoreboard" },
  image_search: { "pt-br": "Procurando uma capa que aguente o close", en: "Finding a cover that survives a zoom" },
  prepare_cover: { "pt-br": "Ajustando o enquadramento", en: "Framing it properly" },
  weekly_report: { "pt-br": "Fechando a semana em revista", en: "Wrapping up the week" },
  web_search: { "pt-br": "Saindo para a rua perguntar a alguém", en: "Stepping out to ask someone" },

  // mutação — o sabor aparece DURANTE a execução; o pedido de confirmação
  // continua sóbrio (BRAND-VOICE.md §12.5)
  create_playlist: { "pt-br": "Montando a playlist nova (com etiqueta)", en: "Building a new playlist (with a label)" },
  add_tracks: { "pt-br": "Arrumando as faixas na estante", en: "Shelving the tracks" },
  remove_tracks: { "pt-br": "Tirando com cuidado", en: "Taking them out carefully" },
  replace_playlist_tracks: { "pt-br": "Trocando o repertório inteiro", en: "Swapping the whole setlist" },
  set_playlist_details: { "pt-br": "Reescrevendo a descrição bonitinha", en: "Rewriting the description nicely" },
  set_playlist_cover: { "pt-br": "Colando a capa", en: "Pasting the cover on" },
  undo_last_mutation: { "pt-br": "Voltando atrás (o botão mais subestimado)", en: "Undoing (the most underrated button)" },
};

/** Pool de reserva para ferramenta desconhecida (catálogo evolui sem avisar a UI). */
export const TOOL_FLAVOR_FALLBACK = {
  "pt-br": ["Mexendo nos discos", "Procurando na prateleira", "Consultando o arquivo"],
  en: ["Fiddling with the records", "Checking the shelf", "Consulting the archive"],
};

/** Linha de sabor de uma tool no locale atual; nunca devolve vazio. */
export function toolFlavor(name) {
  const locale = appLocale();
  const entry = TOOL_FLAVOR[String(name || "")];
  if (entry) return entry[locale] || entry.en;
  return pick(TOOL_FLAVOR_FALLBACK[locale] || TOOL_FLAVOR_FALLBACK.en);
}

// --- Dicas sob o status — BRAND-VOICE.md §8, ideia 5 -----------------------
// Cada linha ensina um recurso QUE EXISTE. Se o recurso sumir do produto, a
// dica sai daqui no mesmo commit — dica mentirosa é pior que spinner mudo.
export const TIPS = {
  "pt-br": [
    "Dica: `Parar` interrompe a resposta sem alterar nada.",
    "Dica: dá para desfazer a última mudança de playlist.",
    "Dica: a busca na web funciona sem Docker — sem SearXNG ela cai no DuckDuckGo.",
    "Dica: o mesmo agente está exposto como MCP em 127.0.0.1:8337/mcp.",
    "Dica: cada assunto pode ter a própria conversa na barra lateral.",
    "Dica: edite sua mensagem e envie — eu refaço a partir dela.",
    "Dica: `Regerar` pede outra versão da última resposta.",
    "Dica: quando eu inferir em vez de consultar, marco como \"inferido\".",
    "Dica: nenhuma playlist muda sem a sua confirmação.",
    "Dica: ligue `Debug` para ver o nome cru de cada ferramenta nos cartões.",
    "Dica: dá para separar um modelo mais barato só para sugerir os próximos passos.",
    "Dica: `Máx. passos de tool` limita quantas ferramentas eu chamo por resposta.",
    "Dica: `Turnos de histórico` controla quantas mensagens antigas eu releio.",
    "Dica: dá para apontar o Euterpe para um modelo rodando na sua máquina.",
    "Dica: com `always_enable_devtools=1` no spicetify, o console abre com Ctrl+Shift+I.",
    "Dica: `GET /probe` grava um raio-x das APIs internas do Spotify em disco.",
  ],
  en: [
    "Tip: `Stop` interrupts the answer without changing anything.",
    "Tip: you can undo the last playlist change.",
    "Tip: web search works without Docker — without SearXNG it falls back to DuckDuckGo.",
    "Tip: the same agent is exposed as MCP at 127.0.0.1:8337/mcp.",
    "Tip: each subject can have its own conversation in the sidebar.",
    "Tip: edit your message and send — I redo it from there.",
    "Tip: `Regenerate` asks for another take on the last answer.",
    "Tip: when I infer instead of looking it up, I label it \"inferred\".",
    "Tip: no playlist changes without your confirmation.",
    "Tip: turn on `Debug` to see each tool's raw name on the cards.",
    "Tip: you can point a cheaper model at the follow-up suggestions only.",
    "Tip: `Max tool steps` caps how many tools I call per answer.",
    "Tip: `History turns` controls how many old messages I re-read.",
    "Tip: you can point Euterpe at a model running on your own machine.",
    "Tip: with `always_enable_devtools=1` in spicetify, the console opens with Ctrl+Shift+I.",
    "Tip: `GET /probe` writes an X-ray of Spotify's internal APIs to disk.",
  ],
};

/** Dica no locale atual, evitando repetir `avoid`. */
export function tip(avoid) {
  return pick(TIPS[appLocale()] || TIPS.en, avoid);
}
