// i18n da interface — strings visíveis ao usuário.
//
// Default: en. Resolvido pelo locale do Spotify (pt-br quando a UI está em
// português do Brasil). As chaves antigas são preservadas sem mudança de texto:
// a UI não pode regredir por causa da refatoração.
export const UI_STRINGS = {
  "session.new": { en: "Conversation", "pt-br": "Conversa" },
  "chip.artistTitle": { en: "Open artist page in Spotify", "pt-br": "Abrir página do artista no Spotify" },
  "chip.play": { en: "Play", "pt-br": "Tocar" },
  "chip.open": { en: "Open in Spotify", "pt-br": "Abrir no Spotify" },
  "code.copy": { en: "copy", "pt-br": "copiar" },
  "status.connected": { en: "connected", "pt-br": "conectado" },
  "status.disconnected": { en: "disconnected", "pt-br": "desconectado" },
  "status.connecting": { en: "connecting…", "pt-br": "conectando…" },
  "status.sending": { en: "sending…", "pt-br": "enviando…" },
  "status.cleared": { en: "conversation cleared", "pt-br": "conversa limpa" },
  "status.stopped": { en: "stopped", "pt-br": "interrompido" },
  "status.thinking": { en: "thinking…", "pt-br": "pensando…" },
  "header.connected": { en: "connected to agent", "pt-br": "conectado ao agente" },
  "header.connectedVersion": { en: "connected to agent · v{version}", "pt-br": "conectado ao agente · v{version}" },
  "error.extensionNotLoaded": {
    en: "The 'euterpe.js' extension is not loaded. Install it in the spicetify Extensions folder and reopen Spotify.",
    "pt-br": "A extension 'euterpe.js' não está carregada. Instale-a na pasta Extensions do spicetify e reabra o Spotify.",
  },
  "action.clear": { en: "Clear conversation", "pt-br": "Limpar conversa" },
  "action.clearTitle": { en: "Delete this conversation's messages", "pt-br": "Apagar as mensagens desta conversa" },
  "action.closeSession": { en: "Close session", "pt-br": "Fechar sessão" },
  "action.newSession": { en: "New conversation", "pt-br": "Nova conversa" },
  "empty.title": { en: "Your music assistant", "pt-br": "Seu assistente musical" },
  "empty.subtitle": {
    en: "Ask about playlists, artists, moods and releases — after each answer, Euterpe suggests next steps.",
    "pt-br": "Pergunte sobre playlists, artistas, mood e lançamentos — depois de cada resposta, o Euterpe sugere os próximos passos.",
  },
  "action.confirm": { en: "Confirm", "pt-br": "Confirmar" },
  "action.cancel": { en: "Cancel", "pt-br": "Cancelar" },
  "input.placeholder": {
    en: "e.g. take the artists from my playlist X and find breakup songs…",
    "pt-br": "Ex.: pega os artistas da minha playlist X e busca músicas de término…",
  },
  "action.send": { en: "Send", "pt-br": "Enviar" },

  // --- Chat robusto (Fase 6) ---
  "action.stop": { en: "Stop", "pt-br": "Parar" },
  "action.copy": { en: "Copy", "pt-br": "Copiar" },
  "action.copied": { en: "Copied to clipboard", "pt-br": "Copiado para a área de transferência" },
  "action.regenerate": { en: "Regenerate", "pt-br": "Regenerar" },
  "action.edit": { en: "Edit", "pt-br": "Editar" },
  "action.goToEnd": { en: "Go to the end", "pt-br": "Ir para o fim" },
  "action.settings": { en: "Settings", "pt-br": "Configurações" },
  "edit.hint": { en: "Editing a message — sending replaces it.", "pt-br": "Editando uma mensagem — enviar substitui a original." },
  "edit.cancel": { en: "Cancel edit", "pt-br": "Cancelar edição" },
  "tool.running": { en: "running", "pt-br": "executando" },
  "tool.ok": { en: "done", "pt-br": "concluída" },
  "tool.interrupted": { en: "interrupted", "pt-br": "interrompida" },
  "tool.duration": { en: "{ms} ms", "pt-br": "{ms} ms" },
  "tool.args": { en: "Arguments", "pt-br": "Argumentos" },
  "proposal.added": { en: "{n} track(s) added", "pt-br": "{n} faixa(s) adicionada(s)" },
  "proposal.removed": { en: "{n} track(s) removed", "pt-br": "{n} faixa(s) removida(s)" },
  "proposal.replace": { en: "Replaces the whole playlist with {n} track(s)", "pt-br": "Substitui a playlist inteira por {n} faixa(s)" },
  "proposal.change": { en: "Change", "pt-br": "Mudança" },
  "error.title": { en: "Error", "pt-br": "Erro" },

  // --- Setup (providers/modelos/chaves) ---
  "settings.title": { en: "Euterpe setup", "pt-br": "Setup do Euterpe" },
  "settings.close": { en: "Close", "pt-br": "Fechar" },
  "settings.tabSetup": { en: "Providers", "pt-br": "Providers" },
  "settings.tabMcp": { en: "MCP", "pt-br": "MCP" },
  "settings.loading": { en: "Loading…", "pt-br": "Carregando…" },
  "settings.unavailable": { en: "Daemon unavailable at {url}", "pt-br": "Daemon indisponível em {url}" },
  "settings.active": { en: "active", "pt-br": "ativo" },
  "settings.use": { en: "Use", "pt-br": "Usar" },
  "settings.test": { en: "Test", "pt-br": "Testar" },
  "settings.testing": { en: "Testing…", "pt-br": "Testando…" },
  "settings.latency": { en: "{ms} ms", "pt-br": "{ms} ms" },
  "settings.key": { en: "API key", "pt-br": "Chave da API" },
  "settings.keyPlaceholder": { en: "paste the key", "pt-br": "cole a chave" },
  "settings.saveKey": { en: "Save key", "pt-br": "Salvar chave" },
  "settings.removeKey": { en: "Remove key", "pt-br": "Remover chave" },
  "settings.keySet": { en: "key saved", "pt-br": "chave salva" },
  "settings.keyMissing": { en: "no key", "pt-br": "sem chave" },
  "settings.model": { en: "Model", "pt-br": "Modelo" },
  "settings.refreshModels": { en: "Load models", "pt-br": "Carregar modelos" },
  "settings.behaviour": { en: "Behaviour", "pt-br": "Comportamento" },
  "settings.mutationPolicy": { en: "Mutation policy", "pt-br": "Política de mutação" },
  "settings.webSearch": { en: "Web search", "pt-br": "Busca na web" },
  "settings.suggestions": { en: "Suggestions", "pt-br": "Sugestões" },
  "settings.autoRouting": { en: "Auto routing", "pt-br": "Roteamento automático" },
  "settings.debug": { en: "Debug", "pt-br": "Debug" },
  "settings.chatHistoryTurns": { en: "History turns", "pt-br": "Turnos de histórico" },
  "settings.maxToolSteps": { en: "Max tool steps", "pt-br": "Máx. passos de tool" },
  "settings.on": { en: "on", "pt-br": "ligado" },
  "settings.off": { en: "off", "pt-br": "desligado" },
  "settings.saved": { en: "saved", "pt-br": "salvo" },

  // --- MCP ---
  "mcp.title": { en: "MCP server", "pt-br": "Servidor MCP" },
  "mcp.chip": { en: "MCP active · {clients} client(s)", "pt-br": "MCP ativo · {clients} cliente(s)" },
  "mcp.offline": { en: "MCP unavailable", "pt-br": "MCP indisponível" },
  "mcp.url": { en: "URL", "pt-br": "URL" },
  "mcp.opencode": { en: "opencode", "pt-br": "opencode" },
  "mcp.claude": { en: "claude-code", "pt-br": "claude-code" },
  "mcp.stdio": { en: "json (stdio)", "pt-br": "json (stdio)" },
  "mcp.help": {
    en: "Register this endpoint in your MCP client. The server exposes the spotify_* tools and the euterpe:// resources.",
    "pt-br": "Registre este endpoint no seu cliente MCP. O servidor expõe as tools spotify_* e os recursos euterpe://.",
  },
};

export function normalizeLocale(raw) {
  const lang = String(raw || "").split("-")[0].trim().toLowerCase();
  return lang === "pt" ? "pt-br" : "en";
}

export function appLocale() {
  try {
    if (Spicetify && Spicetify.Locale && typeof Spicetify.Locale.getLocale === "function") {
      const l = Spicetify.Locale.getLocale();
      if (l) return normalizeLocale(l);
    }
  } catch (err) {}
  try {
    return normalizeLocale(navigator.language);
  } catch (err) {}
  return "en";
}

export const tr = (key, vars) => {
  const entry = UI_STRINGS[key];
  let out = (entry && (entry[appLocale()] ?? entry.en)) || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
};
