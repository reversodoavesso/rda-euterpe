import OpenAI from "openai";
import type Database from "better-sqlite3";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { clientTools, serverTools, allToolSchemas } from "./tools/defs.js";
import { runServerTool, type ServerToolContext } from "./tools/server.js";
import { getHistory, saveMessage } from "./db.js";
import { logSession, logToolCall } from "./logging.js";
import { AGENT_STRINGS, makeT, normalizeLocale, type Translator } from "./i18n.js";
import type { ServerMessage, ToolCallRequest } from "./protocol.js";

/* ============================================================
   Constants
   ============================================================ */

const STREAM_CHUNK_CHARS = 40;
export const STREAM_DELAY_MS = 20;
const LLM_TIMEOUT_MS = 120_000;
const SUGGESTIONS_TIMEOUT_MS = 10_000;
export const SUGGESTIONS_MAX_TOKENS = 800;
/** Safety ceiling for the final answer (chars). The prompt asks for
    conciseness; this cap prevents huge dumps in degraded states. */
export const MAX_FINAL_LENGTH = 4000;

/** System instruction injected when the Spotify tools are throttled
    (2x rate_limited): forces an answer without tools, short and objective. */
export const FORCE_ANSWER_MSG =
  "The Spotify tools are temporarily throttled (rate_limited). Do not call any more tools. Answer the user now with what you already have, CONCISE and objective (max ~1500 characters), and explain that Spotify is currently limiting queries. Answer in the language of the conversation.";

/* ============================================================
   Prompts (English by convention — the model answers in the
   user's language via LANGUAGE_RULE)
   ============================================================ */

function LANGUAGE_RULE(locale?: string): string {
  const target = normalizeLocale(locale) === "pt-br" ? "Brazilian Portuguese" : "English";
  return `Always reply in ${target}. If the user writes in another language, reply in that language. Give a per-track justification whenever you recommend songs.`;
}

export function buildSystemPrompt(locale?: string): string {
  return `You are Euterpe, an agentic music curation assistant that runs inside Spotify desktop.

HOW TO BEHAVE
- Read the user's data (playlists, saved tracks, top artists/tracks) using the Spotify tools.
- Be concise: short paragraphs and only the most relevant items; never dump long exhaustive listings unless the user explicitly asks for a full list. Prefer a summary + the top 5-8 items.
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

/* ============================================================
   Follow-up suggestions (dynamic quick replies)
   - A separate lightweight call generates 3 reply options.
   - Never breaks the flow: any failure returns [] and the app falls back.
   ============================================================ */

export const SUGGESTIONS_PROMPT = (locale?: string): string => `You are Euterpe's follow-up suggestor. Based on the conversation, propose 3 short follow-up actions the user can take next, as if they were clickable buttons to continue the chat.
Rules:
- Return ONLY a JSON object in this exact shape: {"suggestions": ["suggestion 1", "suggestion 2", "suggestion 3"]} with exactly 3 strings.
- Each suggestion must be concrete and specific to THIS conversation (reference names, tracks, artists or playlists mentioned), actionable, and understandable without reading the whole chat.
- Max 60 characters each.
- ${locale ? `Reply in the language of the conversation (${locale}).` : "Reply in the same language as the conversation (default English)."}
- Never use generic filler (e.g. "How can I help further?" / "Anything else I can help with?").
- Never use the {{spotify:...}} template, markdown or emojis in the suggestions.
- No preamble, no code fences — only the JSON object.`;

/** Sanitizes the model's response and extracts an array of strings (tolerant
    of code fences, {suggestions: [...]} wrappers, trailing commas and leaked
    {{spotify:...}} templates). Pure — testable without the API. */
export function parseSuggestions(raw: string): string[] {
  try {
    let s = String(raw || "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return [];
    s = s.slice(start, end + 1);
    s = s.replace(/,\s*([\]}])/g, "$1"); // trailing commas
    const arr: unknown = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((item): item is string => typeof item === "string")
      .map((item) =>
        item
          .replace(/\{\{\s*spotify:[^}|]+\|([^}]*?)\s*\}\}/g, "$1") // becomes the label
          .replace(/\{\{[^}]*\}\}/g, "")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter((item) => item.length > 0 && item.length <= 60)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Trims the answer at a safe boundary: never mid a {{spotify:...}} template
    and preferring a paragraph boundary. Pure — testable. */
export function trimFinal(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  let cut = text.slice(0, max);
  const open = cut.lastIndexOf("{{");
  const close = cut.lastIndexOf("}}");
  if (open > close) {
    cut = cut.slice(0, open); // inside a template: cut before it
  }
  const nl = cut.lastIndexOf("\n\n");
  const sp = cut.lastIndexOf(" ");
  const boundary = Math.max(nl, sp);
  if (boundary >= max * 0.5) cut = cut.slice(0, boundary);
  return cut.trimEnd() + "…";
}

function friendlyToolLabel(name: string, t: Translator): string {
  return AGENT_STRINGS[`tool.${name}`] ? t(`tool.${name}`) : t("status.working");
}

async function generateSuggestions(
  llm: OpenAI,
  history: ChatCompletionMessageParam[],
  userText: string,
  finalText: string,
  locale: string | undefined,
  sessionId: string
): Promise<string[]> {
  const t0 = Date.now();
  try {
    const resp = await llm.chat.completions.create(
      {
        model: config.chatModel,
        messages: [
          { role: "system", content: SUGGESTIONS_PROMPT(locale) },
          ...history.slice(-8),
          { role: "user", content: userText },
          { role: "assistant", content: finalText },
        ],
        max_tokens: SUGGESTIONS_MAX_TOKENS,
        temperature: 0.7,
        // JSON mode: guarantees a valid object even when the reasoning model
        // would burn the whole budget on reasoning_content alone.
        response_format: { type: "json_object" },
      },
      { signal: AbortSignal.timeout(SUGGESTIONS_TIMEOUT_MS) }
    );
    const raw = (resp.choices[0]?.message?.content as string | null) ?? "";
    const suggestions = parseSuggestions(raw);
    logSession(sessionId, "suggestions", { count: suggestions.length, latency_ms: Date.now() - t0 });
    return suggestions;
  } catch (err) {
    logSession(sessionId, "suggestions", {
      count: 0,
      error: String(err && (err as Error).message ? (err as Error).message : err),
      latency_ms: Date.now() - t0,
    });
    return [];
  }
}

export interface AgentDeps {
  send: (msg: ServerMessage) => void;
  requestClientTool: (call: ToolCallRequest) => Promise<{ ok: boolean; data?: unknown; code?: string }>;
  locale?: string;
}

const clientToolNames = new Set(clientTools.map((t) => t.function.name));
const serverToolNames = new Set(serverTools.map((t) => t.function.name));

/* Curated requests are routed to the stronger model. Kept bilingual so it
   works with both locales; "termin" uses a word boundary to avoid false
   positives (e.g. "determine"). */
const CURATION_HINTS = [
  "criar playlist",
  "crie uma playlist",
  "playlist de",
  "recomenda",
  "curadoria",
  "mood",
  "vibe",
  "tema",
  "término",
  "artistas similares",
  "artistas parecidos",
  "suger",
  "create playlist",
  "create a playlist",
  "playlist of",
  "recommend",
  "curat",
  "breakup",
  "similar artists",
  "suggest",
];

function isCurationRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\btermin/.test(lower)) return true;
  return CURATION_HINTS.some((h) => lower.includes(h));
}

export async function handleChat(
  deps: AgentDeps,
  db: Database.Database,
  sessionId: string,
  text: string
): Promise<void> {
  const { send } = deps;
  const t = makeT(AGENT_STRINGS, normalizeLocale(deps.locale));

  if (!config.deepseekApiKey) {
    const fallback = t("fallback.noApiKey");
    for (let i = 0; i < fallback.length; i += STREAM_CHUNK_CHARS) {
      send({ type: "chat.stream", sessionId, delta: fallback.slice(i, i + STREAM_CHUNK_CHARS) });
      await new Promise((r) => setTimeout(r, STREAM_DELAY_MS));
    }
    saveMessage(db, sessionId, "assistant", fallback);
    send({ type: "chat.done", sessionId, suggestions: [] });
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
  const llm = new OpenAI({ baseURL: config.llmBaseUrl, apiKey: config.deepseekApiKey });
  const { text: finalText, degraded } = await runAgentLoop(deps, db, sessionId, model, messages, llm, t);

  // Suggestions run in parallel with the streaming: while the chunks go out,
  // the model is already generating the pills. chat.done is only sent after
  // the last chunk AND the await.
  const suggestionsPromise =
    config.suggestionsEnabled && !degraded && finalText.trim().length > 0
      ? generateSuggestions(llm, history, text, finalText, deps.locale, sessionId)
      : Promise.resolve<string[]>([]);

  for (let i = 0; i < finalText.length; i += STREAM_CHUNK_CHARS) {
    send({ type: "chat.stream", sessionId, delta: finalText.slice(i, i + STREAM_CHUNK_CHARS) });
    // Natural streaming: a small interval between chunks so the answer "types"
    // smoothly instead of appearing all at once.
    await new Promise((r) => setTimeout(r, STREAM_DELAY_MS));
  }
  const suggestions = await suggestionsPromise;
  saveMessage(db, sessionId, "assistant", finalText);
  logSession(sessionId, "session.end", { final_length: finalText.length });
  send({ type: "chat.done", sessionId, suggestions });
}

async function runAgentLoop(
  deps: AgentDeps,
  db: Database.Database,
  sessionId: string,
  model: string,
  messages: ChatCompletionMessageParam[],
  llm: OpenAI,
  t: Translator
): Promise<{ text: string; degraded: boolean }> {
  const { send, requestClientTool } = deps;

  let steps = 0;
  let finalText = "";
  let degraded = false;
  const rateLimited = new Set<string>();
  let consecutiveRateLimited = 0;
  let forceAnswer = false;

  try {
    while (steps++ < config.maxToolSteps) {
      send({ type: "chat.status", sessionId, status: "thinking", detail: t("status.thinking") });
      const resp = await llm.chat.completions.create(
        {
          model,
          messages,
          tools: forceAnswer ? undefined : allToolSchemas,
          stream: false,
        },
        // The main loop must not hang forever: hard timeout. (The suggestions
        // call already has its own timeout.)
        { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }
      );

      const message = resp.choices[0]?.message;
      if (!message) {
        finalText = t("fallback.noAnswer");
        degraded = true;
        break;
      }
      // Diagnostics: the model "thinks" in reasoning_content (a separate field,
      // never shown to the user). Only the start of it is logged for debug.
      const reasoning = (message as { reasoning_content?: unknown }).reasoning_content;
      if (reasoning) {
        const rc = String(reasoning);
        logSession(sessionId, "llm.reasoning", { step: steps, chars: rc.length, preview: rc.slice(0, 300) });
      }

      if (message.tool_calls && message.tool_calls.length > 0 && !forceAnswer) {
        // NEVER send reasoning_content back to the API (DeepSeek recommends
        // not resending the reasoning field in follow-up calls).
        const { reasoning_content: _drop, ...cleanMessage } = message as ChatCompletionMessageParam & {
          reasoning_content?: unknown;
        };
        messages.push(cleanMessage);
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
            detail: config.debug ? name : friendlyToolLabel(name, t),
          });

          const t0 = Date.now();
          let result: { ok: boolean; data?: unknown; code?: string };
          if (forceAnswer) {
            // Rate-limit already hit in this batch: answer the remaining calls
            // with an error WITHOUT invoking the tools again — but still emit
            // the tool message, otherwise the API rejects with 400 (tool_calls
            // without a response).
            result = { ok: false, code: "rate_limited" };
          } else if (rateLimited.has(name)) {
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
          const content = result.ok
            ? JSON.stringify(result.data ?? {})
            : result.code === "rate_limited"
              ? JSON.stringify({ error: "rate_limited" })
              : config.debug
                ? JSON.stringify({ error: result.code })
                : JSON.stringify({ error: "tool_failed" });
          logToolCall(sessionId, name, args, result.ok, result.code, Date.now() - t0);
          logSession(sessionId, "tool.result", {
            name,
            ok: result.ok,
            code: result.code,
            size,
            duration_ms: Date.now() - t0,
            preview: content.slice(0, 400),
          });
          messages.push({ role: "tool", tool_call_id: call.id, content });

          if (consecutiveRateLimited >= 2 && !forceAnswer) {
            forceAnswer = true;
            degraded = true;
            // No break here: the rest of the batch is answered as rate_limited
            // above, preserving the tool_calls ↔ tool messages pairing.
          }
        }
        if (forceAnswer) {
          messages.push({ role: "system", content: FORCE_ANSWER_MSG });
        }
        continue;
      }

      finalText = (message.content as string | null) ?? "";
      logSession(sessionId, "llm.final", { step: steps, length: finalText.length });
      break;
    }
  } catch (err) {
    // Never leave the conversation hanging: API timeout or network error become
    // a graceful reply (with chat.done) instead of an endless "analyzing…".
    const detail = String(err && (err as Error).message ? (err as Error).message : err);
    logSession(sessionId, "llm.error", { step: steps, error: detail });
    finalText = t("fallback.llmError");
    degraded = true;
  }

  if (!finalText && steps >= config.maxToolSteps) {
    finalText = t("fallback.stepLimit");
    degraded = true;
  }
  return { text: trimFinal(finalText, MAX_FINAL_LENGTH), degraded };
}

export function buildRoutingPrompt(locale?: string): string {
  return `You are Euterpe's router. The user is listening to a song right now. Your task: decide whether it fits into any of the user's playlists. Use get_playlists to see the list. If it fits, call add_tracks (the user confirms the addition). If it does not fit any, answer with at most one line saying it does not fit. ${LANGUAGE_RULE(locale)} Reply briefly.`;
}

export async function handleSongChange(
  deps: AgentDeps,
  db: Database.Database,
  uri: string
): Promise<void> {
  if (!config.autoRouting || !config.deepseekApiKey) return;
  const { send, requestClientTool } = deps;
  const t = makeT(AGENT_STRINGS, normalizeLocale(deps.locale));
  const sessionId = "routing";
  logSession(sessionId, "songchange.start", { uri });

  const tr = await requestClientTool({
    id: `sc_${uri}`,
    name: "get_several_tracks",
    args: { ids: [String(uri).split(":").pop()] },
  });
  if (!tr.ok || !Array.isArray(tr.data) || !tr.data[0]) return;
  const track = tr.data[0] as { name: string; artists?: string[] };
  const text = `Now playing: "${track.name}"${track.artists?.length ? ` by ${track.artists.join(", ")}` : ""}.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildRoutingPrompt(deps.locale) },
    { role: "user", content: text },
  ];
  const llm = new OpenAI({ baseURL: config.llmBaseUrl, apiKey: config.deepseekApiKey });
  const { text: finalText } = await runAgentLoop(deps, db, sessionId, config.chatModel, messages, llm, t);
  send({ type: "chat.stream", sessionId, delta: finalText });
  send({ type: "chat.done", sessionId });
}
