import OpenAI from "openai";
import type Database from "better-sqlite3";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { clientTools, serverTools, allToolSchemas } from "./tools/defs.js";
import { runServerTool, type ServerToolContext } from "./tools/server.js";
import { getHistory, saveMessage } from "./db.js";
import { logSession, logToolCall } from "./logging.js";
import type { ServerMessage, ToolCallRequest } from "./protocol.js";

const LANGUAGE_RULE = (locale?: string): string => {
  if (locale) {
    return `Always reply in the language configured in the Spotify app (${locale}). If the user writes in another language, reply in that language. Give a per-track justification whenever you recommend songs.`;
  }
  return `Always reply in the language the user writes in (default: Brazilian Portuguese). Be clear and give a per-track justification whenever you recommend songs.`;
};

function buildSystemPrompt(locale?: string): string {
  return `You are Euterpe, an agentic music curation assistant that runs inside Spotify desktop.

HOW TO BEHAVE
- Read the user's data (playlists, saved tracks, top artists/tracks) using the Spotify tools.
- Prefer batch tools (arrays of ids) for large collections; never loop over single calls.
- For similar artists use get_related_artists (Spotify) and complement with similar_artists/web_search when data is missing.
- For artist info/biography: use get_artist (official metadata: genres, popularity, followers, image) and artist_info (Last.fm biography, source marked as "lastfm"; falls back to web_search). Declare the source when answering.
- Use lyrics_lookup to judge theme/mood from lyrics. If the lyrics are not found anywhere, say explicitly that you could not find them and, if needed, INFER from title+genre+audio features, always labeling it as "inferred".
- Use web_search as a generic fallback for trends, releases, cultural context, or when a specific tool fails.
- If a tool fails, try at most 1 generic alternative; then answer with what you have and declare the data source.
- Never invent data, tracks, or lyrics.
- To create or edit playlists, DO NOT run on your own: present the proposal in chat (name, description, tracks with per-track justification) and then call the mutation tool (e.g. create_playlist, add_tracks). The mutation will be confirmed by the user.
- Context: if the user refers to a playlist/track you mentioned before (e.g. ".witness", "the karaoke playlist"), use the known URI from history and call get_playlist_tracks directly — do NOT search the web nor homonymous albums from other artists. Only use web_search when local context is not enough.

COMPONENT TEMPLATES (the app renders these as native Spotify components)
When mentioning tracks, playlists, albums or artists, ALWAYS use the component template {{spotify:type:uri|Label}} with the real uri returned by the tools:
- Track:     {{spotify:track:4cOdK2wGLETKBW3PvgPWqT|Creep}}
- Playlist:  {{spotify:playlist:37i9dQZF1DXcBWIGoYBM5M|Today's Top Hits}}
- Album:     {{spotify:album:5ZP1VrnD6vVdHIZ8XWYlY4|A Night at the Opera}}
- Artist:    {{spotify:artist:0TnOYISbd1XYRBk9myaseg|Pixies}}
The app renders each one as a chip with the native Spotify icon (play/playlist/album/artist) that plays or opens the item when clicked. Never write a bare id and never use emojis (like ▶️/🎵) to represent music — always the template. Artist names MUST always be wrapped in the artist template above so they become links to the artist's Spotify page.

OUTPUT TEMPLATES (follow these shapes to get the best rendering)

1) Recommendation list — one bullet per track, with per-track justification:
**1. {{spotify:track:URI|Track name}}** — {{spotify:artist:URI|Artist name}}
> _Why it fits_: one sentence (theme, mood, genre, lyrics, source).

2) Similar artists — bullets with reason/source:
- {{spotify:artist:URI|Artist name}} — similar via <source> (genre, sound, etc.)
(limit to the most relevant 5–8)

3) User playlists listing:
- {{spotify:playlist:URI|Playlist name}} — N tracks

4) Playlist creation proposal — show before calling the mutation tool:
**Proposal: "Playlist name"** — <description>
1. {{spotify:track:URI|Track}} — {{spotify:artist:URI|Artist}} — <per-track justification>
...

Formatting: use markdown (bold **, italic *, lists -, quotes >, fenced code \`\`\`) and the component templates above. Do not use emojis in general.
${LANGUAGE_RULE(locale)}

${config.debug
  ? `DEBUG MODE ON: you MAY include technical details at the end of the answer (error codes, tool names, exception messages), but answer the essential part in plain language first.`
  : `NEVER expose technical details in the final answer: no error codes, no internal tool names, no JSON, no exception messages. If a tool fails, explain simply and friendly what you could not do and suggest an alternative (e.g. "I could not access your playlists right now, try again in a moment"). If a tool answers "rate_limited", do NOT call it again in this conversation; say in a friendly way that Spotify is limiting queries right now and suggest trying again in a few minutes.`}`;
}

const TOOL_LABELS: Record<string, string> = {
  get_playlists: "lendo suas playlists…",
  get_playlist_tracks: "lendo faixas da playlist…",
  get_saved_tracks: "lendo músicas salvas…",
  get_top_artists: "analisando seus artistas…",
  get_top_tracks: "analisando suas músicas…",
  search_spotify: "procurando no Spotify…",
  get_related_artists: "buscando artistas relacionados…",
  get_artist: "buscando informações do artista…",
  get_recommendations: "montando recomendações…",
  get_audio_features_bulk: "analisando características musicais…",
  get_several_artists: "buscando artistas…",
  get_several_tracks: "buscando faixas…",
  new_releases: "buscando lançamentos…",
  create_playlist: "criando playlist…",
  add_tracks: "adicionando faixas…",
  remove_tracks: "removendo faixas…",
  set_playlist_details: "atualizando playlist…",
  replace_playlist_tracks: "atualizando faixas…",
  set_playlist_cover: "atualizando capa…",
  web_search: "pesquisando na web…",
  similar_artists: "buscando artistas similares…",
  artist_info: "buscando biografia do artista…",
  enrich_tracks: "enriquecendo dados das faixas…",
  lyrics_bulk: "buscando letras…",
  lyrics_lookup: "buscando letra…",
  chart_lookup: "consultando rankings…",
  image_search: "procurando imagens…",
  weekly_report: "gerando relatório…",
  prepare_cover: "preparando capa…",
  undo_last_mutation: "desfazendo alteração…",
};

function friendlyToolLabel(name: string): string {
  return TOOL_LABELS[name] || "trabalhando…";
}

export interface AgentDeps {
  send: (msg: ServerMessage) => void;
  requestClientTool: (call: ToolCallRequest) => Promise<{ ok: boolean; data?: unknown; code?: string }>;
  locale?: string;
}

const clientToolNames = new Set(clientTools.map((t) => t.function.name));
const serverToolNames = new Set(serverTools.map((t) => t.function.name));

const CURATION_HINTS = [
  "criar playlist",
  "crie uma playlist",
  "playlist de",
  "recomenda",
  "curadoria",
  "mood",
  "vibe",
  "tema",
  "termin",
  "término",
  "artistas similares",
  "artistas parecidos",
  "suger",
];

function isCurationRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return CURATION_HINTS.some((h) => lower.includes(h));
}

export async function handleChat(
  deps: AgentDeps,
  db: Database.Database,
  sessionId: string,
  text: string
): Promise<void> {
  const { send } = deps;

  if (!config.deepseekApiKey) {
    send({
      type: "chat.done",
      sessionId,
      text: "Configure DEEPSEEK_API_KEY no agent/.env para o agente responder.",
    });
    return;
  }

  const history: ChatCompletionMessageParam[] = [];
  if (config.chatHistoryTurns > 0) {
    history.push(
      ...getHistory(db, sessionId, config.chatHistoryTurns).map(
        (m): ChatCompletionMessageParam => ({ role: m.role as "user" | "assistant", content: m.content })
      )
    );
  }
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(deps.locale) },
    ...history,
    { role: "user", content: text },
  ];

  saveMessage(db, sessionId, "user", text);
  const model = isCurationRequest(text) ? config.curationModel : config.chatModel;
  logSession(sessionId, "session.start", { text, model });
  const finalText = await runAgentLoop(deps, db, sessionId, model, messages);

  for (let i = 0; i < finalText.length; i += 40) {
    send({ type: "chat.stream", sessionId, delta: finalText.slice(i, i + 40) });
  }
  saveMessage(db, sessionId, "assistant", finalText);
  logSession(sessionId, "session.end", { final_length: finalText.length });
  send({ type: "chat.done", sessionId, text: "" });
}

async function runAgentLoop(
  deps: AgentDeps,
  db: Database.Database,
  sessionId: string,
  model: string,
  messages: ChatCompletionMessageParam[]
): Promise<string> {
  const { send, requestClientTool } = deps;
  const llm = new OpenAI({ baseURL: config.llmBaseUrl, apiKey: config.deepseekApiKey });

  let steps = 0;
  let finalText = "";
  const rateLimited = new Set<string>();
  let consecutiveRateLimited = 0;
  let forceAnswer = false;

  while (steps++ < config.maxToolSteps) {
    send({ type: "chat.status", sessionId, status: "thinking", detail: "analisando…" });
    const resp = await llm.chat.completions.create({
      model,
      messages,
      tools: forceAnswer ? undefined : allToolSchemas,
      stream: false,
    });

    const message = resp.choices[0]?.message;
    if (!message) {
      finalText = "Não consegui gerar uma resposta.";
      break;
    }

    if (message.tool_calls && message.tool_calls.length > 0 && !forceAnswer) {
      messages.push(message as ChatCompletionMessageParam);
      logSession(sessionId, "llm.turn", {
        step: steps,
        tool_calls: message.tool_calls.map((c) => c.function.name),
      });
      for (const call of message.tool_calls) {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        send({
          type: "chat.status",
          sessionId,
          status: "tool",
          detail: config.debug ? `usando ${name}…` : friendlyToolLabel(name),
        });

        const t0 = Date.now();
        let result: { ok: boolean; data?: unknown; code?: string };
        if (rateLimited.has(name)) {
          result = { ok: false, code: "rate_limited" };
        } else if (clientToolNames.has(name)) {
          result = await requestClientTool({ id: call.id, name, args });
        } else if (serverToolNames.has(name)) {
          const ctx: ServerToolContext = { db, requestClientTool };
          result = await runServerTool(name, args, ctx);
        } else {
          result = { ok: false, code: `unknown_tool:${name}` };
        }
        if (!result.ok && result.code === "rate_limited") {
          rateLimited.add(name);
          consecutiveRateLimited += 1;
        } else {
          consecutiveRateLimited = 0;
        }
        const size = result.ok ? JSON.stringify(result.data ?? {}).length : 0;
        logToolCall(sessionId, name, args, result.ok, result.code, Date.now() - t0);
        logSession(sessionId, "tool.result", { name, ok: result.ok, code: result.code, size });

        const content = result.ok
          ? JSON.stringify(result.data ?? {})
          : result.code === "rate_limited"
            ? JSON.stringify({ error: "rate_limited" })
            : config.debug
              ? JSON.stringify({ error: result.code })
              : JSON.stringify({ error: "tool_failed" });
        logSession(sessionId, "tool.result", {
          name,
          ok: result.ok,
          code: result.code,
          size,
          preview: content.slice(0, 400),
        });
        messages.push({ role: "tool", tool_call_id: call.id, content });

        if (consecutiveRateLimited >= 2) {
          forceAnswer = true;
          messages.push({
            role: "system",
            content:
              "As ferramentas do Spotify estão temporariamente limitadas (rate_limited). Não chame mais nenhuma ferramenta. Responda agora ao usuário com o que você já tem, de forma completa, e explique que o Spotify está limitando as consultas no momento.",
          });
          break;
        }
      }
      continue;
    }

    finalText = (message.content as string | null) ?? "";
    logSession(sessionId, "llm.final", { step: steps, length: finalText.length });
    break;
  }

  if (!finalText && steps >= config.maxToolSteps) {
    finalText = "Atingi o limite de passos. Respondo com o que consegui até aqui — refinem o pedido se precisar.";
  }
  return finalText;
}

function buildRoutingPrompt(locale?: string): string {
  return `You are Euterpe's router. The user is listening to a song right now. Your task: decide whether it fits into any of the user's playlists. Use get_playlists to see the list. If it fits, call add_tracks (the user confirms the addition). If it does not fit any, answer with at most one line saying it does not fit. ${LANGUAGE_RULE(locale)} Reply briefly.`;
}

export async function handleSongChange(
  deps: AgentDeps,
  db: Database.Database,
  uri: string
): Promise<void> {
  if (!config.autoRouting || !config.deepseekApiKey) return;
  const { send, requestClientTool } = deps;
  const sessionId = "routing";
  logSession(sessionId, "songchange.start", { uri });

  const tr = await requestClientTool({
    id: `sc_${uri}`,
    name: "get_several_tracks",
    args: { ids: [String(uri).split(":").pop()] },
  });
  if (!tr.ok || !Array.isArray(tr.data) || !tr.data[0]) return;
  const track = tr.data[0] as { name: string; artists?: string[] };
  const text = `Agora tocando: "${track.name}"${track.artists?.length ? ` de ${track.artists.join(", ")}` : ""}.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildRoutingPrompt(deps.locale) },
    { role: "user", content: text },
  ];
  const finalText = await runAgentLoop(deps, db, sessionId, config.chatModel, messages);
  send({ type: "chat.stream", sessionId, delta: "🎵 " + finalText });
  send({ type: "chat.done", sessionId, text: "" });
}
