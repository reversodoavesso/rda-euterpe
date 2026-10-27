"use strict";
const $ = (q, root = document) => root.querySelector(q);
const state = {
  user: null,
  csrf: "",
  view: "chat",
  conversations: [],
  conversation: null,
  messages: [],
  streaming: false,
  controller: null,
  playlists: null,
  liked: [],
  likedMore: true,
  libraryTab: "playlists",
  libraryFilter: "",
  selected: null,
  search: null,
  searchBusy: false,
  query: "",
  searchTab: "tracks",
  draft: null,
  proposals: [],
  jobs: new Set(),
  status: null,
  settings: null,
  providers: [],
  activity: [],
  polling: false,
  authMode: "login",
  sso: { enabled: false },
  ssoLinked: false,
};
const names = {
  get_playlists: "Consultar playlists",
  get_playlist_tracks: "Ler músicas da playlist",
  get_saved_tracks: "Consultar músicas curtidas",
  search_spotify: "Buscar no Spotify",
  resolve_tracks: "Encontrar músicas",
  get_several_tracks: "Consultar músicas",
  create_playlist: "Criar playlist",
  delete_playlist: "Remover da biblioteca",
  add_tracks: "Adicionar músicas",
  remove_tracks: "Remover músicas",
  replace_playlist_tracks: "Atualizar músicas e ordem",
  set_playlist_details: "Editar nome e descrição",
  undo_last_mutation: "Desfazer última alteração",
};
const errors = {
  rda_sso_required: "Esta conta já usa RDA. Entre pelo botão Entrar com RDA.",
  sso_login_failed: "Não foi possível entrar com RDA. Inicie o login novamente.",
  sso_identity_already_linked: "Esta identidade RDA já está vinculada a outra conta Euterpe.",
  local_account_already_linked: "Esta conta Euterpe já está vinculada ao RDA.",
  local_account_proof_expired: "Sua sessão local expirou. Entre novamente antes de vincular.",
  login_required: "Entre para acessar seu espaço.",
  invalid_credentials: "Usuário ou senha incorretos.",
  invalid_username:
    "Use de 3 a 48 letras minúsculas, números, ponto, hífen ou sublinhado.",
  password_minimum_12: "A senha precisa ter de 12 a 128 caracteres.",
  username_unavailable: "Esse usuário já está em uso.",
  registration_closed: "O cadastro está fechado nesta instalação.",
  too_many_login_attempts: "Muitas tentativas. Aguarde alguns minutos.",
  another_change_is_pending:
    "Há uma alteração aguardando conclusão. Revise a solicitação pendente.",
  proposal_expired:
    "A proposta expirou. Atualize a playlist antes de tentar novamente.",
  provider_test_failed:
    "Não foi possível conectar. Confira o endereço, o modelo e a chave.",
  models_unavailable:
    "Não foi possível listar os modelos. Você pode informar o nome manualmente.",
  not_authenticated: "Conecte sua conta Spotify para continuar.",
  spotify_not_authenticated: "Conecte sua conta Spotify para continuar.",
  no_snapshot: "Não há uma alteração disponível para desfazer nesta playlist.",
  no_snapshot_found:
    "Não há uma alteração disponível para desfazer nesta playlist.",
  headless_outcome_unknown:
    "O Spotify não confirmou o resultado. Atualize a biblioteca para conferir antes de repetir a alteração.",
  operation_interrupted_verify_state:
    "A operação foi interrompida. Atualize a playlist para verificar o resultado.",
  spotify_status_403: "Sua conta não tem permissão para editar esta playlist.",
  snapshot_unavailable:
    "Não foi possível salvar a versão atual da playlist. Atualize a biblioteca antes de tentar novamente.",
  mutation_rejected: "Alteração recusada.",
  user_rejected: "Alteração recusada.",
  request_failed: "Não foi possível concluir. Tente novamente.",
  csrf_rejected: "Sua sessão mudou. Atualize a página.",
  server_capacity_busy:
    "O servidor está ocupado. Tente novamente em instantes.",
};
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key.startsWith("on"))
      el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "value") el.value = value;
    else if (key === "disabled" || key === "checked" || key === "draggable")
      el[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false)
      el.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
  return el;
}
function button(text, fn, cls = "", attrs = {}) {
  return h(
    "button",
    { type: "button", class: cls, onClick: () => safe(fn), ...attrs },
    text,
  );
}
function safe(fn) {
  return Promise.resolve().then(fn).catch(showError);
}
function toast(text, error = false) {
  const n = h(
    "div",
    { class: "toast" + (error ? " error" : ""), role: "status" },
    text,
  );
  $("#notifications").append(n);
  setTimeout(() => n.remove(), 6500);
}
function showError(error) {
  if (error?.name === "AbortError") return;
  toast(
    errors[error?.message] ||
      error?.message ||
      "Não foi possível concluir a operação.",
    true,
  );
}
async function api(path, method = "GET", body, options = {}) {
  const account = state.user?.id;
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...options,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error("Resposta inválida do servidor.");
  }
  if (account && state.user?.id !== account)
    throw new DOMException("Sessão alterada", "AbortError");
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.controller?.abort();
      state.user = null;
      render();
    }
    const code = data.error || data.data?.code || data.code || "request_failed";
    throw Error(errors[code] || code);
  }
  return data;
}
async function tool(name, args = {}) {
  const result = await api("/tools", "POST", { name, arguments: args });
  return result.data;
}
function uri(t) {
  return t.uri || t.track?.uri || "";
}
function track(t) {
  return t.track ? { ...t.track, added_at: t.added_at } : t;
}
function tracks(data) {
  return (Array.isArray(data) ? data : data.tracks || data.items || []).map(
    track,
  );
}
function artist(t) {
  return Array.isArray(t.artists)
    ? t.artists.map((a) => (typeof a === "string" ? a : a.name)).join(", ")
    : t.artist || "Spotify";
}
function duration(ms) {
  if (!ms) return "";
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function playlistId(p) {
  return p?.id || p?.playlist_id || p?.uri?.split(":").pop();
}
function brand() {
  return h(
    "div",
    { class: "brand" },
    h("img", { src: "/logo.svg", alt: "" }),
    "euterpe",
  );
}
function field(label, input) {
  return h("label", {}, label, input);
}
function pill() {
  return button(
    h(
      "span",
      { class: "row" },
      h("i", { class: "dot" }),
      state.status?.spotify?.authenticated
        ? "Spotify conectado"
        : "Conectar Spotify",
    ),
    pairSpotify,
    "pill " + (state.status?.spotify?.authenticated ? "online" : ""),
    {
      "aria-label": state.status?.spotify?.authenticated
        ? "Ver conexão Spotify"
        : "Conectar conta Spotify",
    },
  );
}
function render() {
  const app = $("#app");
  app.replaceChildren(state.user ? shell() : authScreen());
}
function authScreen() {
  const register = !state.sso.enabled && state.authMode === "register";
  const user = h("input", {
    name: "username",
    autocomplete: "username",
    required: true,
    placeholder: "seu.usuario",
    minlength: 3,
    maxlength: 48,
  });
  const pass = h("input", {
    name: "password",
    type: "password",
    autocomplete: register ? "new-password" : "current-password",
    required: true,
    minlength: 12,
    maxlength: 128,
    placeholder: "Pelo menos 12 caracteres",
  });
  const display = h("input", {
    name: "display_name",
    autocomplete: "nickname",
    placeholder: "Como podemos te chamar?",
    maxlength: 80,
  });
  const submit = h(
    "button",
    { type: "submit", class: "primary" },
    register ? "Criar meu espaço" : "Entrar no meu espaço",
  );
  const err = h("div", { class: "inline-error", role: "alert" });
  const form = h(
    "form",
    {
      onSubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        err.textContent = "";
        try {
          const r = await api(
            "/account/" + (register ? "register" : "login"),
            "POST",
            {
              username: user.value,
              password: pass.value,
              display_name: display.value,
            },
          );
          pass.value = "";
          await signedIn(r);
        } catch (error) {
          err.textContent = errors[error.message] || error.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    register && field("Seu nome", display),
    field("Usuário", user),
    field("Senha", pass),
    err,
    submit,
  );
  return h(
    "main",
    { class: "auth-page" },
    h(
      "section",
      { class: "auth-story" },
      brand(),
      h(
        "div",
        {},
        h("div", { class: "record" }),
        h("div", { class: "eyebrow" }, "Um espaço para a sua música"),
        h("h1", {}, "Boas playlists começam com uma conversa."),
        h(
          "p",
          {},
          "Explore sua biblioteca, descubra músicas e dê forma às suas ideias com o Euterpe.",
        ),
      ),
      h("div", { class: "small muted" }, "Você escolhe. O agente organiza."),
    ),
    h(
      "section",
      { class: "auth-panel" },
      h(
        "div",
        { class: "auth-form" },
        h(
          "div",
          { class: "eyebrow" },
          register ? "Seu próximo lado A" : "Bem-vindo de volta",
        ),
        h(
          "h2",
          {},
          register ? "Crie seu espaço musical" : "Entre no seu ritmo",
        ),
        h(
          "p",
          { class: "small muted" },
          "Sua conta Euterpe mantém conversas, preferências e conexão Spotify em um só lugar.",
        ),
        state.sso.enabled && button("Entrar com RDA", () => {
          window.location.assign("/api/account/sso/login");
        }, "primary"),
        state.sso.enabled && h("p", { class: "small muted" },
          "Já possui uma conta local? Entre abaixo e vincule sua conta RDA em Ajustes para manter suas conversas e conexão Spotify."),
        form,
        !state.sso.enabled && h(
          "div",
          { class: "auth-switch" },
          register ? "Já tem uma conta? " : "Primeira vez por aqui? ",
          button(
            register ? "Entrar" : "Criar conta",
            () => {
              state.authMode = register ? "login" : "register";
              render();
            },
            "ghost",
          ),
        ),
        h(
          "p",
          { class: "small muted" },
          "A conexão com o Spotify acontece depois do login.",
        ),
      ),
    ),
  );
}
async function signedIn(r) {
  state.user = r.user;
  state.ssoLinked = Boolean(r.ssoLinked);
  state.csrf = r.csrf;
  state.view = "chat";
  render();
  await loadConversations();
  safe(refreshStatus);
  safe(poll);
  safe(async () => {
    const { jobs } = await api("/jobs");
    for (const job of jobs || []) {
      state.jobs.add(job.id);
      safe(() => watchJob(job.id, job.tool, job.arguments));
    }
    renderReview();
  });
}
function shell() {
  const navs = [
    ["chat", "✦", "Conversar"],
    ["library", "▦", "Biblioteca"],
    ["search", "⌕", "Explorar"],
    ["activity", "◷", "Atividade"],
    ["settings", "⚙", "Ajustes"],
  ];
  const sidebar = h(
    "aside",
    { class: "sidebar", id: "sidebar" },
    brand(),
    h(
      "nav",
      { "aria-label": "Navegação principal" },
      navs.map(([id, icon, label]) =>
        button(
          [
            h("span", { class: "nav-symbol", "aria-hidden": true }, icon),
            label,
          ],
          () => navigate(id),
          "nav-btn" + (state.view === id ? " active" : ""),
          { "aria-current": state.view === id ? "page" : null },
        ),
      ),
    ),
    h(
      "div",
      {},
      h(
        "div",
        { class: "row between" },
        h("span", { class: "eyebrow" }, "Suas conversas"),
        button("+", newConversation, "ghost icon-btn", {
          "aria-label": "Nova conversa",
        }),
      ),
    ),
    h(
      "div",
      { class: "conversation-list" },
      state.conversations.length
        ? state.conversations.map((c) =>
            h(
              "div",
              {
                class:
                  "conversation" +
                  (c.id === state.conversation ? " active" : ""),
              },
              button(c.title, () => openConversation(c.id), "ghost"),
              h(
                "div",
                { class: "conversation-tools" },
                button("✎", () => renameConversation(c), "ghost", {
                  "aria-label": "Renomear " + c.title,
                }),
                button("×", () => deleteConversation(c), "ghost", {
                  "aria-label": "Excluir " + c.title,
                }),
              ),
            ),
          )
        : h("p", { class: "small muted" }, "Sua próxima ideia começa aqui."),
    ),
    h(
      "div",
      { class: "account row" },
      h(
        "div",
        { class: "avatar" },
        state.user.display_name.slice(0, 1).toUpperCase(),
      ),
      h(
        "div",
        { class: "flex" },
        h("div", { class: "small" }, state.user.display_name),
        h("div", { class: "small muted" }, "Espaço pessoal"),
      ),
      button("↪", logout, "ghost icon-btn", { "aria-label": "Sair da conta" }),
    ),
  );
  const labels = {
    chat: "Seu estúdio de playlists",
    library: "Tudo o que você gosta",
    search: "Encontre seu próximo som",
    activity: "Cada escolha, registrada",
    settings: "Do seu jeito",
  };
  const main = h(
    "main",
    { class: "workspace" },
    h(
      "header",
      { class: "topbar row between" },
      h(
        "div",
        { class: "row" },
        button(
          "☰",
          () => $("#sidebar").classList.toggle("visible"),
          "ghost mobile-menu",
          { "aria-label": "Abrir navegação" },
        ),
        h("span", { class: "eyebrow" }, labels[state.view]),
      ),
      h(
        "div",
        { class: "row" },
        button(
          "Revisão " + (state.draft?.tracks.length || ""),
          () => $(".review").classList.toggle("visible"),
          "mobile-review small",
        ),
        pill(),
      ),
    ),
    h(
      "section",
      { class: "view", id: "view", "aria-label": labels[state.view] },
      view(),
    ),
  );
  return h("div", { class: "shell" }, sidebar, main, review());
}
function view() {
  if (state.view === "chat") return chatView();
  if (state.view === "library") return libraryView();
  if (state.view === "search") return searchView();
  if (state.view === "activity") return activityView();
  return settingsView();
}
function replaceView() {
  const v = $("#view");
  if (v) v.replaceChildren(view());
}
async function navigate(v) {
  if (state.streaming && v !== "chat")
    toast("A conversa continua em segundo plano.");
  state.view = v;
  render();
  if (v === "library" && !state.playlists) await loadLibrary();
  if (v === "activity") await loadActivity();
  if (v === "settings") await loadSettings();
}
async function loadConversations() {
  const r = await api("/conversations");
  state.conversations = r.conversations;
  if (state.view === "chat" && !state.streaming) render();
}
async function newConversation() {
  if (state.streaming) {
    toast("Pare a resposta atual antes de abrir outra conversa.");
    return;
  }
  const r = await api("/conversations", "POST", {});
  state.conversation = r.id;
  state.messages = [];
  state.view = "chat";
  await loadConversations();
  render();
  $("#message-input")?.focus();
}
async function openConversation(id) {
  if (state.streaming) {
    toast("Pare a resposta atual antes de trocar de conversa.");
    return;
  }
  const r = await api("/conversations/" + id);
  state.conversation = id;
  state.messages = r.messages;
  state.view = "chat";
  render();
  scrollChat();
}
let pairingTimer = null;
let pairingGeneration = 0;
function modal(content) {
  clearTimeout(pairingTimer);
  pairingGeneration++;
  const d = $("#modal");
  d.replaceChildren(content);
  if (!d.open) d.showModal();
  return d;
}
function closeModal() {
  clearTimeout(pairingTimer);
  pairingGeneration++;
  const d = $("#modal");
  if (d.open) d.close();
  d.replaceChildren();
}
function modalFrame(title, content, actions = []) {
  return h(
    "div",
    {},
    h(
      "div",
      { class: "modal-header" },
      h("span", { class: "eyebrow" }, "Euterpe"),
      button("×", closeModal, "ghost icon-btn", {
        "aria-label": "Fechar janela",
      }),
    ),
    h("h2", {}, title),
    content,
    h("div", { class: "modal-actions" }, actions),
  );
}
function renameConversation(c) {
  const input = h("input", {
    value: c.title,
    maxlength: 100,
    "aria-label": "Título da conversa",
  });
  modal(
    modalFrame("Renomear conversa", input, [
      button("Cancelar", closeModal),
      button(
        "Salvar",
        async () => {
          await api("/conversations/" + c.id, "PATCH", { title: input.value });
          closeModal();
          await loadConversations();
        },
        "primary",
      ),
    ]),
  );
  input.focus();
}
function deleteConversation(c) {
  modal(
    modalFrame(
      "Excluir esta conversa?",
      h(
        "p",
        { class: "muted" },
        "A conversa e o histórico do agente serão apagados. As playlists continuam na sua biblioteca.",
      ),
      [
        button("Cancelar", closeModal),
        button(
          "Excluir conversa",
          async () => {
            await api("/conversations/" + c.id, "DELETE");
            if (state.conversation === c.id) {
              state.conversation = null;
              state.messages = [];
            }
            closeModal();
            await loadConversations();
          },
          "danger",
        ),
      ],
    ),
  );
}
async function logout() {
  if (state.controller && state.conversation) {
    try {
      await api("/chat/cancel", "POST", {
        conversation_id: state.conversation,
      });
    } catch {
      /* Logout must remain available. */
    }
  }
  state.controller?.abort();
  await api("/account/logout", "POST", {});
  Object.assign(state, {
    user: null,
    csrf: "",
    conversation: null,
    messages: [],
    conversations: [],
    draft: null,
    playlists: null,
    selected: null,
    proposals: [],
    liked: [],
    status: null,
    settings: null,
    providers: [],
    activity: [],
    search: null,
    searchBusy: false,
    streaming: false,
    controller: null,
    view: "chat",
    query: "",
    searchTab: "tracks",
    libraryTab: "playlists",
    libraryFilter: "",
    likedMore: true,
    authMode: "login",
  });
  state.jobs.clear();
  closeModal();
  render();
}
function chatView() {
  const messages = h(
    "div",
    { class: "chat-messages", id: "chat-messages" },
    state.messages.length ? state.messages.map(messageNode) : welcome(),
  );
  const text = h("textarea", {
    id: "message-input",
    placeholder: "Que playlist vamos criar hoje?",
    rows: 2,
    "aria-label": "Mensagem para o agente",
    onKeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        safe(() => sendMessage(text.value));
      }
    },
  });
  const submit = button(
    state.streaming ? "Parar resposta" : "Enviar ↗",
    () => (state.streaming ? stopChat() : sendMessage(text.value)),
    "primary",
    {
      "aria-label": state.streaming
        ? "Parar resposta do agente"
        : "Enviar mensagem",
    },
  );
  return h(
    "div",
    { class: "chat-view" },
    messages,
    h(
      "div",
      { class: "status", id: "chat-status", "aria-live": "polite" },
      state.streaming ? "O Euterpe está trabalhando…" : "",
    ),
    h(
      "div",
      { class: "composer" },
      text,
      h(
        "div",
        { class: "composer-footer" },
        h("span", {}, "✦ Seu gosto é o ponto de partida"),
        submit,
      ),
    ),
    h(
      "p",
      { class: "composer-note" },
      "Alterações no Spotify passam pela sua aprovação. Shift + Enter para uma nova linha.",
    ),
  );
}
function welcome() {
  const ideas = [
    [
      "✧",
      "Organizar uma playlist",
      "Quero organizar uma playlist da minha biblioteca e remover músicas repetidas.",
    ],
    [
      "↗",
      "Descobrir novos caminhos",
      "Busque músicas de MPB para uma tarde tranquila. Primeiro me mostre as opções.",
    ],
    [
      "♡",
      "Partir das minhas curtidas",
      "Consulte minhas músicas curtidas e sugira uma seleção de 20 faixas para trabalhar.",
    ],
    [
      "≋",
      "Criar o clima certo",
      "Vamos montar uma playlist para uma viagem de fim de semana. Pergunte sobre meu gosto antes de começar.",
    ],
  ];
  return h(
    "div",
    { class: "welcome" },
    h(
      "div",
      { class: "greeting" },
      h("span", { class: "star" }, "✦"),
      "Seu gosto. Novas possibilidades.",
    ),
    h("h1", {}, "O que vamos ouvir", h("br"), "a seguir?"),
    h(
      "p",
      {},
      "Uma ideia, um momento ou aquela playlist que precisa de carinho. Conte para o Euterpe e a gente encontra o ritmo.",
    ),
    h(
      "div",
      { class: "suggestion-grid" },
      ideas.map(([icon, title, prompt]) =>
        button(
          [h("span", {}, icon), title],
          () => {
            const input = $("#message-input");
            input.value = prompt;
            input.focus();
          },
          "suggestion",
        ),
      ),
    ),
    h(
      "div",
      { class: "welcome-note" },
      "◉",
      state.status?.spotify?.authenticated
        ? "Sua biblioteca Spotify está pronta para explorar."
        : "Conecte o Spotify para explorar sua biblioteca.",
    ),
  );
}
function messageNode(m) {
  return h(
    "article",
    { class: "message " + m.role },
    h(
      "div",
      { class: "message-mark", "aria-hidden": true },
      m.role === "user" ? "○" : "✦",
    ),
    h(
      "div",
      { class: "message-body" },
      h(
        "div",
        { class: "message-name" },
        m.role === "user" ? "Você" : "Euterpe",
      ),
      h("div", { class: "message-text" }, m.content),
      m.interrupted &&
        h("p", { class: "small muted" }, "Resposta interrompida."),
    ),
  );
}
function scrollChat() {
  const box = $("#chat-messages");
  if (box) box.scrollTop = box.scrollHeight;
}
async function sendMessage(text) {
  text = text.trim();
  if (!text || state.streaming) return;
  const account = state.user.id;
  if (!state.conversation) {
    const c = await api("/conversations", "POST", {});
    state.conversation = c.id;
  }
  state.streaming = true;
  state.controller = new AbortController();
  state.messages.push({ role: "user", content: text });
  const responseMessage = { role: "assistant", content: "" };
  state.messages.push(responseMessage);
  state.view = "chat";
  render();
  scrollChat();
  let complete = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": state.csrf,
      },
      body: JSON.stringify({ conversation_id: state.conversation, text }),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const err = await res.json();
      throw Error(errors[err.error] || err.error);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const part = await reader.read();
      buffer += decoder.decode(part.value || new Uint8Array(), {
        stream: !part.done,
      });
      let pos;
      while ((pos = buffer.indexOf("\n\n")) !== -1) {
        const packet = buffer.slice(0, pos).replace(/\r/g, "");
        buffer = buffer.slice(pos + 2);
        const event = packet
          .split("\n")
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        const raw = packet
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (event === "stream") {
          responseMessage.content += data.delta || "";
          const nodes = document.querySelectorAll(
            ".message.assistant .message-text",
          );
          const last = nodes[nodes.length - 1];
          if (last) last.textContent = responseMessage.content;
          scrollChat();
        } else if (event === "status") {
          const node = $("#chat-status");
          if (node)
            node.textContent = data.detail || "O Euterpe está trabalhando…";
        } else if (event === "tool") {
          const node = $("#chat-status");
          if (node)
            node.textContent =
              "↳ " +
              (names[data.name.replace(/^spotify_/, "")] ||
                "Consultando informações…");
        } else if (event === "proposal") {
          await refreshProposals();
          const node = $("#chat-status");
          if (node)
            node.textContent = "Uma alteração está aguardando sua revisão →";
        } else if (event === "error") {
          throw Error(
            errors[data.code] || data.detail || "A resposta foi interrompida.",
          );
        } else if (event === "done") {
          complete = true;
        }
      }
      if (part.done) break;
    }
  } catch (err) {
    if (err.name !== "AbortError") showError(err);
  } finally {
    if (state.user?.id !== account) return;
    if (!complete) responseMessage.interrupted = true;
    if (!responseMessage.content) state.messages.pop();
    state.streaming = false;
    state.controller = null;
    replaceView();
    scrollChat();
    await loadConversations();
    safe(refreshProposals);
  }
}
async function stopChat() {
  if (state.conversation) {
    await api("/chat/cancel", "POST", { conversation_id: state.conversation });
  }
  state.controller?.abort();
  toast("Resposta interrompida. Conferindo se há propostas pendentes…");
  setTimeout(() => safe(refreshProposals), 1000);
}
async function refreshStatus() {
  const r = await api("/status");
  state.status = r;
  const bar = $(".topbar .pill");
  if (bar) bar.replaceWith(pill());
  if (state.view === "chat" && !state.messages.length && !state.streaming)
    replaceView();
  return r;
}
async function pairSpotify() {
  let status = (await refreshStatus()).spotify;
  if (status.authenticated) {
    modal(
      modalFrame(
        "Seu Spotify está conectado",
        h(
          "div",
          { class: "stack" },
          h(
            "p",
            { class: "muted" },
            "A sessão está salva neste servidor e pertence apenas ao seu espaço Euterpe.",
          ),
          h(
            "div",
            { class: "notice success" },
            "✓ Biblioteca, busca e edição de playlists disponíveis.",
          ),
          h(
            "p",
            { class: "small muted" },
            "Para usar outra conta, crie outro usuário Euterpe. Isso preserva a separação das bibliotecas.",
          ),
        ),
        [button("Tudo pronto", closeModal, "primary")],
      ),
    );
    return;
  }
  pairingModal(status);
}
function pairingModal(status) {
  const connected = status.authenticated;
  const code = Boolean(status.user_code);
  const pending = code || ["pending", "authenticating"].includes(status.status);
  const box = h(
    "div",
    { class: "stack" },
    h(
      "p",
      { class: "muted" },
      "Autorize o Euterpe no site do Spotify. Sua senha Spotify é informada somente ao Spotify.",
    ),
    pending &&
      !code &&
      h(
        "div",
        { class: "notice" },
        status.status === "authenticating"
          ? "Concluindo a autorização…"
          : "Gerando seu código no Spotify…",
      ),
    code &&
      h(
        "div",
        {},
        h("div", { class: "code" }, status.user_code),
        h(
          "p",
          { class: "small muted" },
          status.expires_at
            ? "Válido até " +
                new Date(status.expires_at).toLocaleTimeString("pt-BR")
            : "Código temporário",
        ),
        h(
          "a",
          {
            href: status.verification_url,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Abrir autorização no Spotify ↗",
        ),
      ),
    connected && h("div", { class: "notice success" }, "✓ Conta conectada."),
    status.error &&
      h(
        "div",
        { class: "notice error" },
        "A autorização não foi concluída. Gere um novo código.",
      ),
    h(
      "p",
      { class: "small muted" },
      "Após autorizar, clique em “Verificar conexão”.",
    ),
  );
  const actions = connected
    ? [button("Concluir", closeModal, "primary")]
    : [
        pending &&
          button("Cancelar código", async () => {
            await api("/spotify/auth", "DELETE");
            pairingModal({});
          }),
        button(
          pending ? "Verificar conexão" : "Gerar código",
          async () => {
            if (pending) {
              const r = await refreshStatus();
              pairingModal(r.spotify);
            } else {
              const r = await api("/spotify/auth/start", "POST", {});
              pairingModal(r);
            }
          },
          "primary",
        ),
      ];
  modal(
    modalFrame(
      connected ? "Spotify conectado" : "Conectar ao Spotify",
      box,
      actions,
    ),
  );
  const generation = pairingGeneration;
  if (pending && !connected) {
    watchPairing(status, generation);
  }
}
function watchPairing(status, generation) {
  pairingTimer = setTimeout(async () => {
    try {
      const next = await api("/spotify/auth");
      if (generation === pairingGeneration && $("#modal").open) {
        if (JSON.stringify(next) === JSON.stringify(status)) {
          watchPairing(status, generation);
        } else {
          if (next.authenticated) await refreshStatus();
          pairingModal(next);
        }
      }
    } catch (error) {
      showError(error);
    }
  }, 1500);
}
async function loadLibrary() {
  const target = $("#library-content");
  if (target)
    target.replaceChildren(
      h("div", { class: "loading" }, "Lendo sua biblioteca…"),
    );
  const rows = [];
  let offset = 0,
    total = Infinity;
  while (offset < total) {
    const data = await tool("get_playlists", { offset, limit: 50 });
    const batch = data.playlists || [];
    rows.push(...batch);
    total = data.total ?? rows.length;
    if (!batch.length) break;
    offset += batch.length;
  }
  state.playlists = rows;
  if (state.view === "library") replaceView();
  return rows;
}
function libraryView() {
  return h(
    "div",
    {},
    h("div", { class: "eyebrow" }, "Sua coleção"),
    h("h1", {}, "Música que fica."),
    h(
      "p",
      { class: "muted small" },
      "Revisite suas playlists e encontre o próximo ponto de partida.",
    ),
    h(
      "div",
      { class: "tabs" },
      button(
        "Playlists" + (state.playlists ? " · " + state.playlists.length : ""),
        () => {
          state.libraryTab = "playlists";
          state.selected = null;
          replaceView();
        },
        state.libraryTab === "playlists" ? "active" : "",
      ),
      button(
        "♡ Músicas curtidas",
        async () => {
          state.libraryTab = "liked";
          state.selected = null;
          if (!state.liked.length) await loadLiked();
          replaceView();
        },
        state.libraryTab === "liked" ? "active" : "",
      ),
    ),
    h(
      "div",
      { class: "toolbar" },
      h("input", {
        type: "search",
        placeholder:
          state.libraryTab === "liked"
            ? "Filtrar músicas carregadas…"
            : "Filtrar suas playlists…",
        value: state.libraryFilter,
        "aria-label": "Filtrar biblioteca",
        onInput: (e) => {
          state.libraryFilter = e.target.value;
          state.selected = null;
          const area = $("#library-content");
          if (area) area.replaceChildren(libraryContent());
        },
      }),
      button(
        "↻",
        async () => {
          if (state.libraryTab === "liked") {
            state.liked = [];
            await loadLiked();
          } else await loadLibrary();
        },
        "ghost",
        { "aria-label": "Atualizar biblioteca" },
      ),
      button("+ Nova playlist", () => newDraft(), "primary small"),
    ),
    h("div", { id: "library-content" }, libraryContent()),
  );
}
function libraryContent() {
  if (state.selected) return selectedPlaylist();
  if (state.libraryTab === "liked")
    return h(
      "div",
      {},
      h(
        "div",
        { class: "list-heading row between" },
        h("h3", {}, "Músicas curtidas"),
        h("span", { class: "small muted" }, state.liked.length + " carregadas"),
      ),
      state.liked.length
        ? state.liked
            .filter((t) =>
              ((t.name || "") + " " + artist(t))
                .toLocaleLowerCase()
                .includes(state.libraryFilter.toLocaleLowerCase()),
            )
            .map((t, i) => trackRow(t, i))
        : h("div", { class: "empty" }, "Nenhuma música carregada."),
      state.likedMore && button("Carregar mais", loadLiked, "ghost"),
    );
  if (!state.playlists)
    return h("div", { class: "empty" }, "Carregando playlists…");
  const rows = state.playlists.filter((p) =>
    (p.name || "")
      .toLocaleLowerCase()
      .includes(state.libraryFilter.toLocaleLowerCase()),
  );
  return rows.length
    ? h(
        "div",
        { class: "playlist-grid" },
        rows.map((p) =>
          h(
            "button",
            {
              type: "button",
              class: "playlist-card",
              onClick: () => safe(() => openPlaylist(p)),
            },
            h("div", { class: "playlist-art", "aria-hidden": true }, "≋"),
            h(
              "div",
              { class: "playlist-info" },
              h("strong", {}, p.name || "Playlist"),
              h(
                "small",
                {},
                (typeof p.tracks === "number"
                  ? p.tracks + " faixas"
                  : "Playlist") + " · Spotify",
              ),
            ),
          ),
        ),
      )
    : h(
        "div",
        { class: "empty" },
        "Nenhuma playlist encontrada com esse nome.",
      );
}
async function loadLiked() {
  const data = await tool("get_saved_tracks", {
    limit: 50,
    offset: state.liked.length,
  });
  const batch = tracks(data);
  state.liked.push(...batch);
  state.likedMore = batch.length === 50;
  if (state.view === "library") replaceView();
}
async function openPlaylist(p) {
  const data = await tool("get_playlist_tracks", {
    playlist_id: playlistId(p),
  });
  state.selected = { ...p, id: playlistId(p), items: tracks(data) };
  state.libraryTab = "playlists";
  state.view = "library";
  render();
}
function selectedPlaylist() {
  const p = state.selected;
  return h(
    "div",
    {},
    button(
      "← Todas as playlists",
      () => {
        state.selected = null;
        replaceView();
      },
      "ghost small",
    ),
    h(
      "div",
      { class: "list-heading" },
      h("h2", {}, p.name || "Playlist"),
      p.description && h("p", { class: "small muted" }, p.description),
      h(
        "div",
        { class: "row between" },
        h("span", { class: "small muted" }, p.items.length + " faixas"),
        h(
          "a",
          {
            class: "small",
            href: "https://open.spotify.com/playlist/" + p.id,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Abrir no Spotify ↗",
        ),
      ),
    ),
    h(
      "div",
      { class: "toolbar" },
      button("Editar seleção", () => editPlaylist(p), "primary small"),
      button("Nome e descrição", () => editDetails(p), "small"),
      button(
        "Desfazer",
        () => runAction("undo_last_mutation", { playlist_id: p.id }),
        "small",
      ),
      button(
        "Remover da biblioteca",
        () => runAction("delete_playlist", { playlist_ids: [p.id] }),
        "ghost small danger",
      ),
    ),
    p.items.map((t, i) => trackRow(t, i)),
  );
}
function trackRow(raw, index, { draft = false } = {}) {
  const t = track(raw);
  const row = h(
    "div",
    { class: "track" + (draft ? " draft-track" : ""), draggable: draft },
    h("span", { class: "track-number" }, index + 1),
    h("div", { class: "track-art", "aria-hidden": true }, "♪"),
    h(
      "div",
      { class: "flex" },
      h(
        "div",
        { class: "track-title", title: t.name || t.title || uri(t) },
        t.name ||
          t.title ||
          (t.metadata_unavailable ? "Música indisponível" : uri(t)),
      ),
      h("div", { class: "track-artist" }, artist(t)),
    ),
    !draft &&
      h("span", { class: "duration" }, duration(t.duration_ms || t.duration)),
    h(
      "div",
      { class: "track-actions" },
      draft
        ? [
            button("↑", () => moveTrack(index, -1), "ghost", {
              "aria-label": "Mover " + (t.name || "faixa") + " para cima",
              disabled: index === 0,
            }),
            button("↓", () => moveTrack(index, 1), "ghost", {
              "aria-label": "Mover " + (t.name || "faixa") + " para baixo",
              disabled: index === state.draft.tracks.length - 1,
            }),
            button(
              "×",
              () => {
                state.draft.tracks.splice(index, 1);
                renderReview();
              },
              "ghost",
              {
                "aria-label": "Remover " + (t.name || "faixa") + " da seleção",
              },
            ),
          ]
        : button("+", () => addDraft(t), "ghost", {
            "aria-label": "Adicionar " + (t.name || "faixa") + " à seleção",
          }),
    ),
  );
  if (draft) {
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(index));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () =>
      row.classList.remove("drop-target"),
    );
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (
        !Number.isInteger(from) ||
        from < 0 ||
        from >= state.draft.tracks.length
      )
        return;
      const [item] = state.draft.tracks.splice(from, 1);
      state.draft.tracks.splice(index, 0, item);
      renderReview();
    });
  }
  return row;
}
function searchView() {
  const input = h("input", {
    type: "search",
    placeholder: "Música, artista, álbum ou playlist",
    value: state.query,
    "aria-label": "Buscar no Spotify",
    required: true,
  });
  const form = h(
    "form",
    {
      class: "toolbar",
      onSubmit: (e) => {
        e.preventDefault();
        safe(() => search(input.value));
      },
    },
    input,
    h(
      "button",
      { type: "submit", class: "primary", disabled: state.searchBusy },
      state.searchBusy ? "Buscando…" : "Buscar ↗",
    ),
  );
  const tabs = [
    ["tracks", "Músicas"],
    ["artists", "Artistas"],
    ["albums", "Álbuns"],
    ["playlists", "Playlists"],
  ];
  const rows = state.search?.[state.searchTab] || [];
  return h(
    "div",
    {},
    h("div", { class: "eyebrow" }, "Dê espaço à descoberta"),
    h("h1", {}, "Encontre o seu som."),
    h(
      "p",
      { class: "small muted" },
      "Busque no catálogo e adicione músicas à seleção ao lado.",
    ),
    form,
    h(
      "div",
      { class: "tabs" },
      tabs.map(([id, label]) =>
        button(
          label,
          () => {
            state.searchTab = id;
            replaceView();
          },
          state.searchTab === id ? "active" : "",
        ),
      ),
    ),
    !state.search
      ? h(
          "div",
          { class: "empty" },
          "Uma música leva a outra. Comece com um nome.",
        )
      : rows.length
        ? h(
            "div",
            {},
            rows.map((t, i) =>
              state.searchTab === "tracks"
                ? trackRow(t, i)
                : h(
                    "div",
                    { class: "track" },
                    h(
                      "div",
                      { class: "track-art" },
                      state.searchTab === "artists" ? "◉" : "≋",
                    ),
                    h("div", { class: "flex track-title" }, t.name),
                    state.searchTab === "playlists"
                      ? button(
                          "Ver playlist",
                          () => openPlaylist(t),
                          "small ghost",
                        )
                      : h(
                          "a",
                          {
                            class: "small",
                            href:
                              "https://open.spotify.com/" +
                              (state.searchTab === "artists"
                                ? "artist"
                                : "album") +
                              "/" +
                              t.id,
                            target: "_blank",
                            rel: "noopener noreferrer",
                          },
                          "Abrir ↗",
                        ),
                  ),
            ),
          )
        : h("div", { class: "empty" }, "Nenhum resultado nesta categoria."),
  );
}
async function search(q) {
  q = q.trim();
  if (!q || state.searchBusy) return;
  const account = state.user.id;
  state.query = q;
  state.searchBusy = true;
  if (state.view === "search") replaceView();
  try {
    const r = await tool("search_spotify", {
      q,
      limit: 20,
      types: "track,artist,album,playlist",
    });
    if (r.tracks?.length) {
      const detail = await tool("get_several_tracks", {
        ids: r.tracks.map((t) => t.id),
      });
      const enriched = tracks(detail);
      const byURI = new Map(enriched.map((t) => [uri(t), t]));
      r.tracks = r.tracks.map((t) => ({ ...t, ...(byURI.get(uri(t)) || {}) }));
    }
    state.search = r;
  } finally {
    if (state.user?.id === account) {
      state.searchBusy = false;
      if (state.view === "search") replaceView();
    }
  }
}
function newDraft() {
  const replace = () => {
    state.draft = {
      id: null,
      name: "Minha nova playlist",
      description: "",
      tracks: [],
      original: [],
      originalName: "",
      originalDescription: "",
    };
    renderReview();
  };
  if (state.draft?.tracks.length) {
    modal(
      modalFrame(
        "Começar uma nova seleção?",
        h(
          "p",
          { class: "muted" },
          "A seleção atual será descartada. Nenhuma alteração será enviada ao Spotify.",
        ),
        [
          button("Voltar", closeModal),
          button(
            "Nova seleção",
            () => {
              closeModal();
              replace();
            },
            "primary",
          ),
        ],
      ),
    );
  } else replace();
}
function editPlaylist(p) {
  const apply = () => {
    state.draft = {
      id: p.id,
      name: p.name || "Playlist",
      description: p.description || "",
      tracks: p.items.map((t) => ({ ...t })),
      original: p.items.map((t) => ({ ...t })),
      originalName: p.name || "Playlist",
      originalDescription: p.description || "",
    };
    renderReview();
    $(".review").classList.add("visible");
  };
  if (state.draft?.tracks.length)
    modal(
      modalFrame(
        "Trocar a seleção em edição?",
        h(
          "p",
          { class: "muted" },
          "O rascunho atual será substituído pela playlist escolhida.",
        ),
        [
          button("Voltar", closeModal),
          button(
            "Trocar seleção",
            () => {
              closeModal();
              apply();
            },
            "primary",
          ),
        ],
      ),
    );
  else apply();
}
function addDraft(t) {
  if (!uri(t).startsWith("spotify:track:"))
    throw Error("Essa faixa não pode ser adicionada.");
  if (!state.draft) newDraft();
  state.draft.tracks.push({ ...t });
  renderReview();
  toast("Música adicionada à seleção.");
}
function moveTrack(i, delta) {
  const to = i + delta;
  if (to < 0 || to >= state.draft.tracks.length) return;
  [state.draft.tracks[i], state.draft.tracks[to]] = [
    state.draft.tracks[to],
    state.draft.tracks[i],
  ];
  renderReview();
}
function review() {
  const d = state.draft;
  const pending = state.proposals.length;
  return h(
    "aside",
    { class: "review", "aria-label": "Revisão da playlist" },
    h(
      "div",
      { class: "review-head row between" },
      h(
        "div",
        {},
        h("div", { class: "eyebrow" }, "Antes do play"),
        h("h2", {}, "Sua seleção"),
      ),
      button(
        "×",
        () => $(".review").classList.remove("visible"),
        "ghost mobile-review",
        { "aria-label": "Fechar revisão" },
      ),
    ),
    pending > 0 &&
      h(
        "div",
        { class: "review-banner" },
        "✦ " +
          pending +
          (pending > 1 ? " alterações" : " alteração") +
          " aguardando sua aprovação.",
        button(
          "Revisar proposta",
          () => reviewProposal(state.proposals[0]),
          "primary small",
        ),
      ),
    d
      ? h(
          "div",
          { class: "review-body draft" },
          h(
            "div",
            { class: "draft-fields" },
            field(
              "Nome da playlist",
              h("input", {
                value: d.name,
                maxlength: 100,
                onInput: (e) => (d.name = e.target.value),
              }),
            ),
            field(
              "Descrição",
              h("textarea", {
                value: d.description,
                maxlength: 300,
                rows: 2,
                onInput: (e) => (d.description = e.target.value),
              }),
            ),
          ),
          h(
            "div",
            { class: "count-row" },
            h(
              "span",
              {},
              d.tracks.length +
                " faixas · " +
                (d.id ? "Editando playlist" : "Nova playlist"),
            ),
            h("span", {}, duplicateCount(d.tracks) + " repetidas"),
          ),
          h(
            "div",
            { class: "track-list" },
            d.tracks.map((t, i) => trackRow(t, i, { draft: true })),
          ),
          !d.tracks.length &&
            h(
              "div",
              { class: "empty" },
              "Use a busca ou sua biblioteca para adicionar músicas.",
            ),
          d.tracks.length > 1 &&
            button(
              "Remover repetidas",
              () => {
                const seen = new Set();
                d.tracks = d.tracks.filter((t) => {
                  const u = uri(t);
                  if (seen.has(u)) return false;
                  seen.add(u);
                  return true;
                });
                renderReview();
              },
              "ghost small",
            ),
        )
      : h(
          "div",
          { class: "review-empty" },
          h("div", { class: "record" }),
          h("h3", {}, "Uma ideia ganha forma aqui."),
          h(
            "p",
            { class: "small" },
            "Adicione músicas da biblioteca ou da busca. Reordene, refine e aprove quando estiver do seu jeito.",
          ),
          button("+ Começar uma seleção", newDraft, "ghost small"),
        ),
    h(
      "div",
      { class: "review-footer" },
      d && h("p", { class: "review-summary" }, draftSummary(d)),
      d &&
        button(
          state.jobs.size ? "Aguardando conclusão…" : "Revisar alterações ↗",
          applyDraft,
          "primary",
          { disabled: state.jobs.size > 0 || !d.name.trim() },
        ),
      d &&
        button(
          "Descartar seleção",
          () =>
            modal(
              modalFrame(
                "Descartar seleção?",
                h("p", { class: "muted" }, "Seu rascunho será apagado."),
                [
                  button("Voltar", closeModal),
                  button(
                    "Descartar",
                    () => {
                      state.draft = null;
                      closeModal();
                      renderReview();
                    },
                    "danger",
                  ),
                ],
              ),
            ),
          "ghost small",
        ),
      h(
        "span",
        { class: "small muted" },
        "◉ Você aprova antes de alterar o Spotify.",
      ),
    ),
  );
}
function renderReview() {
  const old = $(".review");
  if (!old) return;
  const open = old.classList.contains("visible");
  const next = review();
  if (open) next.classList.add("visible");
  old.replaceWith(next);
}
function duplicateCount(rows) {
  return rows.length - new Set(rows.map(uri)).size;
}
function diffCounts(before, after) {
  const a = new Map(),
    b = new Map();
  before.forEach((t) => a.set(uri(t), (a.get(uri(t)) || 0) + 1));
  after.forEach((t) => b.set(uri(t), (b.get(uri(t)) || 0) + 1));
  let add = 0,
    remove = 0;
  for (const [u, n] of b) add += Math.max(0, n - (a.get(u) || 0));
  for (const [u, n] of a) remove += Math.max(0, n - (b.get(u) || 0));
  return {
    add,
    remove,
    reordered: before.map(uri).join() !== after.map(uri).join(),
  };
}
function draftSummary(d) {
  if (!d.id)
    return (
      "Nova playlist · " +
      d.tracks.length +
      " faixas. A criação será confirmada na próxima etapa."
    );
  const changes = diffCounts(d.original, d.tracks);
  return (
    "+" +
    changes.add +
    " adições · −" +
    changes.remove +
    " remoções" +
    (changes.reordered ? " · ordem atualizada" : " · mesma ordem")
  );
}
async function applyDraft() {
  const d = state.draft;
  if (!d || !d.name.trim()) return;
  if (d.id) {
    const changed = diffCounts(d.original, d.tracks).reordered;
    const details =
      d.name !== d.originalName || d.description !== d.originalDescription;
    if (!changed && !details) {
      toast("A seleção não tem alterações.");
      return;
    }
    if (changed && details) {
      modal(
        modalFrame(
          "Aplicar em duas etapas",
          h(
            "p",
            { class: "muted" },
            "Primeiro serão revisadas as músicas e a ordem. Depois, use “Revisar alterações” novamente para confirmar o nome e a descrição. Cada etapa tem sua própria confirmação e opção de desfazer.",
          ),
          [
            button("Voltar", closeModal),
            button(
              "Revisar músicas",
              () => {
                closeModal();
                return runAction("replace_playlist_tracks", {
                  playlist_id: d.id,
                  uris: d.tracks.map(uri),
                });
              },
              "primary",
            ),
          ],
        ),
      );
    } else if (changed)
      await runAction("replace_playlist_tracks", {
        playlist_id: d.id,
        uris: d.tracks.map(uri),
      });
    else
      await runAction("set_playlist_details", {
        playlist_id: d.id,
        name: d.name,
        description: d.description,
      });
  } else
    await runAction("create_playlist", {
      name: d.name,
      description: d.description,
      tracks: d.tracks.map(uri),
    });
}
function editDetails(p) {
  const name = h("input", { value: p.name || "", maxlength: 100 });
  const description = h("textarea", {
    value: p.description || "",
    maxlength: 300,
  });
  modal(
    modalFrame(
      "Nome e descrição",
      h(
        "div",
        { class: "stack" },
        field("Nome", name),
        field("Descrição", description),
      ),
      [
        button("Voltar", closeModal),
        button(
          "Revisar mudança",
          () => {
            closeModal();
            return runAction("set_playlist_details", {
              playlist_id: p.id,
              name: name.value,
              description: description.value,
            });
          },
          "primary",
        ),
      ],
    ),
  );
}
async function runAction(name, args) {
  if (state.jobs.size) throw Error("another_change_is_pending");
  const job = await api("/actions", "POST", { name, arguments: args });
  state.jobs.add(job.id);
  renderReview();
  toast("Preparando alteração para sua revisão…");
  await refreshProposals();
  safe(() => watchJob(job.id, name, args));
}
async function watchJob(id, name, args) {
  const account = state.user?.id;
  try {
    for (let i = 0; i < 360 && state.user?.id === account; i++) {
      const job = await api("/jobs/" + id);
      if (!["pending", "running"].includes(job.status)) {
        if (job.status === "succeeded") {
          toast("Alteração concluída no Spotify.");
          const result = job.result?.data || job.result || {};
          if (state.draft) {
            const d = state.draft;
            const submittedTracks = (args.uris || args.tracks || []).map(
              (u) => d.tracks.find((t) => uri(t) === u) || { uri: u, name: u },
            );
            if (name === "create_playlist" && result.playlist_id && !d.id) {
              state.draft.id = result.playlist_id;
              state.draft.originalName = args.name;
              state.draft.originalDescription = args.description || "";
              state.draft.original = submittedTracks;
            }
            if (name === "replace_playlist_tracks" && d.id === args.playlist_id)
              state.draft.original = submittedTracks;
            if (name === "set_playlist_details" && d.id === args.playlist_id) {
              if (args.name !== undefined) state.draft.originalName = args.name;
              if (args.description !== undefined)
                state.draft.originalDescription = args.description;
            }
          }
          state.playlists = null;
          if (state.view === "library") {
            await loadLibrary();
            if (state.selected && name !== "delete_playlist")
              await openPlaylist(
                state.playlists.find(
                  (p) => playlistId(p) === state.selected.id,
                ) || state.selected,
              );
            else if (name === "delete_playlist") {
              state.selected = null;
              replaceView();
            }
          }
        } else {
          const code =
            job.result?.code ||
            job.result?.error ||
            "operation_interrupted_verify_state";
          toast(errors[code] || "A alteração não foi concluída: " + code, true);
        }
        await refreshProposals();
        if (state.view === "activity") await loadActivity();
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      await refreshProposals();
    }
    toast(
      "A operação continua no servidor. Consulte Atividade e atualize a playlist antes de repetir.",
      true,
    );
  } finally {
    state.jobs.delete(id);
    renderReview();
  }
}
async function refreshProposals() {
  const r = await api("/proposals");
  const proposals = r.proposals || [];
  if (JSON.stringify(state.proposals) !== JSON.stringify(proposals)) {
    state.proposals = proposals;
    renderReview();
  }
  return state.proposals;
}
async function reviewProposal(p) {
  const name = p.name.replace(/^spotify_/, "");
  const args = p.args || {};
  let before = [],
    after = [],
    readError = "";
  const id = args.playlist_id || args.playlist_ids?.[0];
  if (id) {
    try {
      before = tracks(await tool("get_playlist_tracks", { playlist_id: id }));
    } catch {
      readError = "Não foi possível carregar a versão atual para comparação.";
    }
  }
  if (name === "replace_playlist_tracks")
    after = (args.uris || []).map(
      (u) => before.find((t) => uri(t) === u) || { uri: u, name: u },
    );
  else if (name === "add_tracks")
    after = [...before, ...(args.uris || []).map((u) => ({ uri: u, name: u }))];
  else if (name === "remove_tracks")
    after = before.filter((t) => !(args.uris || []).includes(uri(t)));
  else if (name === "create_playlist")
    after = (args.tracks || []).map((t) =>
      typeof t === "string"
        ? { uri: t, name: t }
        : { name: [t.artist, t.title].filter(Boolean).join(" — "), uri: t.uri },
    );
  else after = before;
  const needed = [
    ...new Set(
      after
        .filter((t) => t.name === t.uri && uri(t).startsWith("spotify:track:"))
        .map((t) => uri(t).split(":").pop()),
    ),
  ];
  if (needed.length && needed.length <= 100) {
    try {
      const resolved = tracks(
        await tool("get_several_tracks", { ids: needed }),
      );
      const map = new Map(resolved.map((t) => [uri(t), t]));
      after = after.map((t) => map.get(uri(t)) || t);
    } catch {
      /* Proposal remains reviewable by URI. */
    }
  }
  const counts = diffCounts(before, after);
  const content = h(
    "div",
    { class: "stack" },
    h(
      "p",
      { class: "muted" },
      name === "delete_playlist"
        ? "Esta playlist será removida da sua biblioteca."
        : name === "undo_last_mutation"
          ? "O último estado salvo desta playlist será restaurado."
          : name === "create_playlist"
            ? "Será criada uma playlist com as músicas abaixo."
            : name === "set_playlist_details"
              ? "Confira o novo nome e a descrição antes de aplicar."
              : "Confira as músicas e a ordem final antes de aplicar.",
    ),
    args.name &&
      h(
        "div",
        { class: "notice" },
        "Nome: " + args.name,
        args.description &&
          h("p", { class: "small" }, "Descrição: " + args.description),
      ),
    readError && h("div", { class: "notice error" }, readError),
    [
      "replace_playlist_tracks",
      "add_tracks",
      "remove_tracks",
      "create_playlist",
    ].includes(name) &&
      h(
        "div",
        {},
        h(
          "div",
          { class: "diff" },
          h(
            "div",
            {},
            h("span", { class: "eyebrow" }, "Antes"),
            h("strong", {}, before.length),
            h("span", { class: "small muted" }, "faixas"),
          ),
          h(
            "div",
            {},
            h("span", { class: "eyebrow" }, "Depois"),
            h("strong", { class: "metric" }, after.length),
            h(
              "span",
              { class: "small muted" },
              "+" + counts.add + " · −" + counts.remove,
            ),
          ),
        ),
        h("div", { class: "small muted" }, "Ordem final das músicas:"),
        h(
          "ol",
          { class: "proposal-list" },
          after.map((t) =>
            h(
              "li",
              {},
              t.name || t.uri,
              artist(t) !== "Spotify" ? " — " + artist(t) : "",
            ),
          ),
        ),
      ),
    id &&
      h(
        "a",
        {
          class: "small",
          href: "https://open.spotify.com/playlist/" + id,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "Conferir playlist no Spotify ↗",
      ),
    h(
      "p",
      { class: "small muted" },
      "A aprovação autoriza esta operação. O resultado aparece quando o Spotify responder.",
    ),
  );
  const decide = async (decision) => {
    await api("/proposals/" + p.proposalId, "POST", { decision });
    closeModal();
    await refreshProposals();
    toast(
      decision === "approve"
        ? "Alteração aprovada. Aguardando o Spotify…"
        : "Alteração recusada.",
    );
  };
  const edit = async () => {
    await api("/proposals/" + p.proposalId, "POST", { decision: "reject" });
    const existing = state.playlists?.find((x) => playlistId(x) === id);
    const draftName = args.name || existing?.name || "Minha playlist";
    const draftDescription = args.description ?? existing?.description ?? "";
    state.draft = {
      id: id || null,
      name: draftName,
      description: draftDescription,
      tracks: after,
      original: before,
      originalName: draftName,
      originalDescription: draftDescription,
    };
    closeModal();
    await refreshProposals();
    $(".review")?.classList.add("visible");
    toast("Proposta recusada e copiada para uma seleção editável.");
  };
  modal(
    modalFrame(names[name] || "Revisar alteração", content, [
      button("Recusar", () => decide("reject"), "danger"),
      [
        "replace_playlist_tracks",
        "add_tracks",
        "remove_tracks",
        "create_playlist",
      ].includes(name) && button("Editar seleção", edit),
      button("Aprovar alteração", () => decide("approve"), "primary"),
    ]),
  );
}
async function loadActivity() {
  const r = await api("/activity");
  state.activity = r.activity;
  if (state.view === "activity") replaceView();
}
function activityView() {
  const labels = {
    succeeded: "Concluído",
    failed: "Falhou",
    approved: "Autorizado",
    rejected: "Recusado",
    interrupted: "Interrompido",
  };
  return h(
    "div",
    {},
    h("div", { class: "eyebrow" }, "O caminho da sua coleção"),
    h("h1", {}, "Cada mudança tem história."),
    h(
      "p",
      { class: "small muted" },
      "Acompanhe as decisões e os resultados das alterações manuais e do agente.",
    ),
    button("↻ Atualizar", loadActivity, "ghost small"),
    state.activity.length
      ? state.activity.map((a) =>
          h(
            "article",
            { class: "activity" },
            h(
              "div",
              { class: "row between" },
              h("h3", {}, names[a.title] || a.title),
              h(
                "span",
                { class: "badge " + a.status },
                labels[a.status] || a.status,
              ),
            ),
            h("time", {}, new Date(a.created * 1000).toLocaleString("pt-BR")),
            h(
              "p",
              { class: "muted" },
              a.kind === "decision"
                ? "Decisão de aprovação. O resultado da operação é registrado separadamente."
                : a.status === "succeeded"
                  ? "O Spotify confirmou a operação."
                  : "Confira o estado da playlist antes de repetir.",
            ),
            a.data.arguments?.playlist_id &&
              button(
                "Ver playlist",
                () =>
                  openPlaylist(
                    state.playlists?.find(
                      (p) => p.id === a.data.arguments.playlist_id,
                    ) || { id: a.data.arguments.playlist_id, name: "Playlist" },
                  ),
                "ghost small",
              ),
            a.data.code &&
              h(
                "p",
                { class: "small muted" },
                errors[a.data.code] || a.data.code,
              ),
          ),
        )
      : h(
          "div",
          { class: "empty" },
          "As alterações e suas aprovações aparecerão aqui.",
        ),
  );
}
async function loadSettings() {
  const [s, p] = await Promise.all([api("/settings"), api("/providers")]);
  state.settings = s.settings;
  state.providers = p.providers || [];
  if (state.view === "settings") replaceView();
}
function settingsView() {
  if (!state.settings)
    return h("div", { class: "loading" }, "Carregando suas preferências…");
  const s = state.settings;
  const provider = h(
    "select",
    { "aria-label": "Provedor de IA" },
    state.providers.map((p) =>
      h("option", { value: p.id }, p.name + (p.hasKey ? " · chave salva" : "")),
    ),
  );
  provider.value = s.activeProvider;
  const current = () =>
    state.providers.find((p) => p.id === provider.value) || {};
  const model = h("input", {
    value: s.activeModel || "",
    placeholder: "Nome do modelo",
    list: "model-options",
    required: true,
  });
  const list = h(
    "datalist",
    { id: "model-options" },
    (current().models || []).map((m) =>
      h("option", { value: typeof m === "string" ? m : m.id }),
    ),
  );
  const key = h("input", {
    type: "password",
    autocomplete: "new-password",
    placeholder: current().hasKey
      ? "Chave já salva. Deixe vazio para manter."
      : "Cole a chave deste provedor",
  });
  const base = h("input", {
    type: "url",
    value: current().baseUrl || "",
    placeholder: "https://seu-provedor/v1",
  });
  const instructions = h("textarea", {
    value: s.instructions || "",
    rows: 5,
    placeholder:
      "Ex.: prefiro MPB e jazz; evite versões ao vivo; pergunte antes de misturar gêneros.",
  });
  const turns = h("input", {
    type: "number",
    min: 1,
    max: 100,
    value: s.chatHistoryTurns || 20,
  });
  const steps = h("input", {
    type: "number",
    min: 1,
    max: 50,
    value: s.maxToolSteps || 12,
  });
  provider.addEventListener("change", () => {
    const p = current();
    base.value = p.baseUrl || "";
    model.value = p.defaultModel || p.models?.[0]?.id || p.models?.[0] || "";
    key.value = "";
    key.placeholder = p.hasKey
      ? "Chave já salva. Deixe vazio para manter."
      : "Cole a chave deste provedor";
    list.replaceChildren(
      ...(p.models || []).map((m) =>
        h("option", { value: typeof m === "string" ? m : m.id }),
      ),
    );
  });
  const config = () => ({
    provider: provider.value,
    model: model.value.trim(),
    baseUrl: base.value.trim(),
    ...(key.value ? { apiKey: key.value } : {}),
  });
  const save = async () => {
    if (!model.value.trim()) throw Error("Informe o nome do modelo.");
    const p = current();
    await api("/providers", "POST", {
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: base.value.trim() || p.baseUrl,
      defaultModel: model.value.trim(),
      ...(key.value ? { apiKey: key.value } : {}),
    });
    await api("/settings", "PUT", {
      activeProvider: p.id,
      activeModel: model.value.trim(),
      profiles: [
        {
          id: "web-default",
          name: "Meu agente",
          provider: p.id,
          model: model.value.trim(),
          temperature: 0.7,
          max_tokens: 4096,
          base_url: base.value.trim() || null,
        },
      ],
      activeProfile: "web-default",
      roleProfiles: { chat: "web-default", curation: "web-default" },
      instructions: instructions.value,
      chatHistoryTurns: Number(turns.value),
      maxToolSteps: Number(steps.value),
    });
    key.value = "";
    toast("Preferências salvas.");
    await loadSettings();
  };
  return h(
    "div",
    {},
    h("div", { class: "eyebrow" }, "Afine sua experiência"),
    h("h1", {}, "Um agente com o seu ritmo."),
    h(
      "p",
      { class: "small muted" },
      "Escolha o modelo e conte como você gosta de ouvir música.",
    ),
    h(
      "div",
      { class: "settings-form" },
      state.sso.enabled && h("section", { class: "settings-card stack" },
        h("h2", {}, "Conta RDA"),
        h("p", { class: "small muted" }, state.ssoLinked
          ? "Sua conta está vinculada ao RDA. Seus dados e sua conexão Spotify continuam neste espaço."
          : "Vincule sua conta para entrar com RDA e manter os dados deste espaço. Depois da vinculação, o acesso será pelo RDA."),
        !state.ssoLinked && button("Vincular conta RDA", async () => {
          const result = await api("/account/sso/link", "POST", {});
          const target = new URL(result.url);
          if (target.origin !== "https://id.reversodoavesso.com") throw Error("request_failed");
          window.location.assign(target.href);
        }, "primary")),
      h(
        "section",
        { class: "settings-card stack" },
        h("h2", {}, "Inteligência artificial"),
        field("Provedor", provider),
        field("Modelo", model),
        list,
        field("Chave de API", key),
        field("Endereço do provedor", base),
        h(
          "p",
          { class: "small muted" },
          "As chaves ficam no servidor, dentro do seu espaço. O teste envia uma pequena requisição ao provedor escolhido.",
        ),
        h(
          "div",
          { class: "row" },
          button(
            "Listar modelos",
            async () => {
              const r = await api(
                "/models?provider=" + encodeURIComponent(provider.value),
              );
              list.replaceChildren(
                ...(r.models || []).map((m) =>
                  h("option", { value: typeof m === "string" ? m : m.id }),
                ),
              );
              toast("Modelos atualizados. Digite ou escolha um modelo.");
            },
            "small",
          ),
          button(
            "Testar conexão",
            async () => {
              const r = await api("/providers/test", "POST", config());
              toast(
                "Conexão funcionando" +
                  (r.latencyMs ? " · " + r.latencyMs + " ms" : "") +
                  ".",
              );
            },
            "small",
          ),
        ),
      ),
      h(
        "section",
        { class: "settings-card stack" },
        h("h2", {}, "Seu gosto, suas regras"),
        field("Preferências para o agente", instructions),
        h(
          "div",
          { class: "field-pair" },
          field("Mensagens no contexto", turns),
          field("Etapas por resposta", steps),
        ),
        h(
          "div",
          { class: "notice" },
          "Toda alteração de playlist exige sua aprovação. Essa regra também vale para o agente.",
        ),
      ),
      button("Salvar preferências", save, "primary"),
      h(
        "section",
        { class: "settings-card stack" },
        h("h2", {}, "Sua conexão Spotify"),
        h(
          "p",
          { class: "small muted" },
          state.status?.spotify?.authenticated
            ? "Sua conta está conectada e salva neste servidor."
            : "Conecte sua conta para acessar a biblioteca.",
        ),
        button("Gerenciar conexão", pairSpotify),
        h("h3", {}, "Disponível nesta versão"),
        h(
          "p",
          { class: "small muted" },
          "Biblioteca, curtidas, busca de músicas/artistas/álbuns/playlists, criação e edição de playlists, revisão, aprovação e desfazer.",
        ),
        h(
          "p",
          { class: "small muted" },
          "Player, capas personalizadas e recomendações nativas ainda dependem da expansão do backend headless.",
        ),
      ),
    ),
  );
}
async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    while (state.user) {
      await new Promise((r) =>
        setTimeout(r, state.streaming || state.jobs.size ? 1200 : 5000),
      );
      if (!state.user) break;
      try {
        await refreshProposals();
      } catch {
        /* Connection errors are shown by explicit user actions. */
      }
    }
  } finally {
    state.polling = false;
  }
}
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) closeModal();
});
(async () => {
  try {
    state.sso = await api("/account/sso/config");
  } catch {
    state.sso = { enabled: false };
  }
  try {
    const r = await api("/me");
    await signedIn(r);
  } catch {
    render();
  }
})();
