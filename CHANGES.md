# Euterpe — Changes

Documentation of the audit, requested changes and implementation plan for the
"i18n + English-only comments/prompts + clean code" refactor.

## Requested changes

1. Use multiple agents to help resolve the issues.
2. Avoid hard-coded pre-written reply texts as much as possible; where a
   fallback is unavoidable, route it through the locale system (point 2).
3. Locale system for every interface-facing text: **en** (default) and
   **pt-br**, resolved from the Spotify configuration.
4. All prompt engineering / model guidelines in **English**; all code comments
   in **English only**.
5. General clean-code review of the implementation and adjustments following
   best practices.

## Audit findings

### i18n
Every interface string across the stack was hard-coded Brazilian Portuguese:

| Layer | Hard-coded PT strings |
|---|---|
| `app/euterpe-app/index.js` | All UI copy (buttons, statuses, empty state, placeholder, error message, header subtitle, session title fallback) |
| `app/euterpe-extension/euterpe.js` | "agente desconectado", `tool_nao_implementada`, debug strings |
| `agent/src/*.ts` | `TOOL_LABELS`, status details ("Analisando…"), fallback replies, `summarize()` proposal titles, "mensagem inválida", logs |

Locale flow already exists partially: the extension reads
`Spicetify.Locale.getLocale()` and sends it to the agent in the `hello`
handshake (`locale`). Missing: an `en`/`pt-br` dictionary with a `t(key)`
helper in each layer, `en` as default.

### Prompts reaching the model that were in Portuguese
- `FORCE_ANSWER_MSG` (system instruction injected on rate-limit) — rewritten to English.
- Routing context message (`Agora tocando: …`) — rewritten to `Now playing: …`.
- Two Portuguese fragments inside `SUGGESTIONS_PROMPT` — rewritten.
- `LANGUAGE_RULE` is now locale-driven: the model answers in English (default)
  or Brazilian Portuguese depending on the Spotify locale.

### Portuguese comments
Catalogued 42 Portuguese comments across `index.js` (16), `agent.ts` (16),
`euterpe.js` (1), `protocol.ts` (1), `logging.ts` (1) and tests (7). All
translated to English.

### Clean-code review (16 findings, 5 real defects)
- C1 — Concurrent WebSocket messages interleave (agent) → per-connection message queue.
- C2 — Impure React `setSessions` updater in `closeSession` → compute outside the updater.
- C3 — App can get stuck on "extension not loaded" if the extension mounts after → poll for `window.euterpe`.
- C4 — `/sessions` reports file size as "events" → count JSONL lines.
- C5 — `weeklyReport` crashes when saved-tracks fetch fails → guard with `Array.isArray`.
- C6 — Stale-socket reconnect race in the extension → identity guard on handlers.
- C7 — `_debug` scaffolding shipped inside `get_playlists` results → removed.
- C8 — Triple tool-result logging in `runAgentLoop` → merged.
- C9 — Duplicated track mapping in `execSpotifyTool` → `mapTrack` helper.
- C10 — Magic numbers → named constants.
- C11 — `ServerMessage` index signature defeats typing → typed optional fields.
- C12 — `CURATION_HINTS` Portuguese-only + loose `"termin"` stem → bilingual + word boundary.
- C13 — UI logic coupled to strings (`status === "conectando…"`, `tool.replace("usando ", "")`) → boolean state + clean tool payload.
- C14 — Inconsistent suggestion length limits → aligned on 60.
- C15 — Test harness boilerplate duplicated ×3 → left as-is (risk/reward), PT mock strings translated.
- C16 — Dead protocol fields (`undo.request`, `cover.select`, `chat.done.text`) → removed/cleaned.

## Implementation plan

- **Phase 1 — Agent** (`agent/src/i18n.ts` new; `agent.ts`, `index.ts`,
  `protocol.ts`, `config.ts`, `db.ts`, `logging.ts`, `tools/server.ts`):
  dictionary + `t()` helper, English prompts, localized status/fallback/proposal
  strings, WS message queue, typed protocol, dead-code cleanup, constants.
- **Phase 2 — Extension** (`app/euterpe-extension/euterpe.js`): localize
  notification strings, socket identity guard, drop `_debug`, `mapTrack`
  helper, named constants.
- **Phase 3 — App** (`app/euterpe-app/index.js`): full i18n (en default,
  pt-br), pure React updaters, `window.euterpe` polling, `connecting` boolean,
  drop string-coupled logic.
- **Phase 4 — Tests**: comments/mocks in English.
- **Phase 5 — Validation**: typecheck, test suite, smoke tests (normal +
  rate-limited), reinstall, restart.
