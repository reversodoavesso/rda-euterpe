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
  // --- Tom de voz (BRAND-VOICE.md §7) ---
  // status.thinking fica de fallback: em uso real a linha é preenchida pelo pool
  // rotativo de lib/voice.js (registro de Espera).
  "status.connected": { en: "connected", "pt-br": "conectado" },
  "status.disconnected": { en: "offline", "pt-br": "fora do ar" },
  "status.connecting": { en: "tuning in…", "pt-br": "sintonizando…" },
  "status.sending": { en: "handing the record over…", "pt-br": "passando o disco para ela…" },
  "status.cleared": { en: "conversation cleared", "pt-br": "conversa apagada" },
  "status.stopped": { en: "stopped. nothing was changed", "pt-br": "interrompida. nada foi alterado" },
  "status.thinking": { en: "thinking…", "pt-br": "pensando…" },
  "header.connected": { en: "connected to agent", "pt-br": "conectado ao agente" },
  "header.connectedVersion": { en: "connected to agent · v{version}", "pt-br": "conectado ao agente · v{version}" },
  "error.extensionNotLoaded": {
    en: "The 'euterpe.js' extension is not loaded. Install it in the spicetify Extensions folder and reopen Spotify.",
    "pt-br": "A extension 'euterpe.js' não está carregada. Instale-a na pasta Extensions do spicetify e reabra o Spotify.",
  },
  "action.clear": { en: "Delete conversation", "pt-br": "Apagar conversa" },
  "action.clearTitle": { en: "Delete this conversation's messages", "pt-br": "Apagar as mensagens desta conversa" },
  "action.closeSession": { en: "Close session", "pt-br": "Fechar sessão" },
  "action.newSession": { en: "New conversation", "pt-br": "Nova conversa" },
  "empty.title": { en: "The curator is on duty", "pt-br": "A curadora está de plantão" },
  "empty.subtitle": {
    en: "Ask for a playlist, a bridge between two artists, or what fits what's playing.",
    "pt-br": "Peça uma playlist, uma ponte entre dois artistas, ou o que combina com o que está tocando.",
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
  "tool.running": { en: "in progress", "pt-br": "em andamento" },
  "tool.ok": { en: "done", "pt-br": "pronta" },
  "tool.interrupted": { en: "left half-done", "pt-br": "deixada pela metade" },
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
  "settings.loading": { en: "Reading the setup…", "pt-br": "Lendo a configuração…" },
  "settings.unavailable": {
    en: "No answer at {url}. Start the daemon and try again.",
    "pt-br": "Ninguém atendeu em {url}. Suba o daemon e tente de novo.",
  },
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
  "mcp.chip": { en: "MCP active · {clients} agent(s) connected", "pt-br": "MCP ativo · {clients} agente(s) conectado(s)" },
  "mcp.offline": { en: "MCP is down — chat still works", "pt-br": "MCP fora do ar — o chat continua funcionando" },
  "mcp.url": { en: "URL", "pt-br": "URL" },
  "mcp.opencode": { en: "opencode", "pt-br": "opencode" },
  "mcp.claude": { en: "claude-code", "pt-br": "claude-code" },
  "mcp.stdio": { en: "json (stdio)", "pt-br": "json (stdio)" },
  "mcp.help": {
    en: "Register this endpoint in your MCP client. The server exposes the spotify_* tools and the euterpe:// resources.",
    "pt-br": "Registre este endpoint no seu cliente MCP. O servidor expõe as tools spotify_* e os recursos euterpe://.",
  },

  // --- Shell: views, rail e chip de perfil (BRAND-VOICE.md) ---
  // Registro de REPOUSO: curto, sentence case, sem hype.
  "view.chat": { en: "Chat", "pt-br": "Conversa" },
  "view.prefs": { en: "Preferences", "pt-br": "Preferências" },
  "view.onboarding": { en: "First run", "pt-br": "Primeiro uso" },
  "rail.toggle": { en: "Show/hide the left column", "pt-br": "Mostrar/ocultar coluna esquerda" },
  "rail.conversations": { en: "Conversations", "pt-br": "Conversas" },
  "rail.sections": { en: "Settings", "pt-br": "Ajustes" },
  "rail.searchConversations": { en: "Search conversations…", "pt-br": "Buscar conversas…" },
  "rail.searchSettings": { en: "Search a setting…", "pt-br": "Buscar ajuste…" },
  "rail.newConversation": { en: "New conversation", "pt-br": "Nova conversa" },
  "rail.none": { en: "No conversation yet.", "pt-br": "Nenhuma conversa ainda." },
  "rail.noResults": { en: "Nothing found.", "pt-br": "Nada encontrado." },
  "rail.ownProfile": { en: "own profile", "pt-br": "perfil próprio" },
  "rail.today": { en: "Today", "pt-br": "Hoje" },
  "rail.yesterday": { en: "Yesterday", "pt-br": "Ontem" },
  "rail.earlier": { en: "Earlier", "pt-br": "Anteriores" },
  "profile.none": { en: "No model profile", "pt-br": "Nenhum perfil de modelo" },
  "profile.available": { en: "Available profiles", "pt-br": "Perfis disponíveis" },
  "profile.fix": { en: "Pin to this conversation", "pt-br": "Fixar nesta conversa" },
  "profile.fixHint": {
    en: "Other conversations keep following the global default.",
    "pt-br": "As outras conversas continuam seguindo o padrão global.",
  },
  "profile.manage": { en: "Manage profiles…", "pt-br": "Gerenciar perfis…" },
  "profile.global": { en: "global default", "pt-br": "padrão global" },
  "profile.inConversation": { en: "in this conversation", "pt-br": "nesta conversa" },
  "profile.useOnlyHere": { en: "use in this conversation only", "pt-br": "usar só nesta conversa" },
  "profile.backToGlobal": { en: "back to the global default", "pt-br": "voltar ao padrão" },
  "profile.pinned": { en: "Profile {name} pinned to this conversation", "pt-br": "Perfil {name} fixado nesta conversa" },
  "profile.applied": { en: "Profile {name} applied (global default)", "pt-br": "Perfil {name} aplicado (padrão global)" },
  "profile.unpinned": { en: "Back to the global default", "pt-br": "Voltou ao padrão global" },
  "profile.roleChat": { en: "chat", "pt-br": "chat" },
  "profile.roleCuration": { en: "curation", "pt-br": "curadoria" },
  "profile.noKey": { en: "no key", "pt-br": "sem chave" },
  "banner.noProfile": {
    en: "No model profile configured — the chat stays unavailable until you pick one.",
    "pt-br": "Nenhum perfil de modelo configurado — o chat fica indisponível até você escolher um.",
  },
  "banner.configure": { en: "Configure now", "pt-br": "Configurar agora" },
  "status.toolsCount": { en: "{n} tool(s)", "pt-br": "{n} ferramenta(s)" },

  // --- Preferências: as páginas do protótipo (registro de REPOUSO) ---
  "prefs.profiles": { en: "Model profiles", "pt-br": "Perfis de modelo" },
  "prefs.profilesHint": {
    en: "A profile is provider + model with a short name. It is what the chat chip shows — no more two separate selects.",
    "pt-br": "Um perfil é provider + modelo com um nome curto. É ele que aparece no chip do chat — não mais dois selects separados.",
  },
  "prefs.active": { en: "active", "pt-br": "ativo" },
  "prefs.use": { en: "Use", "pt-br": "Usar" },
  "prefs.test": { en: "Test", "pt-br": "Testar" },
  "prefs.testing": { en: "Testing…", "pt-br": "Testando…" },
  "prefs.remove": { en: "Remove", "pt-br": "Remover" },
  "prefs.addProfile": { en: "+ Add profile", "pt-br": "+ Adicionar perfil" },
  "prefs.onlyProfile": { en: "the last profile cannot be removed", "pt-br": "o último perfil não pode ser removido" },
  "prefs.roles": { en: "Roles and defaults", "pt-br": "Papéis e padrões" },
  "prefs.rolesHint": {
    en: "Which profile each role uses. Empty means the config default.",
    "pt-br": "Qual perfil cada papel usa. Vazio significa o padrão da configuração.",
  },
  "prefs.roleChat": { en: "Chat", "pt-br": "Chat" },
  "prefs.roleCuration": { en: "Curation", "pt-br": "Curadoria" },
  "prefs.roleInherit": { en: "follow the default", "pt-br": "seguir o padrão" },
  "prefs.overrides": { en: "Per-conversation overrides", "pt-br": "Overrides por conversa" },
  "prefs.overridesNone": { en: "No conversation has its own profile.", "pt-br": "Nenhuma conversa tem perfil próprio." },
  "prefs.instructions": { en: "System instructions", "pt-br": "Instruções do sistema" },
  "prefs.instructionsHint": {
    en: "Appended to the system prompt at runtime. It never overrides the data rules.",
    "pt-br": "Acrescentadas ao system prompt em runtime. Nunca sobrepõem as regras de dado.",
  },
  "prefs.instructionsPlaceholder": { en: "e.g. always cite the BPM", "pt-br": "ex.: sempre cite o BPM" },
  "prefs.storage": { en: "Storage", "pt-br": "Armazenamento" },
  "prefs.storageDb": { en: "Database", "pt-br": "Banco" },
  "prefs.storageSessions": { en: "Session logs", "pt-br": "Logs de sessão" },
  "prefs.storageProbes": { en: "Probes", "pt-br": "Probes" },
  "prefs.eraseHistory": { en: "Delete chat history", "pt-br": "Apagar histórico do chat" },
  "prefs.eraseSessions": { en: "Delete session logs", "pt-br": "Apagar logs de sessão" },
  "prefs.eraseSnapshots": { en: "Delete undo snapshots", "pt-br": "Apagar snapshots de desfazer" },
  "prefs.erased": { en: "Deleted: {what}", "pt-br": "Apagado: {what}" },
  "prefs.diag": { en: "Diagnostics", "pt-br": "Diagnóstico" },
  "prefs.diagVersion": { en: "Version", "pt-br": "Versão" },
  "prefs.diagDataDir": { en: "Data folder", "pt-br": "Pasta de dados" },
  "prefs.diagPort": { en: "Port", "pt-br": "Porta" },
  "prefs.diagClients": { en: "Connected clients", "pt-br": "Clientes conectados" },
  "prefs.runProbe": { en: "Run probe", "pt-br": "Rodar probe" },
  "prefs.probeDone": { en: "Probe written to {file}", "pt-br": "Probe gravado em {file}" },
  "prefs.mcpEnabled": { en: "MCP server", "pt-br": "Servidor MCP" },
  "prefs.mcpEnabledHint": {
    en: "When off, the endpoint answers 404 to MCP clients.",
    "pt-br": "Desligado, o endpoint responde 404 para clientes MCP.",
  },
  "prefs.on": { en: "on", "pt-br": "ligado" },
  "prefs.off": { en: "off", "pt-br": "desligado" },
  "onb.title": { en: "First run", "pt-br": "Primeiro uso" },
  "onb.intro": {
    en: "Euterpe needs one model to answer. Pick a provider, paste the key, choose the model — everything stays on your machine.",
    "pt-br": "A Euterpe precisa de um modelo para responder. Escolha um provedor, cole a chave e escolha o modelo — tudo fica na sua máquina.",
  },
  "onb.start": { en: "Start setup", "pt-br": "Começar a configuração" },
  "onb.skip": { en: "See the interface first", "pt-br": "Ver a interface primeiro" },
  "onb.stepProvider": { en: "Provider", "pt-br": "Provedor" },
  "onb.stepKey": { en: "Key", "pt-br": "Chave" },
  "onb.stepModel": { en: "Model", "pt-br": "Modelo" },
  "onb.stepDone": { en: "Ready", "pt-br": "Pronto" },
  "onb.back": { en: "Back", "pt-br": "Voltar" },
  "onb.next": { en: "Next", "pt-br": "Avançar" },
  "onb.finish": { en: "Finish", "pt-br": "Concluir" },
  "onb.keyHint": { en: "The key stays in the local keyring — nothing is sent anywhere else.", "pt-br": "A chave fica no keyring local — nada é enviado para fora." },
  "onb.done": { en: "All set. Ask something about your music.", "pt-br": "Tudo pronto. Pergunte algo sobre a sua música." },
  "scope.conversation": { en: "in this conversation", "pt-br": "nesta conversa" },

  // --- Preferências: frame de página + cartão de perfil rico ---
  "prefs.groupModels": { en: "Models", "pt-br": "Modelos" },
  "prefs.groupProviders": { en: "Providers", "pt-br": "Provedores" },
  "prefs.groupAgency": { en: "Agency & safety", "pt-br": "Agência & segurança" },
  "prefs.groupChat": { en: "Conversation", "pt-br": "Conversa" },
  "prefs.groupTools": { en: "Tools & MCP", "pt-br": "Ferramentas & MCP" },
  "prefs.groupData": { en: "Data & logs", "pt-br": "Dados & logs" },
  "prefs.pageCredentials": { en: "Credentials", "pt-br": "Credenciais" },
  "prefs.pageEndpoints": { en: "Endpoints", "pt-br": "Endpoints" },
  "prefs.pageMutation": { en: "Tool mutation", "pt-br": "Mutação de ferramentas" },
  "prefs.pageLimits": { en: "Approvals and limits", "pt-br": "Aprovações e limites" },
  "prefs.pageBehaviour": { en: "Chat behaviour", "pt-br": "Comportamento do chat" },
  "prefs.pageSearch": { en: "Web search", "pt-br": "Busca na web" },
  "prefs.restoreSection": { en: "Restore section", "pt-br": "Restaurar seção" },
  "prefs.restored": { en: "Section restored to its defaults", "pt-br": "Seção restaurada aos padrões" },
  "prefs.savedAgo": { en: "Saved", "pt-br": "Salvo" },
  "prefs.savedAgoTime": { en: "Saved · {when}", "pt-br": "Salvo · {when}" },
  "prefs.justNow": { en: "just now", "pt-br": "agora mesmo" },
  "prefs.secondsAgo": { en: "{n}s ago", "pt-br": "há {n}s" },
  "prefs.sourceOfTruth": {
    en: "Preferences are saved straight to the daemon (source of truth)",
    "pt-br": "Preferências salvas direto no daemon (fonte de verdade)",
  },
  "prefs.newProfile": { en: "+ New profile", "pt-br": "+ Novo perfil" },
  "prefs.edit": { en: "edit", "pt-br": "editar" },
  "prefs.duplicate": { en: "duplicate", "pt-br": "duplicar" },
  "prefs.done": { en: "done", "pt-br": "concluir" },
  "prefs.temperature": { en: "temperature", "pt-br": "temperature" },
  "prefs.maxTokens": { en: "max. tokens", "pt-br": "máx. tokens" },
  "prefs.baseUrl": { en: "base_url", "pt-br": "base_url" },
  "prefs.lastTestOk": { en: "last test OK · {ms}", "pt-br": "último teste OK · {ms}" },
  "prefs.lastTestFail": { en: "last test FAILED", "pt-br": "último teste FALHOU" },
  "prefs.noTest": { en: "no test", "pt-br": "sem teste" },
  "prefs.roleDefaultChat": { en: "chat default", "pt-br": "padrão do chat" },
  "prefs.roleSuggestions": { en: "suggestions", "pt-br": "sugestões" },
  "prefs.provider": { en: "Provider", "pt-br": "Provedor" },
  "prefs.model": { en: "Model", "pt-br": "Modelo" },
  "prefs.noProviders": {
    en: "No provider configured yet — the chat stays unavailable until you add one.",
    "pt-br": "Nenhum provedor configurado ainda — o chat fica indisponível até você adicionar um.",
  },
  "prefs.pickProvider": { en: "pick a provider…", "pt-br": "escolha um provedor…" },
  "prefs.addProvider": { en: "Add provider", "pt-br": "Adicionar provedor" },
  "prefs.removeProvider": { en: "Remove provider", "pt-br": "Remover provedor" },
  "prefs.removeProviderActive": { en: "switch the active provider first", "pt-br": "troque o provedor ativo antes" },
  "prefs.credentialsHint": {
    en: "Only the providers in use are listed. Pick another to add it, or remove the ones you do not use.",
    "pt-br": "Só aparecem os provedores em uso. Escolha outro para adicionar, ou remova os que não usa.",
  },
  "onb.step1": { en: "Connect provider", "pt-br": "Conectar provedor" },
  "onb.step2": { en: "Pick model", "pt-br": "Escolher modelo" },
  "onb.step3": { en: "Start conversation", "pt-br": "Iniciar conversa" },
  "onb.note": {
    en: "Set up an API key or local model to unlock intelligent curation.",
    "pt-br": "Configure uma chave ou modelo local para liberar a curadoria inteligente.",
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
