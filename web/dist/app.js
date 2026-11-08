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
  libraryOwnership: "all",
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
  audit: null,
  auditConversation: "",
  auditFilter: "all",
  auditLoading: false,
  auditGeneration: 0,
  activity: [],
  workbench: null,
  workbenchConversation: "",
  workbenchGeneration: 0,
  workbenchDataset: "",
  workbenchPage: null,
  workbenchPreview: null,
  polling: false,
  authMode: "login",
  sso: { enabled: false },
  ssoLinked: false,
  startup: null,
  startupAbort: null,
  startupGeneration: 0,
  curations: [],
  activeCuration: null,
  curationsTab: "projects",
  editorialModels: null,
  workflowSelectedStep: null,
  workflowMode: "canvas",
  workflowValidation: null,
  workflowExecution: null,
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
  context_budget_exceeded: "A solicitação excedeu o orçamento de contexto. Use uma seleção menor ou uma operação em lotes.",
  invalid_analysis_response: "O modelo devolveu uma avaliação inválida. O checkpoint anterior foi preservado.",
  invalid_analysis_evidence: "A avaliação citou dados ausentes ou não trouxe evidências válidas. O checkpoint foi preservado.",
  analysis_profile_changed: "O perfil do modelo mudou durante a análise. Inicie uma nova análise para manter critérios comparáveis.",
  artist_metadata_required_for_diversity: "Faltam artistas em algumas faixas; não é possível garantir esse limite de diversidade.",
  versioned_dataset_required: "Atualize a leitura da playlist antes de aplicar esta seleção.",
  selection_review_required: "Conclua a revisão curatorial desta seleção antes de solicitar a aplicação.",
  invalid_review_response: "A revisão do modelo veio em formato inválido. A seleção foi preservada para uma nova tentativa.",
  unsupported_track_type_for_write: "A playlist contém tipos de faixa que o backend não consegue restaurar com segurança. A análise continua disponível.",
  selection_exceeds_spotify_write_limit: "A seleção excede o limite de escrita reversível do backend.",
  playlist_id_required: "Informe o ID da playlist que será consultada.",
  invalid_ownership: "Escolha Todas, Criadas por mim ou Seguindo para filtrar as playlists.",
  stream_interrupted: "A conexão de resposta da IA foi interrompida. Os resultados já processados estão na auditoria e nas operações.",
  playlist_version_conflict: "A playlist mudou desde a leitura. Atualize os dados e gere uma nova prévia antes de aprovar.",
  incomplete_dataset: "A leitura está incompleta. Aguarde a operação terminar antes de calcular ou alterar a playlist.",
  workspace_reference_unavailable: "A referência não está disponível nesta conversa. Atualize os dados da operação.",
  not_applied_fresh_preview_required: "A alteração não foi aplicada. Gere uma nova prévia para solicitar outra aprovação.",
  write_verification_mismatch: "O resultado do Spotify difere da seleção. Confira o estado antes de repetir a alteração.",
  step_limit_reached: "O agente atingiu o limite de etapas antes de concluir. Consulte a auditoria e simplifique a solicitação.",
  quota_exhausted: "A cota de IA do Euterpe foi atingida. Revise o limite no painel de IA antes de tentar novamente.",
  empty_response: "O agente encerrou a solicitação sem entregar uma resposta. Consulte a auditoria da conversa.",
  provider_error: "O serviço de IA falhou. Consulte a auditoria antes de tentar novamente.",
  provider_test_failed: "Não foi possível concluir a chamada ao serviço de IA.",
  rate_limited: "O serviço de IA limitou as chamadas. Aguarde antes de tentar novamente.",
  unauthorized: "O serviço de IA recusou a credencial ou a permissão do Euterpe.",
  timeout: "O serviço de IA excedeu o tempo de resposta.",
  chat_interrupted: "A resposta foi interrompida. Confira a auditoria antes de repetir alterações no Spotify.",
  tool_failed: "Uma ou mais ferramentas falharam. Confira os resultados na auditoria desta conversa.",
  rda_sso_required: "Esta conta já usa RDA. Entre pelo botão Entrar com RDA.",
  sso_login_failed: "Não foi possível entrar com RDA. Inicie o login novamente.",
  sso_identity_already_linked: "Esta identidade RDA já está vinculada a outra conta Euterpe.",
  local_account_already_linked: "Esta conta Euterpe já está vinculada ao RDA.",
  local_account_proof_expired: "Sua sessão local expirou. Entre novamente antes de vincular.",
  invalid_token_name: "Informe um nome para o token, com até 80 caracteres.",
  invalid_token_options: "Escolha uma permissão e uma validade inteira entre 1 e 90 dias.",
  token_limit: "Você atingiu o limite de 20 tokens ativos. Revogue um token antes de gerar outro.",
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
  const finalAttrs = { ...attrs };
  if (tag === "input") {
    const t = finalAttrs.type || "text";
    if (t === "checkbox") {
      finalAttrs.class = ["rda-checkbox-native", finalAttrs.class || ""].filter(Boolean).join(" ");
    } else if (t === "radio") {
      finalAttrs.class = ["rda-radio-native", finalAttrs.class || ""].filter(Boolean).join(" ");
    } else {
      finalAttrs.class = ["rda-input", "rda-input--md", finalAttrs.class || ""].filter(Boolean).join(" ");
    }
  } else if (tag === "select") {
    finalAttrs.class = ["rda-select__field", "rda-select__field--md", finalAttrs.class || ""].filter(Boolean).join(" ");
  } else if (tag === "textarea") {
    finalAttrs.class = ["rda-textarea__field", "rda-textarea__field--md", finalAttrs.class || ""].filter(Boolean).join(" ");
  }

  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(finalAttrs)) {
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
function icon(name, size = "1em") {
  return h("rda-icon", { name, size, "aria-hidden": "true" });
}
function button(text, fn, cls = "", attrs = {}) {
  const isSm = cls.includes("small") || cls.includes("sm") || cls.includes("icon-btn");
  const sizeCls = isSm ? "rda-button--sm" : "rda-button--md";
  let color = "secondary";
  let style = "matte";
  if (cls.includes("primary") || cls.includes("cta")) {
    color = "primary";
    style = "solid";
  } else if (cls.includes("danger")) {
    color = "danger";
    style = "outlined";
  } else if (cls.includes("ghost") || cls.includes("subtle")) {
    color = "ghost";
    style = "matte";
  } else if (cls.includes("nav-btn")) {
    color = "ghost";
    style = "matte";
  }
  const finalCls = ["rda-button", sizeCls, cls].filter(Boolean).join(" ");
  const mergedAttrs = {
    type: "button",
    "data-wrap": "true",
    "data-color": attrs["data-color"] || color,
    "data-style": attrs["data-style"] || style,
    ...attrs,
    class: finalCls,
    onClick: () => safe(fn),
  };
  return h("button", mergedAttrs, text);
}
function badge(text, kind = "secondary", attrs = {}) {
  const isSm = !attrs.size || attrs.size === "sm";
  const sizeCls = isSm ? "rda-badge--sm" : "rda-badge--md";
  const cls = ["badge", "rda-badge", sizeCls, attrs.class || ""].filter(Boolean).join(" ");
  return h(
    "span",
    {
      "data-wrap": "true",
      "data-color": kind,
      "data-style": attrs.style || "glass",
      ...attrs,
      class: cls,
    },
    text,
  );
}
function safe(fn) {
  return Promise.resolve().then(fn).catch(showError);
}
function toast(text, error = false) {
  const n = h(
    "div",
    {
      class: "toast rda-toast rda-toast--md" + (error ? " error" : ""),
      "data-color": error ? "danger" : "success",
      "data-style": "elevated",
      role: "status",
    },
    h("div", { class: "rda-toast__content" }, text),
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
    { class: "brand rda-sidebar__header" },
    h("img", { src: "/logo.svg", alt: "Euterpe Logo", class: "rda-logo rda-logo--sm brand-logo" }),
    h("span", { class: "rda-typography rda-typography--lg rda-typography--bold brand-name" }, "euterpe"),
  );
}
function field(label, input, help = "") {
  return h(
    "label",
    { class: "field rda-form-field" },
    h("span", { class: "rda-form-label" }, label),
    input,
    help ? h("small", { class: "rda-form-hint" }, help) : null,
  );
}
function pill() {
  const isAuth = state.status?.spotify?.authenticated;
  return button(
    h(
      "span",
      { class: "row", style: "gap: 6px" },
      h("i", { class: "dot" }),
      isAuth ? "Spotify conectado" : "Conectar Spotify",
    ),
    pairSpotify,
    "pill rda-button--sm " + (isAuth ? "online" : ""),
    {
      "data-color": isAuth ? "primary" : "ghost",
      "data-style": "outlined",
      "aria-label": isAuth
        ? "Ver conexão Spotify"
        : "Conectar conta Spotify",
    },
  );
}
function render() {
  const app = $("#app");
  app.replaceChildren(!state.user ? authScreen() : state.startup ? startupScreen() : shell());
}
function startupScreen() {
  const failed = state.startup.status === "error";
  const opening = state.startup.step === "workspace";
  const steps = [
    ["Sua conta foi confirmada", "complete"],
    ["Preparando o ambiente de computação", opening ? "complete" : failed ? "pending" : "active"],
    ["Abrindo seu espaço musical", opening && !failed ? "active" : "pending"],
  ];
  return h("main", { class: "startup-page", "aria-busy": String(!failed), "aria-labelledby": "startup-title" },
    h("header", { class: "startup-header" }, brand(), button("Sair", logout, "ghost")),
    h("section", { class: "startup-card" },
      h("div", { class: "startup-symbol" + (failed ? " failed" : ""), "aria-hidden": "true" }, icon(failed ? "alert-triangle" : "loader-2", "40px")),
      h("div", { class: "eyebrow" }, "Seu ambiente Euterpe"),
      h("h1", { id: "startup-title" }, failed ? "Não foi possível abrir seu espaço" : "Preparando seu espaço musical"),
      h("p", { class: "muted", role: failed ? "alert" : "status", "aria-live": "polite" },
        failed ? state.startup.message : opening ? "O ambiente está pronto. Estamos carregando suas conversas." : "Estamos verificando e iniciando seu ambiente de computação. Na primeira abertura, isso pode levar alguns instantes."),
      h("ol", { class: "startup-steps", "aria-label": "Preparação do ambiente" }, steps.map(([label, status]) =>
        h("li", { "data-state": status, "aria-current": status === "active" ? "step" : null }, icon(status === "complete" ? "circle-check" : status === "active" ? "loader-2" : "clock", "18px"), h("span", {}, label)))),
      failed && button("Tentar novamente", prepareWorkspace, "primary"),
      !failed && h("p", { class: "small muted" }, "Você pode aguardar aqui. A interface abrirá assim que o ambiente estiver disponível.")));
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
    {
      type: "submit",
      class: "primary rda-button rda-button--md",
      "data-color": "primary",
      "data-style": "solid",
      "data-wrap": "true",
    },
    register ? "Criar meu espaço" : "Entrar no meu espaço",
  );
  const err = h("div", { class: "inline-error rda-form-message rda-form-message--error", role: "alert" });
  const form = h(
    "form",
    {
      class: "auth-form-fields",
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
        h("div", { class: "record", "aria-hidden": "true" }, h("span", { class: "record-mark" }, icon("sparkles", "20px"))),
        h("div", { class: "eyebrow rda-page-header__eyebrow" }, "Um espaço para a sua música"),
        h("h1", { class: "rda-typography rda-typography--3xl rda-typography--bold" }, "Boas playlists começam com uma conversa."),
        h(
          "p",
          { class: "rda-typography rda-typography--base muted" },
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
        { class: "auth-form rda-card rda-card--p-xl", "data-color": "surface", "data-style": "matte" },
        h(
          "div",
          { class: "eyebrow rda-page-header__eyebrow" },
          register ? "Seu próximo lado A" : "Bem-vindo de volta",
        ),
        h(
          "h2",
          { class: "rda-typography rda-typography--2xl rda-typography--semibold" },
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
        state.sso.enabled && state.sso.localLoginEnabled !== false && h("p", { class: "small muted" },
          "Já possui uma conta local? Entre abaixo e vincule sua conta RDA em Ajustes para manter suas conversas e conexão Spotify."),
        state.sso.localLoginEnabled !== false && form,
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
  resetWorkbench();
  state.controller?.abort();
  state.jobs.clear();
  Object.assign(state, {
    conversation: null, conversations: [], messages: [], draft: null,
    playlists: null, liked: [], selected: null, proposals: [], status: null,
    settings: null, providers: [], activity: [], audit: null, auditConversation: "", auditLoading: false, auditGeneration: state.auditGeneration + 1, search: null, query: "",
    streaming: false, controller: null, curations: [], activeCuration: null,
    workflowSelectedStep: null, workflowValidation: null, workflowExecution: null,
  });
  state.user = r.user;
  state.ssoLinked = Boolean(r.ssoLinked);
  state.csrf = r.csrf;
  state.view = "chat";
  await prepareWorkspace();
}
async function prepareWorkspace() {
  const account = state.user?.id;
  if (!account) return;
  state.startupAbort?.abort();
  const generation = ++state.startupGeneration;
  const controller = new AbortController();
  state.startupAbort = controller;
  state.startup = { status: "starting", step: "compute" };
  render();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const current = () => generation === state.startupGeneration && state.user?.id === account;
  try {
    const status = await api("/status", "GET", undefined, { signal: controller.signal });
    if (!current()) return;
    if (!status.ready) throw Error("compute_not_ready");
    state.status = status;
    state.startup = { status: "starting", step: "workspace" };
    render();
    const data = await api("/conversations", "GET", undefined, { signal: controller.signal });
    if (!current()) return;
    state.conversations = data.conversations || [];
    state.startup = null;
    render();
    resumeWorkspace();
  } catch (error) {
    if (!current()) return;
    const capacity = ["server_capacity_busy", "runtime_capacity", "runtime_storage_capacity", errors.server_capacity_busy].includes(error.message);
    state.startup = { status: "error", step: state.startup?.step || "compute", message: capacity ? "O servidor está ocupado. Tente novamente em instantes." : error.name === "AbortError" ? "Seu ambiente está levando mais tempo do que o esperado. Tente novamente." : "Não conseguimos preparar seu ambiente agora. Aguarde um momento e tente novamente." };
    render();
  } finally {
    clearTimeout(timeout);
    if (current()) state.startupAbort = null;
  }
}
function resumeWorkspace() {
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
    ["chat", icon("sparkles"), "Conversar"],
    ["curations", icon("layers"), "Curadorias"],
    ["library", icon("layout-grid"), "Biblioteca"],
    ["search", icon("search"), "Explorar"],
    ["activity", icon("clock"), "Atividade"],
    ["audit", icon("activity"), "Auditoria"],
    ["operations", icon("layers"), "Operações"],
    ["settings", icon("settings"), "Ajustes"],
  ];
  const sidebar = h(
    "aside",
    { class: "sidebar rda-app-shell__sidebar rda-sidebar rda-sidebar--left", id: "sidebar" },
    brand(),
    h(
      "nav",
      { class: "rda-sidebar__list", "aria-label": "Navegação principal" },
      navs.map(([id, icon, label]) =>
        button(
          [
            h("span", { class: "nav-symbol rda-sidebar__item-icon", "aria-hidden": true }, icon),
            h("span", { class: "rda-sidebar__item-label" }, label),
          ],
          () => navigate(id),
          "nav-btn rda-sidebar__item" + (state.view === id ? " rda-sidebar__item--active active" : ""),
          {
            "aria-current": state.view === id ? "page" : null,
            "data-color": state.view === id ? "primary" : "ghost",
            "data-style": "matte",
          },
        ),
      ),
    ),
    h(
      "div",
      { class: "rda-sidebar__group conversation-section" },
      h(
        "div",
        { class: "rda-sidebar__group-label row between" },
        h("span", { class: "eyebrow rda-page-header__eyebrow" }, "Suas conversas"),
        button(icon("plus"), newConversation, "ghost icon-btn", {
          "aria-label": "Nova conversa",
        }),
      ),
      h(
        "div",
        { class: "rda-sidebar__group-items conversation-list" },
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
                  button(icon("pencil"), () => renameConversation(c), "ghost", {
                    "aria-label": "Renomear " + c.title,
                  }),
                  button(icon("x"), () => deleteConversation(c), "ghost", {
                    "aria-label": "Excluir " + c.title,
                  }),
                ),
              ),
            )
          : h("p", { class: "small muted" }, "Sua próxima ideia começa aqui."),
      ),
    ),
    h(
      "div",
      { class: "account rda-sidebar__footer row" },
      h(
        "div",
        { class: "avatar rda-avatar rda-avatar--sm", "data-color": "primary", "data-style": "glass" },
        h("span", { class: "rda-avatar__fallback" }, state.user.display_name.slice(0, 1).toUpperCase()),
      ),
      h(
        "div",
        { class: "flex" },
        h("div", { class: "small" }, state.user.display_name),
        h("div", { class: "small muted" }, "Espaço pessoal"),
      ),
      button(icon("log-out"), logout, "ghost icon-btn", { "aria-label": "Sair da conta" }),
    ),
  );
  const labels = {
    chat: "Seu estúdio de playlists",
    curations: "Curadorias e editor de fluxos",
    library: "Tudo o que você gosta",
    search: "Encontre seu próximo som",
    activity: "Cada escolha, registrada",
    audit: "Auditoria e diagnóstico de conversas",
    operations: "Dados, seleções e operações",
    settings: "Do seu jeito",
  };
  const main = h(
    "div",
    { class: "workspace rda-app-shell__main" },
    h(
      "header",
      { class: "topbar rda-app-shell__header row between" },
      h(
        "div",
        { class: "row" },
        button(
          icon("menu"),
          () => $("#sidebar").classList.toggle("visible"),
          "ghost mobile-menu",
          { "aria-label": "Abrir navegação" },
        ),
        h("span", { class: "eyebrow rda-page-header__eyebrow" }, labels[state.view]),
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
      "main",
      { class: "view rda-app-shell__content", id: "view", tabindex: "-1", "aria-label": labels[state.view] },
      view(),
    ),
    h(
      "footer",
      { class: "topbar-footer rda-app-shell__footer row between small muted" },
      h("span", {}, "Euterpe · Ecossistema RDA"),
      h("span", {}, "Curadoria diegética & IA soberana"),
    ),
  );
  return h("div", { class: "shell rda-app-shell", "data-layout": "console" }, sidebar, main, review());
}
function view() {
  if (state.view === "chat") return chatView();
  if (state.view === "curations") return curationsView();
  if (state.view === "library") return libraryView();
  if (state.view === "search") return searchView();
  if (state.view === "activity") return activityView();
  if (state.view === "audit") return auditView();
  if (state.view === "operations") return operationsView();
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
  if (v === "curations") await loadCurations();
  if (v === "library" && !state.playlists) await loadLibrary();
  if (v === "activity") await loadActivity();
  if (v === "audit") await loadAudit(state.conversation || state.auditConversation || state.conversations[0]?.id);
  if (v === "operations") await loadWorkbench(state.conversation || state.workbenchConversation || state.conversations[0]?.id);
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
function openModal(content) {
  return modal(content);
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
    { class: "rda-dialog__container" },
    h(
      "header",
      { class: "modal-header rda-dialog__header" },
      h(
        "div",
        {},
        h("span", { class: "eyebrow rda-page-header__eyebrow" }, "EUTERPE"),
        h("h2", { class: "rda-dialog__title" }, title),
      ),
      button(icon("x"), closeModal, "ghost icon-btn", {
        "aria-label": "Fechar janela",
      }),
    ),
    h("div", { class: "modal-body rda-dialog__body" }, content),
    h("footer", { class: "modal-actions rda-dialog__footer" }, actions),
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
  resetWorkbench();
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
  state.startupAbort?.abort();
  state.startupGeneration++;
  state.startupAbort = null;
  try {
    await api("/account/logout", "POST", {});
  } catch (error) {
    if (state.startup && state.user) {
      state.startup = { status: "error", message: "A preparação foi interrompida. Tente novamente ou saia da sua conta." };
      render();
    }
    throw error;
  }
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
    audit: null, auditConversation: "", auditLoading: false, auditGeneration: state.auditGeneration + 1,
    search: null,
    searchBusy: false,
    streaming: false,
    controller: null,
    startup: null,
    view: "chat",
    query: "",
    searchTab: "tracks",
    libraryTab: "playlists",
    libraryOwnership: "all",
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
    state.streaming ? "Parar resposta" : ["Enviar ", icon("external-link")],
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
    state.conversation && h("div", { class: "row" }, button([icon("activity"), " Auditar conversa"], () => navigate("audit"), "ghost small")),
    messages,
    h(
      "div",
      { class: "status", id: "chat-status", "aria-live": "polite" },
      state.streaming ? "O Euterpe está trabalhando…" : "",
    ),
    h(
      "div",
      { class: "composer rda-card rda-card--p-sm", "data-color": "surface", "data-style": "outlined" },
      text,
      h(
        "div",
        { class: "composer-footer" },
        h("span", { class: "small muted" }, [icon("sparkles"), " Seu gosto é o ponto de partida"]),
        submit,
      ),
    ),
    h(
      "p",
      { class: "composer-note small muted" },
      "Alterações no Spotify passam pela sua aprovação. Shift + Enter para uma nova linha.",
    ),
  );
}
function welcome() {
  const ideas = [
    [
      icon("sparkles"),
      "Organizar uma playlist",
      "Quero organizar uma playlist da minha biblioteca e remover músicas repetidas.",
    ],
    [
      icon("external-link"),
      "Descobrir novos caminhos",
      "Busque músicas de MPB para uma tarde tranquila. Primeiro me mostre as opções.",
    ],
    [
      icon("heart"),
      "Partir das minhas curtidas",
      "Consulte minhas músicas curtidas e sugira uma seleção de 20 faixas para trabalhar.",
    ],
    [
      icon("music"),
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
      h("span", { class: "star" }, icon("sparkles")),
      "Seu gosto. Novas possibilidades.",
    ),
    h("h1", { class: "rda-typography rda-typography--3xl rda-typography--bold" }, "O que vamos ouvir", h("br"), "a seguir?"),
    h(
      "p",
      { class: "muted" },
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
      { class: "welcome-note small muted" },
      icon("music"),
      state.status?.spotify?.authenticated
        ? "Sua biblioteca Spotify está pronta para explorar."
        : "Conecte o Spotify para explorar sua biblioteca.",
    ),
  );
}
function messageNode(m) {
  return h(
    "article",
    {
      class: "message " + m.role + " rda-card rda-card--p-md",
      "data-color": "surface",
      "data-style": m.role === "user" ? "matte" : "outlined",
    },
    h(
      "div",
      { class: "message-mark", "aria-hidden": true },
      m.role === "user" ? icon("user") : icon("sparkles"),
    ),
    h(
      "div",
      { class: "message-body" },
      h(
        "div",
        { class: "message-name rda-typography rda-typography--sm rda-typography--semibold" },
        m.role === "user" ? "Você" : "Euterpe",
      ),
      h("div", { class: "message-text" }, m.content),
      m.error_code && h("div", { class: "notice error chat-error", role: "alert" },
        h("p", {}, errors[m.error_code] || errors.provider_error),
        button([icon("activity"), " Ver auditoria"], () => navigate("audit"), "small ghost")),
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
          if (data.status === "error") responseMessage.error_code = errors[data.detail] ? data.detail : "provider_error";
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
        } else if (event === "tool-result") {
          if (data.ok === false && !responseMessage.error_code) responseMessage.error_code = "tool_failed";
        } else if (event === "proposal") {
          await refreshProposals();
          const node = $("#chat-status");
          if (node)
            node.textContent = "Uma alteração está aguardando sua revisão.";
        } else if (event === "error") {
          responseMessage.error_code = errors[data.code] ? data.code : "provider_error";
        } else if (event === "done") {
          complete = true;
        }
      }
      if (part.done) break;
    }
  } catch (err) {
    responseMessage.error_code = err.name === "AbortError" ? "chat_interrupted" : "provider_error";
    if (!responseMessage.content) responseMessage.content = err.name === "AbortError" ? errors.chat_interrupted : (err.message || errors.provider_error);
    if (err.name !== "AbortError") showError(err);
  } finally {
    if (state.user?.id !== account) return;
    if (!complete) responseMessage.interrupted = true;
    if (!responseMessage.content.trim()) {
      responseMessage.error_code = responseMessage.error_code || (complete ? "empty_response" : "chat_interrupted");
      responseMessage.content = errors[responseMessage.error_code] || errors.provider_error;
    }
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
            [icon("check"), " Biblioteca, busca e edição de playlists disponíveis."],
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
          ["Abrir autorização no Spotify ", icon("external-link")],
        ),
      ),
    connected && h("div", { class: "notice success" }, [icon("check"), " Conta conectada."]),
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
    h("div", { class: "eyebrow rda-page-header__eyebrow" }, "Sua coleção"),
    h("h1", { class: "rda-typography rda-typography--3xl rda-typography--bold" }, "Música que fica."),
    h(
      "p",
      { class: "muted small" },
      "Revisite suas playlists e encontre o próximo ponto de partida.",
    ),
    h(
      "nav",
      { class: "tabs rda-segmented-control rda-segmented-control--sm", role: "tablist", "aria-label": "Abas da biblioteca" },
      h(
        "button",
        {
          type: "button",
          role: "tab",
          class: "rda-segmented-control__item" + (state.libraryTab === "playlists" ? " active" : ""),
          "aria-pressed": state.libraryTab === "playlists" ? "true" : "false",
          onClick: () => {
            state.libraryTab = "playlists";
            state.selected = null;
            replaceView();
          },
        },
        "Playlists" + (state.playlists ? " · " + state.playlists.length : ""),
      ),
      h(
        "button",
        {
          type: "button",
          role: "tab",
          class: "rda-segmented-control__item" + (state.libraryTab === "liked" ? " active" : ""),
          "aria-pressed": state.libraryTab === "liked" ? "true" : "false",
          onClick: async () => {
            state.libraryTab = "liked";
            state.selected = null;
            if (!state.liked.length) await loadLiked();
            replaceView();
          },
        },
        [icon("heart"), " Músicas curtidas"],
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
        icon("refresh-cw"),
        async () => {
          if (state.libraryTab === "liked") {
            state.liked = [];
            await loadLiked();
          } else await loadLibrary();
        },
        "ghost",
        { "aria-label": "Atualizar biblioteca" },
      ),
      button([icon("plus"), " Nova playlist"], () => newDraft(), "primary small"),
    ),
    state.libraryTab === "playlists" && h(
      "div",
      { class: "playlist-filters rda-segmented-control rda-segmented-control--sm", role: "group", "aria-label": "Proprietário das playlists" },
      [["all", "Todas"], ["owned", "Criadas por mim"], ["followed", "Seguindo"]].map(([value, label]) => h(
        "button",
        {
          type: "button",
          class: "rda-segmented-control__item",
          "aria-pressed": String(state.libraryOwnership === value),
          onClick: (event) => {
            state.libraryOwnership = value;
            state.selected = null;
            for (const item of event.currentTarget.parentElement.children)
              item.setAttribute("aria-pressed", String(item === event.currentTarget));
            $("#library-content").replaceChildren(libraryContent());
          },
        },
        label,
      )),
    ),
    h("div", { id: "library-content" }, libraryContent()),
  );
}
function playlistArt(p) {
  const art = h("div", { class: "playlist-art", "aria-hidden": "true" }, icon("music"));
  if (typeof p.image === "string" && /^https:\/\//i.test(p.image)) {
    art.replaceChildren(h("img", {
      src: p.image,
      alt: "",
      loading: "lazy",
      decoding: "async",
      onError: () => art.replaceChildren(icon("music")),
    }));
  }
  return art;
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
    (state.libraryOwnership === "all" ||
      (state.libraryOwnership === "owned" && p.is_owned === true) ||
      (state.libraryOwnership === "followed" && p.is_owned === false)) && (p.name || "")
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
              class: "playlist-card rda-card rda-card--p-sm",
              "data-color": "surface",
              "data-style": "outlined",
              title: p.name || "Playlist",
              onClick: () => safe(() => openPlaylist(p)),
            },
            playlistArt(p),
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
        "Nenhuma playlist encontrada com esses filtros.",
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
      [icon("arrow-left"), " Todas as playlists"],
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
          ["Abrir no Spotify ", icon("external-link")],
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
    h("div", { class: "track-art", "aria-hidden": true }, icon("music")),
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
            button(icon("arrow-up"), () => moveTrack(index, -1), "ghost", {
              "aria-label": "Mover " + (t.name || "faixa") + " para cima",
              disabled: index === 0,
            }),
            button(icon("arrow-down"), () => moveTrack(index, 1), "ghost", {
              "aria-label": "Mover " + (t.name || "faixa") + " para baixo",
              disabled: index === state.draft.tracks.length - 1,
            }),
            button(
              icon("x"),
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
        : button(icon("plus"), () => addDraft(t), "ghost", {
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
      {
        type: "submit",
        class: "primary rda-button rda-button--md",
        "data-color": "primary",
        "data-style": "solid",
        "data-wrap": "true",
        disabled: state.searchBusy,
      },
      state.searchBusy ? "Buscando…" : ["Buscar ", icon("external-link")],
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
    h("div", { class: "eyebrow rda-page-header__eyebrow" }, "Dê espaço à descoberta"),
    h("h1", { class: "rda-typography rda-typography--3xl rda-typography--bold" }, "Encontre o seu som."),
    h(
      "p",
      { class: "small muted" },
      "Busque no catálogo e adicione músicas à seleção ao lado.",
    ),
    form,
    h(
      "nav",
      { class: "tabs rda-segmented-control rda-segmented-control--sm", role: "tablist", "aria-label": "Categorias de busca" },
      tabs.map(([id, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            class: "rda-segmented-control__item" + (state.searchTab === id ? " active" : ""),
            "aria-pressed": state.searchTab === id ? "true" : "false",
            onClick: () => {
              state.searchTab = id;
              replaceView();
            },
          },
          label,
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
                      state.searchTab === "artists" ? icon("music") : icon("music"),
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
                          ["Abrir ", icon("external-link")],
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
    { class: "review rda-sidebar rda-sidebar--right", "aria-label": "Revisão da playlist" },
    h(
      "div",
      { class: "review-head rda-sidebar__header row between" },
      h(
        "div",
        {},
        h("div", { class: "eyebrow rda-page-header__eyebrow" }, "Antes do play"),
        h("h2", { class: "rda-typography rda-typography--lg rda-typography--bold" }, "Sua seleção"),
      ),
      button(
        icon("x"),
        () => $(".review").classList.remove("visible"),
        "ghost mobile-review icon-btn",
        { "aria-label": "Fechar revisão" },
      ),
    ),
    pending > 0 &&
      h(
        "div",
        { class: "review-banner rda-notice rda-notice--info", "data-color": "info" },
        icon("sparkles"),
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
          { class: "review-body rda-sidebar__list draft" },
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
              { class: "empty rda-empty-state" },
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
          { class: "review-empty rda-empty-state" },
          h("div", { class: "record", "aria-hidden": "true" }, h("span", { class: "record-mark" }, icon("sparkles", "20px"))),
          h("h3", { class: "rda-empty-state__title" }, "Uma ideia ganha forma aqui."),
          h(
            "p",
            { class: "small muted rda-empty-state__description" },
            "Adicione músicas da biblioteca ou da busca. Reordene, refine e aprove quando estiver do seu jeito.",
          ),
          button([icon("plus"), " Começar uma seleção"], newDraft, "ghost small"),
        ),
    h(
      "div",
      { class: "review-footer rda-sidebar__footer" },
      d && h("p", { class: "review-summary" }, draftSummary(d)),
      d &&
        button(
          state.jobs.size ? "Aguardando conclusão…" : ["Revisar alterações ", icon("external-link")],
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
        [icon("music"), " As alterações seguem suas preferências de autorização."],
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
        ["Conferir playlist no Spotify ", icon("external-link")],
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
const auditLabels = {
  "context.metrics": "Orçamento e compactação de contexto", "llm.response": "Tempo e consumo do modelo",
  "operation.progress": "Checkpoint da operação",
  "tools.available": "Ferramentas disponíveis nesta execução", "tool-result": "Resultado da ferramenta",
  "cancel.requested": "Cancelamento solicitado", "proposal.decision": "Decisão de aprovação",
  "request.started": "Solicitação recebida", "request.finished": "Execução encerrada",
  "session.start": "Modelo selecionado", "session.end": "Resposta registrada",
  "llm.turn": "Ferramentas solicitadas pelo modelo", "llm.final": "Resposta gerada",
  "llm.error": "Falha no modelo", "tool.result": "Resultado da ferramenta",
  status: "Estado do agente", tool: "Chamada de ferramenta", proposal: "Aprovação solicitada", error: "Erro",
};
function auditIsError(event) {
  return event.event === "error" || event.event === "llm.error" || event.payload.ok === false ||
    ["failed", "interrupted"].includes(event.payload.outcome);
}
async function loadAudit(id) {
  const generation = ++state.auditGeneration;
  state.auditConversation = id || "";
  state.audit = null;
  state.auditLoading = Boolean(id);
  if (state.view === "audit") replaceView();
  if (!id) return;
  try {
    const result = await api("/conversations/" + id + "/audit");
    if (generation === state.auditGeneration) state.audit = result;
  } catch (error) {
    if (generation === state.auditGeneration) throw error;
  } finally {
    if (generation === state.auditGeneration) {
      state.auditLoading = false;
      if (state.view === "audit") replaceView();
    }
  }
}
function auditView() {
  const data = state.audit;
  const events = data?.events || [];
  const filtered = events.filter(e => state.auditFilter === "all" ||
    (state.auditFilter === "errors" ? auditIsError(e) : ["tool", "tool.result", "proposal", "proposal.decision"].includes(e.event)));
  const date = ts => new Date(ts * 1000).toLocaleString("pt-BR");
  const selector = h("select", { "aria-label": "Conversa para auditar", onChange: e => safe(() => loadAudit(e.target.value)) },
    h("option", { value: "" }, "Selecione uma conversa"),
    state.conversations.map(c => h("option", { value: c.id }, c.title)));
  selector.value = state.auditConversation;
  const filter = h("select", { "aria-label": "Filtrar eventos", onChange: e => { state.auditFilter = e.target.value; replaceView(); } },
    h("option", { value: "all" }, "Todos os eventos"), h("option", { value: "errors" }, "Falhas e interrupções"),
    h("option", { value: "tools" }, "Ferramentas e aprovações"));
  filter.value = state.auditFilter;
  return h("section", { class: "stack audit-view" },
    h("h1", {}, "Auditoria de conversas"),
    h("p", { class: "muted" }, "Entenda as solicitações, as ferramentas acionadas e o resultado de cada execução."),
    h("div", { class: "row audit-controls" }, selector,
      button([icon("refresh-cw"), " Atualizar"], () => loadAudit(state.auditConversation), "small", { disabled: state.auditLoading || !state.auditConversation })),
    state.auditLoading ? h("p", { role: "status" }, "Carregando auditoria…") : !data ?
      h("p", { class: "muted" }, state.auditConversation ? "Não foi possível carregar a auditoria. Tente atualizar." : "Selecione uma conversa para investigar.") : [
      h("div", { class: "row audit-summary", "aria-label": "Resumo da auditoria" },
        badge(data.running ? "Em execução" : "Sem execução ativa"),
        badge(events.filter(e => e.event === "request.started").length + " solicitações registradas"),
        badge(events.filter(e => e.event === "tool.result").length + " resultados de ferramentas"),
        badge(events.filter(auditIsError).length + " eventos de falha/interrupção", events.some(auditIsError) ? "danger" : "secondary")),
      h("p", { class: "small muted" }, "ID da conversa: " + data.conversation.id),
      h("p", { class: "notice small" }, "Registros do gateway são coletados a partir desta versão. Conversas anteriores podem ter cobertura parcial. Uma solicitação sem encerramento pode ter sido interrompida por reinício do serviço."),
      !data.agent_logs_available && h("p", { class: "notice", role: "status" }, "Diagnóstico do agente indisponível. As mensagens e os registros do gateway continuam disponíveis."),
      h("h2", {}, "Linha do tempo"), filter,
      filtered.length ? h("ol", { class: "audit-timeline" }, filtered.map(e => h("li", { class: "audit-event rda-card rda-card--p-md" },
        h("div", { class: "row between" }, h("strong", {}, auditLabels[e.event] || e.event), badge(auditIsError(e) ? "Atenção" : e.source === "agent" ? "Agente" : "Gateway", auditIsError(e) ? "danger" : "secondary")),
        h("time", { class: "small muted", datetime: new Date(e.created * 1000).toISOString() }, date(e.created)),
        e.payload.outcome && h("p", {}, ({ completed: "Concluída", failed: "Falhou", interrupted: "Interrompida" }[e.payload.outcome] || e.payload.outcome) + " · " + e.payload.duration_ms + " ms"),
        e.payload.decision && h("p", {}, e.payload.decision === "approve" ? "Alteração aprovada" : "Alteração recusada"),
        e.payload.name && h("p", {}, names[e.payload.name.replace(/^spotify_/, "")] || e.payload.name),
        e.payload.model && h("p", {}, "Modelo: " + e.payload.model),
        e.run_id && h("p", { class: "small muted audit-id" }, "Execução: " + e.run_id),
        h("details", {}, h("summary", {}, "Detalhes técnicos"), h("pre", {}, JSON.stringify(e.payload, null, 2)))))) : h("p", { class: "muted" }, "Nenhum evento para este filtro."),
      h("h2", {}, "Mensagens registradas"),
      data.conversation.messages.length ? data.conversation.messages.map(m => h("article", { class: "rda-card rda-card--p-md" },
        h("strong", {}, m.role === "user" ? "Você" : "Euterpe"),
        h("span", { class: "small muted" }, " · " + date(m.created) + (m.interrupted ? " · Resposta interrompida" : "")),
        h("p", { class: "audit-message" }, m.content))) : h("p", { class: "muted" }, "Esta conversa ainda não tem mensagens."),
    ]);
}
let workbenchTimer = null;
function resetWorkbench() {
  clearTimeout(workbenchTimer);
  state.workbenchGeneration++;
  state.workbench = null;
  state.workbenchConversation = "";
  state.workbenchDataset = "";
  state.workbenchPage = null;
  state.workbenchPreview = null;
}
async function loadWorkbench(id, polling = false) {
  clearTimeout(workbenchTimer);
  const changed = state.workbenchConversation !== id;
  if (changed) {
    state.workbenchDataset = ""; state.workbenchPage = null; state.workbenchPreview = null;
    state.workbench = null;
  }
  state.workbenchConversation = id || "";
  const generation = ++state.workbenchGeneration;
  const account = state.user?.id;
  if (!id) { if (state.view === "operations") replaceView(); return; }
  const data = await api("/conversations/" + id + "/workbench");
  if (generation !== state.workbenchGeneration || account !== state.user?.id) return;
  const sameRefs = JSON.stringify(state.workbench?.state?.references) === JSON.stringify(data.state?.references);
  const terminalChanged = (data.operations || []).some(o => ["completed", "failed", "cancelled", "uncertain"].includes(o.status) && state.workbench?.operations?.find(old => old.operation_id === o.operation_id)?.status !== o.status);
  state.workbench = data;
  if (state.view === "operations") {
    if (polling && sameRefs && !terminalChanged && $("#operation-list")) $("#operation-list").replaceChildren(...operationCards());
    else replaceView();
    if ((data.operations || []).some(o => ["queued", "running", "awaiting_approval", "verifying", "cancel_requested"].includes(o.status))) {
      workbenchTimer = setTimeout(() => {
        if (state.view === "operations" && state.user?.id === account) safe(() => loadWorkbench(id, true));
      }, 2500);
    }
  }
}
async function workspaceAction(name, args = {}) {
  const id = state.workbenchConversation;
  const account = state.user?.id;
  if (!id) throw Error("Selecione uma conversa.");
  const r = await api("/conversations/" + id + "/workbench", "POST", { name, arguments: args });
  if (account !== state.user?.id || id !== state.workbenchConversation) throw Error("Sessão alterada");
  if (!r.ok) throw Error(errors[r.code] || r.code || "Não foi possível concluir a operação.");
  return r.data;
}
const operationNames = { dataset: "Leitura da playlist", analysis: "Análise por critérios", review: "Revisão curatorial", apply: "Aplicação da seleção" };
const operationStatuses = {
  queued: "Na fila", running: "Em andamento", paused: "Pausada; checkpoint preservado",
  awaiting_approval: "Aguardando sua aprovação", verifying: "Conferindo resultado no Spotify",
  completed: "Concluída", failed: "Falhou", cancelled: "Cancelada",
  cancel_requested: "Cancelamento solicitado", uncertain: "Resultado incerto; conferir antes de repetir",
};
function operationCards() {
  const operations = state.workbench?.operations || [];
  if (!operations.length) return [h("p", { class: "muted" }, "Nenhuma operação nesta conversa.")];
  return operations.map(o => h("article", { class: "rda-card rda-card--p-md stack" },
    h("div", { class: "row between" }, h("strong", {}, operationNames[o.kind] || o.kind),
      badge(operationStatuses[o.status] || o.status, ["failed", "uncertain"].includes(o.status) ? "danger" : "secondary")),
    o.total_items != null && h("div", {},
      h("p", { class: "small" }, (o.items_processed || 0) + " de " + o.total_items + " itens processados"),
      h("progress", { value: o.items_processed || 0, max: Math.max(1, o.total_items), "aria-label": "Progresso da operação" })),
    o.error && h("p", { role: "status" }, errors[o.error] || o.error),
    o.result?.verified && h("p", {}, "Resultado conferido: ordem e repetições correspondem à seleção aprovada."),
    o.kind === "analysis" && o.status === "completed" && h("p", {}, "Análise completa. A classificação usa os metadados disponíveis; características ausentes continuam desconhecidas."),
    o.kind === "review" && o.status === "completed" && h("div", { class: "stack" },
      h("p", { class: "small muted" }, "Contagens e diversidade verificadas no conjunto completo. A avaliação de coerência e sequência considera uma amostra e os totais."),
      ["coherence_notes", "sequence_notes", "missing_evidence", "warnings"].flatMap(key => (o.result?.review?.[key] || []).map(text => h("p", {}, text)))),
    h("div", { class: "row workbench-actions" },
      o.can_resume && button("Retomar do checkpoint", async () => { await workspaceAction("operation_resume", { operation_id: o.operation_id }); await loadWorkbench(state.workbenchConversation); }, "small"),
      ["queued", "running", "paused", "awaiting_approval", "verifying"].includes(o.status) &&
        button("Cancelar", async () => { await workspaceAction("operation_cancel", { operation_id: o.operation_id }); await loadWorkbench(state.workbenchConversation); }, "small ghost"),
      o.status === "uncertain" && button("Conferir estado no Spotify", async () => { await workspaceAction("operation_status", { operation_id: o.operation_id }); await loadWorkbench(state.workbenchConversation); }, "small"),
      o.status === "awaiting_approval" && button("Abrir revisão", async () => { await refreshProposals(); if (state.proposals[0]) await reviewProposal(state.proposals[0]); }, "small primary")),
    h("details", {}, h("summary", {}, "Detalhes da operação"), h("pre", { class: "workbench-json" }, JSON.stringify(o, null, 2)))));
}
async function readWorkspacePage(id, cursor = "") {
  if (!id) { state.workbenchDataset = ""; state.workbenchPage = null; state.workbenchPreview = null; replaceView(); return; }
  state.workbenchDataset = id; state.workbenchPreview = null;
  state.workbenchPage = await workspaceAction("dataset_page", { dataset_id: id, ...(cursor ? { cursor } : {}), limit: 25 });
  replaceView();
}
function operationsView() {
  const selector = h("select", { "aria-label": "Conversa das operações", onChange: e => safe(() => loadWorkbench(e.target.value)) },
    h("option", { value: "" }, "Selecione uma conversa"), state.conversations.map(c => h("option", { value: c.id }, c.title)));
  selector.value = state.workbenchConversation;
  const refs = (state.workbench?.state?.references || []).filter(r => r.kind === "dataset");
  const datasets = h("select", { "aria-label": "Dados disponíveis", onChange: e => safe(() => readWorkspacePage(e.target.value)) },
    h("option", { value: "" }, "Selecione dados da conversa"), refs.map((r, i) => h("option", { value: r.id }, "Conjunto " + (i + 1) + " · " + r.id.slice(0, 8))));
  datasets.value = state.workbenchDataset;
  const page = state.workbenchPage, preview = state.workbenchPreview;
  const reviewed = preview && (state.workbench?.operations || []).some(o => o.kind === "review" && o.status === "completed" && o.result?.selection_id === preview.selection_id);
  const playlist = h("input", { placeholder: "ID da playlist Spotify", "aria-label": "ID da playlist para leitura" });
  const criteria = h("textarea", { rows: 3, maxlength: 3000, "aria-label": "Critérios da análise", placeholder: "Critérios para analisar os metadados. Informações musicais ausentes serão marcadas como desconhecidas." });
  const dedup = h("input", { type: "checkbox", checked: true });
  const sort = h("select", { "aria-label": "Ordem da seleção" },
    [["original", "Preservar ordem"], ["name", "Nome da faixa"], ["artist", "Artista"], ["album", "Álbum"], ["duration_ms", "Duração"]].map(([value, label]) => h("option", { value }, label)));
  const maxTracks = h("input", { type: "number", min: 0, max: 50000, placeholder: "Sem limite", "aria-label": "Máximo de faixas" });
  const artistLimit = h("input", { type: "number", min: 1, max: 50000, placeholder: "Sem limite", "aria-label": "Máximo de faixas por artista" });
  const analyses = (state.workbench?.operations || []).filter(o => o.kind === "analysis" && o.status === "completed" && o.result?.dataset_id === state.workbenchDataset);
  const analysis = h("select", { "aria-label": "Classificação da análise" }, h("option", { value: "" }, "Sem classificação por análise"),
    analyses.map((o, i) => h("option", { value: o.operation_id }, "Usar classificação da análise " + (i + 1))));
  const minScore = h("input", { type: "number", min: 0, max: 1, step: 0.05, value: 0.5, "aria-label": "Pontuação mínima da análise" });
  return h("section", { class: "stack workbench-view" },
    h("h1", {}, "Operações e seleções"),
    h("p", { class: "muted" }, "Acompanhe leituras e análises, retome checkpoints e confira seleções antes de alterar o Spotify."),
    h("div", { class: "row workbench-actions" }, selector, button([icon("refresh-cw"), " Atualizar"], () => loadWorkbench(state.workbenchConversation), "small")),
    !state.workbenchConversation ? h("p", { class: "muted" }, "Selecione uma conversa para começar.") : [
      h("div", { class: "rda-card rda-card--p-md stack" }, h("h2", {}, "Ler playlist por páginas"),
        playlist, button("Iniciar leitura", async () => {
          await workspaceAction("playlist_dataset_create", { playlist_id: playlist.value.trim() });
          await loadWorkbench(state.workbenchConversation);
        }, "small")),
      h("h2", {}, "Trabalhos e checkpoints"), h("div", { id: "operation-list", class: "stack", "aria-live": "polite" }, operationCards()),
      h("h2", {}, "Dados disponíveis"), datasets,
      page && [
        h("p", { class: "small muted" }, "Amostra: " + page.items_returned + " itens nesta página · " + page.items_processed + " carregados de " + page.total_items + ". Esta página não representa a análise de todo o conjunto."),
        h("ol", { class: "workbench-items" }, (page.items || []).map(t => h("li", {}, t.name || t.uri || JSON.stringify(t.value ?? t)))),
        page.has_more && button("Próxima página", () => readWorkspacePage(state.workbenchDataset, page.next_cursor), "small"),
        h("div", { class: "rda-card rda-card--p-md stack" },
          h("h3", {}, "Construir seleção"), h("label", { class: "row" }, dedup, "Remover repetidas, preservando a primeira ocorrência"),
          sort, h("label", {}, "Quantidade máxima de faixas", maxTracks), h("label", {}, "Máximo por artista, incluindo participações", artistLimit),
          analyses.length > 0 && h("div", { class: "stack" }, analysis, h("label", {}, "Pontuação mínima da classificação", minScore)),
          button("Gerar prévia", async () => {
            const args = { dataset_id: state.workbenchDataset, deduplicate: dedup.checked, sort_by: sort.value };
            if (maxTracks.value !== "") args.max_tracks = Number(maxTracks.value);
            if (artistLimit.value !== "") args.max_per_artist = Number(artistLimit.value);
            if (analysis.value) { args.analysis_id = analysis.value; args.min_score = Number(minScore.value); args.sort_by = "score"; }
            const selection = await workspaceAction("selection_build", args);
            state.workbenchPreview = await workspaceAction("selection_preview", { selection_id: selection.selection_id });
            replaceView();
          }, "small")),
        h("div", { class: "rda-card rda-card--p-md stack" }, h("h3", {}, "Analisar por critérios"), criteria,
          button("Iniciar análise em lotes", async () => {
            await workspaceAction("analysis_start", { dataset_id: state.workbenchDataset, criteria: criteria.value.trim(), batch_size: 20 });
            await loadWorkbench(state.workbenchConversation);
          }, "small")),
      ],
      preview && h("div", { class: "rda-card rda-card--p-md stack" }, h("h2", {}, "Prévia da seleção"),
        h("p", {}, preview.before + " → " + preview.after + " faixas · " + preview.removed_occurrences + " ocorrências removidas · " + preview.added_occurrences + " adicionadas"),
        h("p", { class: "small muted" }, preview.reordered ? "A ordem será alterada." : "A ordem relativa foi preservada."),
        h("ol", {}, (preview.sample || []).map(t => h("li", {}, t.name || t.uri))),
        h("p", {}, "A alteração ainda passará pela sua aprovação. Se a playlist mudar, será necessária uma nova prévia."),
        preview.review_required && !reviewed && h("p", {}, "Esta seleção usa uma classificação subjetiva. Conclua a revisão curatorial antes de aplicar."),
        button("Revisar curadoria e sequência", async () => {
          await workspaceAction("selection_review", { selection_id: preview.selection_id });
          await loadWorkbench(state.workbenchConversation);
        }, "small"),
        button("Solicitar aplicação e revisão", async () => {
          await workspaceAction("selection_apply", { preview_id: preview.preview_id });
          await loadWorkbench(state.workbenchConversation); await refreshProposals();
        }, "primary", { disabled: preview.review_required && !reviewed })),
    ]);
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
    h("div", { class: "eyebrow rda-page-header__eyebrow" }, "O caminho da sua coleção"),
    h("h1", { class: "rda-typography rda-typography--3xl rda-typography--bold" }, "Cada mudança tem história."),
    h(
      "p",
      { class: "small muted" },
      "Acompanhe as decisões e os resultados das alterações manuais e do agente.",
    ),
    h(
      "div",
      { style: "margin-bottom: var(--rda-spacing-4)" },
      button([icon("refresh-cw"), " Atualizar"], loadActivity, "ghost small"),
    ),
    state.activity.length
      ? state.activity.map((a) =>
          h(
            "article",
            {
              class: "activity rda-card rda-card--p-md",
              "data-color": "surface",
              "data-style": "outlined",
              style: "margin-bottom: var(--rda-spacing-3)",
            },
            h(
              "div",
              { class: "row between" },
              h("h3", { class: "rda-typography rda-typography--base rda-typography--semibold" }, names[a.title] || a.title),
              badge(
                labels[a.status] || a.status,
                a.status === "succeeded" ? "success" : a.status === "failed" ? "danger" : "secondary",
                { class: "badge " + a.status },
              ),
            ),
            h("time", { class: "small muted" }, new Date(a.created * 1000).toLocaleString("pt-BR")),
            h(
              "p",
              { class: "muted small", style: "margin: var(--rda-spacing-2) 0" },
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
          { class: "empty rda-empty-state" },
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
function mcpConnectionsView() {
  const owner = state.user?.id, csrf = state.csrf;
  let generation = 0;
  const connections = h("div", { id: "mcp-connections", class: "stack", "aria-live": "polite" });
  const attempts = h("div", { id: "mcp-attempts", class: "stack", "aria-live": "polite" });
  const labels = {
    authorized: "Autorizada, ainda sem uso", used: "Em uso", renewable: "Renovação disponível",
    expired: "Expirada", revoked: "Revogada", awaiting_consent: "Aguardando autorização",
    awaiting_client: "Aguardando o aplicativo", connected: "Credenciais entregues", denied: "Cancelada",
  };
  const date = value => value ? new Date(value * 1000).toLocaleString("pt-BR") : "Não registrado";
  const section = h("div", { class: "mcp-connections stack" },
    h("div", { class: "mcp-heading" }, h("h3", {}, "Aplicativos autorizados"), button("Atualizar conexões", refresh, "small")),
    connections, h("h3", {}, "Tentativas recentes"),
    h("p", { class: "small muted" }, "Histórico dos últimos 7 dias. Encaminhar o retorno não confirma que o aplicativo o recebeu."), attempts);
  const alive = () => section.isConnected && state.user?.id === owner && state.csrf === csrf;
  async function revoke(connection) {
    const confirm = button("Confirmar revogação", async () => {
      if (!alive()) { closeModal(); return; }
      confirm.disabled = true;
      try {
        await api(`/mcp/connections/${connection.id}`, "DELETE", {});
        closeModal();
        if (alive()) { await refresh(); toast("Conexão revogada."); }
      } finally { confirm.disabled = false; }
    }, "danger");
    modal(modalFrame("Revogar conexão", h("div", { class: "stack" },
      h("p", {}, `Revogar o acesso de ${connection.name}? O aplicativo precisará de uma nova autorização.`),
      h("p", { class: "small muted" }, "Isso impede novas chamadas e renovações. Operações já iniciadas não são desfeitas.")),
      [button("Cancelar", closeModal), confirm]));
  }
  async function refresh() {
    if (!alive()) return;
    const current = ++generation;
    connections.setAttribute("aria-busy", "true");
    connections.replaceChildren(h("p", { class: "small muted" }, "Carregando conexões…"));
    attempts.replaceChildren();
    try {
      const result = await api("/mcp/connections");
      if (!alive() || current !== generation) return;
      connections.replaceChildren(...(result.connections?.length ? result.connections.map(c =>
        h("article", { class: "mcp-connection stack" },
          h("div", { class: "mcp-heading" }, h("h4", {}, c.name), badge(labels[c.status] || "Estado indisponível", c.status === "used" ? "brand" : "secondary")),
          h("p", { class: "small" }, c.scope?.split(" ").includes("write") ? "Leitura e escrita conforme suas autorizações" : "Somente leitura"),
          h("dl", { class: "mcp-details" },
            h("dt", {}, "Autorizada em"), h("dd", {}, date(c.created)),
            h("dt", {}, "Autorização válida até"), h("dd", {}, date(c.expires)),
            h("dt", {}, "Acesso atual válido até"), h("dd", {}, date(c.access_expires)),
            h("dt", {}, "Última chamada MCP válida"), h("dd", {}, date(c.last_used))),
          c.status === "renewable" && h("p", { class: "small muted" }, "O acesso atual expirou. O aplicativo pode renová-lo sem pedir autorização novamente."),
          c.status === "expired" && h("p", { class: "small muted" }, "Inicie uma nova conexão no aplicativo."),
          !["revoked", "expired"].includes(c.status) && button("Revogar conexão", () => revoke(c), "small danger"))) :
        [h("p", { class: "small muted" }, "Nenhum aplicativo autorizado. Adicione o endpoint no cliente e entre com sua conta RDA.")]));
      attempts.replaceChildren(...(result.attempts?.length ? result.attempts.slice(0, 20).map(a =>
        h("div", { class: "mcp-attempt" }, h("strong", {}, a.name),
          h("span", {}, labels[a.status] || "Estado indisponível"),
          h("span", { class: "small muted" }, `${a.callback_host} · ${date(a.updated)}`),
          a.status === "awaiting_client" && h("p", { class: "small muted" }, "Volte ao aplicativo para concluir. Se não avançar, reinicie a conexão por lá."),
          a.status === "expired" && h("p", { class: "small muted" }, "A tentativa expirou. Inicie a conexão novamente no aplicativo."))) :
        [h("p", { class: "small muted" }, "Nenhuma tentativa recente.")]));
    } catch (error) {
      if (alive() && current === generation && error.name !== "AbortError") {
        connections.replaceChildren(h("p", { role: "alert" }, "Não foi possível carregar as conexões. Tente novamente."), button("Tentar novamente", refresh));
      }
    } finally { if (current === generation) connections.removeAttribute("aria-busy"); }
  }
  queueMicrotask(refresh);
  return section;
}
function mcpSettingsView() {
  const owner = state.user?.id, csrf = state.csrf;
  const tokens = h("div", { class: "stack", "aria-live": "polite" });
  const secret = h("div", { class: "stack", "aria-live": "polite" });
  const name = h("input", { placeholder: "Ex.: cliente remoto", maxLength: 80, "aria-label": "Nome do token" });
  const scope = h("select", { "aria-label": "Permissões do token" },
    h("option", { value: "read" }, "Somente leitura"),
    h("option", { value: "write" }, "Leitura e escrita conforme suas autorizações"));
  const days = h("input", { type: "number", min: 1, max: 90, value: 30, "aria-label": "Validade em dias" });
  async function refresh() {
    const result = await api("/mcp/tokens");
    if (!tokens.isConnected || state.user?.id !== owner || state.csrf !== csrf) return;
    tokens.replaceChildren(...(result.tokens || []).filter(t => t.kind !== "oauth").map(t => h("div", { class: "stack" },
      h("span", {}, `${t.name} · ${t.scope === "read" ? "leitura" : "escrita"} · expira em ${new Date(t.expires * 1000).toLocaleDateString("pt-BR")}`),
      button("Revogar", async () => { await api(`/mcp/tokens/${t.id}`, "DELETE", {}); await refresh(); }))));
  }
  return h("section", { class: "settings-card rda-card rda-card--p-lg stack", "data-color": "surface", "data-style": "matte" },
    h("h2", {}, "Conexões MCP"),
    h("p", {}, "Use sua conta RDA para conectar o Gemini e outros clientes compatíveis com MCP."),
    field("Endpoint MCP", h("input", { value: window.location.origin + "/mcp", readOnly: true })),
    button("Copiar endpoint", async () => {
      if (!navigator.clipboard?.writeText) { toast("Selecione e copie o endpoint no campo acima."); return; }
      await navigator.clipboard.writeText(window.location.origin + "/mcp"); toast("Endpoint copiado.");
    }, "small"),
    h("ol", { class: "mcp-instructions" },
      h("li", {}, "Adicione o endpoint como servidor MCP remoto no aplicativo."),
      h("li", {}, "Escolha a autenticação OAuth, entre com RDA e autorize o acesso."),
      h("li", {}, "Aguarde o retorno ao aplicativo. Confira abaixo a autorização e a primeira chamada MCP.")),
    h("p", { class: "small muted" }, "Escritas seguem a preferência em Operações e autorizações. O nome de cada aplicativo é informado por quem o registrou."),
    mcpConnectionsView(),
    h("h3", {}, "Tokens pessoais"),
    h("p", { class: "small muted" }, "Para clientes que aceitam o cabeçalho Authorization. O token aparece uma vez; guarde-o como uma senha."),
    field("Nome do token", name), field("Permissões", scope), field("Validade em dias", days),
    button("Gerar token", async () => {
      const validity = days.value.trim() === "" ? 30 : Number(days.value);
      if (!name.value.trim()) { name.focus(); throw Error("invalid_token_name"); }
      if (!Number.isInteger(validity) || validity < 1 || validity > 90) { days.focus(); throw Error("invalid_token_options"); }
      if (!['read', 'write'].includes(scope.value)) { scope.focus(); throw Error("invalid_token_options"); }
      days.value = String(validity);
      const result = await api("/mcp/tokens", "POST", { name: name.value, scope: scope.value, expiresInDays: validity });
      if (!secret.isConnected || state.user?.id !== owner || state.csrf !== csrf) return;
      secret.replaceChildren(
        field("Token gerado — copie agora", h("textarea", { value: result.token, readOnly: true, "aria-label": "Token gerado" })),
        h("p", { class: "small muted" }, "Use no cabeçalho Authorization: Bearer <token>."),
        button("Ocultar token", () => secret.replaceChildren()));
      await refresh();
    }), secret, button("Listar tokens", refresh), tokens);
}
function settingsView() {
  if (!state.settings)
    return h("div", { class: "loading" }, "Carregando suas preferências…");
  const s = state.settings;
  const operationApproval = h("input", {
    type: "checkbox", role: "switch", checked: s.mutationPolicy !== "allow",
    "aria-label": "Pedir aprovação antes de alterar playlists", "aria-describedby": "operation-policy-help",
  });
  const saveOperations = button("Salvar autorizações", async () => {
    saveOperations.disabled = true;
    try {
      await api("/settings", "PUT", { mutationPolicy: operationApproval.checked ? "confirm" : "allow" });
      await loadSettings();
      toast("Preferência de autorização salva para sua conta.");
    } finally { saveOperations.disabled = false; }
  }, "primary");
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
    h("div", { class: "eyebrow rda-page-header__eyebrow" }, "Afine sua experiência"),
    h("h1", { class: "rda-typography rda-typography--3xl rda-typography--bold" }, "Um agente com o seu ritmo."),
    h(
      "p",
      { class: "small muted" },
      "Escolha o modelo e conte como você gosta de ouvir música.",
    ),
    h(
      "div",
      { class: "settings-form" },
      h("section", { id: "operation-settings", class: "settings-card rda-card rda-card--p-lg stack", "data-color": "surface", "data-style": "matte" },
        h("h2", { class: "rda-typography rda-typography--xl rda-typography--semibold" }, "Operações e autorizações"),
        h("label", { class: "row", style: "gap: var(--rda-spacing-3); min-height: 44px" },
          operationApproval, h("span", {}, "Pedir aprovação antes de alterar playlists")),
        h("p", { id: "operation-policy-help", class: "small muted" },
          "Vale para as próximas operações do agente e de todas as conexões MCP da sua conta. Ao desativar, criação, edição e remoção de playlists podem ser executadas sem uma nova confirmação. Tokens de leitura continuam sem permissão para escrever."),
        saveOperations),
      mcpSettingsView(),
      state.sso.enabled && h("section", { class: "settings-card rda-card rda-card--p-lg stack", "data-color": "surface", "data-style": "matte" },
        h("h2", { class: "rda-typography rda-typography--xl rda-typography--semibold" }, "Conta RDA"),
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
        { class: "settings-card rda-card rda-card--p-lg stack", "data-color": "surface", "data-style": "matte" },
        h("h2", { class: "rda-typography rda-typography--xl rda-typography--semibold" }, "Inteligência artificial"),
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
          { class: "row", style: "gap: 8px" },
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
        { class: "settings-card rda-card rda-card--p-lg stack", "data-color": "surface", "data-style": "matte" },
        h("h2", { class: "rda-typography rda-typography--xl rda-typography--semibold" }, "Seu gosto, suas regras"),
        field("Preferências para o agente", instructions),
        h(
          "div",
          { class: "field-pair" },
          field("Mensagens no contexto", turns),
          field("Etapas por resposta", steps),
        ),
        h(
          "div",
          { class: "notice rda-notice rda-notice--info", "data-color": "info" },
          "As alterações seguem a opção em Operações e autorizações, tanto no agente quanto no MCP.",
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

/* ==========================================================================
   RDA Ecosystem: Curations & Visual Workflow Editor (F5A / M1)
   ========================================================================== */

async function loadCurations() {
  try {
    if (!state.editorialModels) {
      state.editorialModels = await api("/editorial-models");
    }
    const res = await api("/curations");
    state.curations = res.curations || [];
    if (state.curations.length > 0 && !state.activeCuration) {
      state.activeCuration = state.curations[0];
    }
  } catch (err) {
    showError(err);
  }
  render();
}

async function openCuration(id) {
  try {
    const cur = await api("/curations/" + id);
    state.activeCuration = cur;
    state.curationsTab = "workflow";
    state.workflowSelectedStep = cur.workflow?.steps?.[0] || null;
    state.workflowExecution = null;
    state.workflowValidation = null;
  } catch (err) {
    showError(err);
  }
  render();
}

function openNewCurationModal() {
  const models = state.editorialModels?.models || [];
  const dramaturgias = state.editorialModels?.dramaturgias || [];
  let titleInput, modelSelect, dramaSelect;
  const briefingInputs = {};

  const modalContent = h(
    "div",
    { class: "modal-content stack" },
    h("h2", { class: "rda-dialog__title" }, "Novo Projeto de Curadoria"),
    h(
      "p",
      { class: "small muted rda-dialog__description" },
      "Crie um projeto autoral privado com modelo editorial e fluxo visual de etapas.",
    ),
    h(
      "div",
      { class: "field-pair" },
      field("Título do projeto", (titleInput = h("input", { type: "text", value: "Minha Curadoria", maxlength: 120 }))),
      field(
        "Modelo editorial",
        (modelSelect = h(
          "select",
          {},
          models.map((m) => h("option", { value: m.id }, m.name + " (" + m.badge + ")")),
        )),
      ),
    ),
    field(
      "Arco dramatúrgico",
      (dramaSelect = h(
        "select",
        {},
        dramaturgias.map((d) => h("option", { value: d.id }, d.name + " — " + d.description.slice(0, 50) + "...")),
      )),
    ),
    h("h3", { class: "rda-typography rda-typography--sm rda-typography--semibold", style: "margin-top:10px" }, "Coordenadas Diegéticas Principais"),
    field(
      "Território / Geografia Cultural",
      (briefingInputs["territorio"] = h("input", {
        type: "text",
        placeholder: "Ex: Sertão cósmico, Berlim oriental",
      })),
    ),
    field(
      "Estação / Clima / Luz",
      (briefingInputs["luz"] = h("input", {
        type: "text",
        placeholder: "Ex: Garoa de inverno, Hora azul",
      })),
    ),
    h(
      "div",
      { class: "modal-actions rda-dialog__footer" },
      button("Cancelar", closeModal, "ghost"),
      button("Criar Projeto", async () => {
        const title = titleInput.value.trim() || "Nova Curadoria";
        const editorial_model = modelSelect.value;
        const dramaturgia = dramaSelect.value;
        const briefing = {
          territorio: briefingInputs["territorio"].value.trim(),
          luz: briefingInputs["luz"].value.trim(),
        };
        try {
          const created = await api("/curations", "POST", {
            title,
            editorial_model,
            dramaturgia,
            briefing,
          });
          closeModal();
          toast("Projeto criado com sucesso.");
          await loadCurations();
          await openCuration(created.id);
        } catch (err) {
          showError(err);
        }
      }, "primary"),
    ),
  );
  openModal(modalContent);
}

function curationsView() {
  const tabs = [
    ["projects", "Projetos (" + state.curations.length + ")"],
    ["workflow", "Editor de Fluxos" + (state.activeCuration ? " (" + state.activeCuration.title + ")" : "")],
    ["dossier", "Dossiê Curatorial"],
    ["models", "Modelos & Dramaturgias"],
  ];

  return h(
    "div",
    { class: "curations-view" },
    h(
      "div",
      { class: "row between", style: "margin-bottom: var(--rda-spacing-4); flex-wrap: wrap; gap: var(--rda-spacing-3)" },
      h(
        "nav",
        { class: "rda-segmented-control rda-segmented-control--sm curation-tabs", role: "tablist", "aria-label": "Abas de curadoria" },
        tabs.map(([id, label]) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              class: "rda-segmented-control__item curation-tab-btn" + (state.curationsTab === id ? " active" : ""),
              "aria-pressed": state.curationsTab === id ? "true" : "false",
              onClick: () => {
                state.curationsTab = id;
                render();
              },
            },
            label,
          ),
        ),
      ),
      button([icon("plus"), " Novo Projeto"], openNewCurationModal, "primary small"),
    ),
    state.curationsTab === "projects" && curationsProjectsSubView(),
    state.curationsTab === "workflow" && workflowEditorSubView(),
    state.curationsTab === "dossier" && dossierSubView(),
    state.curationsTab === "models" && editorialModelsSubView(),
  );
}

function curationsProjectsSubView() {
  if (!state.curations || state.curations.length === 0) {
    return h(
      "div",
      { class: "empty-state rda-empty-state" },
      h("span", { class: "rda-empty-state__icon", "aria-hidden": true }, icon("layers")),
      h("h3", { class: "rda-empty-state__title" }, "Nenhum projeto de curadoria ainda"),
      h(
        "p",
        { class: "small muted rda-empty-state__description" },
        "Inicie um novo projeto usando modelos autorais como Escuta & Imagem v2.0 com editor visual de fluxos.",
      ),
      button("Criar Primeiro Projeto", openNewCurationModal, "primary"),
    );
  }

  return h(
    "div",
    { class: "curations-grid" },
    state.curations.map((cur) => {
      const dramaturgia = (state.editorialModels?.dramaturgias || []).find((d) => d.id === cur.dramaturgia);
      const isSelected = state.activeCuration?.id === cur.id;
      return h(
        "article",
        {
          class: "curation-card rda-card rda-card--p-md" + (isSelected ? " selected" : ""),
          "data-color": "surface",
          "data-style": isSelected ? "elevated" : "outlined",
        },
        h(
          "div",
          { class: "curation-card-header row between" },
          h(
            "div",
            {},
            badge(cur.editorial_model || "Escuta & Imagem", "primary", { class: "curation-badge" }),
            h("h3", { class: "rda-typography rda-typography--lg rda-typography--semibold", style: "margin:6px 0 2px 0" }, cur.title),
          ),
          badge(
            cur.status === "awaiting_approval" ? "Aguardando Aprovação" : cur.status === "completed" ? "Concluído" : "Rascunho",
            cur.status === "awaiting_approval" ? "warning" : cur.status === "completed" ? "success" : "secondary",
            { class: "curation-badge status-" + cur.status },
          ),
        ),
        h(
          "div",
          { class: "small", style: "color:var(--rda-content-secondary); margin-top: 6px" },
          "Dramaturgia: ",
          h("strong", {}, dramaturgia?.name || cur.dramaturgia || "Livre"),
        ),
        cur.briefing?.territorio &&
          h(
            "div",
            { class: "curation-briefing-preview rda-card rda-card--p-sm", "data-color": "surface", "data-style": "matte" },
            h("span", {}, "Território: " + cur.briefing.territorio),
            cur.briefing.luz && h("span", {}, "Luz: " + cur.briefing.luz),
          ),
        h(
          "div",
          { class: "row between", style: "margin-top:auto; padding-top: 12px" },
          h("span", { class: "small muted" }, (cur.selected_tracks?.length || 0) + " faixas"),
          h(
            "div",
            { class: "row", style: "gap:6px" },
            button("Editor Visual", () => openCuration(cur.id), "primary small"),
            button("Dossiê", () => {
              state.activeCuration = cur;
              state.curationsTab = "dossier";
              render();
            }, "ghost small"),
            button(icon("x"), async () => {
              if (confirm("Deseja excluir o projeto " + cur.title + "?")) {
                await api("/curations/" + cur.id, "DELETE");
                if (state.activeCuration?.id === cur.id) state.activeCuration = null;
                await loadCurations();
              }
            }, "ghost icon-btn", { "aria-label": "Excluir " + cur.title }),
          ),
        ),
      );
    }),
  );
}

function workflowEditorSubView() {
  if (!state.activeCuration) {
    return h(
      "div",
      { class: "empty-state rda-empty-state" },
      h("span", { class: "rda-empty-state__icon", "aria-hidden": true }, icon("layers")),
      h("h3", { class: "rda-empty-state__title" }, "Nenhum projeto selecionado"),
      h("p", { class: "small muted rda-empty-state__description" }, "Selecione ou crie um projeto para abrir o Editor Visual de Fluxos."),
      button("Ir para Projetos", () => {
        state.curationsTab = "projects";
        render();
      }, "primary"),
    );
  }

  const cur = state.activeCuration;
  const wf = cur.workflow || { steps: [], edges: [] };
  const steps = wf.steps || [];
  const edges = wf.edges || [];

  return h(
    "div",
    { class: "workflow-container" },
    h(
      "div",
      { class: "workflow-toolbar rda-card rda-card--p-sm", "data-color": "surface", "data-style": "matte" },
      h(
        "div",
        { class: "row", style: "gap:8px" },
        h("strong", { class: "rda-typography rda-typography--sm rda-typography--bold" }, cur.title),
        badge("v" + (wf.version || 1), "primary", { class: "curation-badge" }),
        h("span", { class: "small muted" }, "Perfil: " + (wf.execution_profile || "equilibrado")),
      ),
      h(
        "div",
        { class: "row", style: "gap:6px; flex-wrap: wrap" },
        button([icon("plus"), " Adicionar Etapa"], addWorkflowStepModal, "ghost small"),
        button("Validar DAG", validateWorkflowDag, "ghost small"),
        button("Salvar Rascunho", saveWorkflow, "ghost small"),
        button([icon("play"), " Executar Fluxo"], executeWorkflow, "primary small"),
        button(
          state.workflowMode === "canvas" ? "Modo Lista Acessível" : "Modo Canvas Visual",
          () => {
            state.workflowMode = state.workflowMode === "canvas" ? "list" : "canvas";
            render();
          },
          "ghost small",
        ),
      ),
    ),
    state.workflowValidation &&
      h(
        "div",
        {
          class: "approval-gate-banner rda-notice " + (state.workflowValidation.valid ? "rda-notice--success" : "rda-notice--danger"),
          "data-color": state.workflowValidation.valid ? "success" : "danger",
        },
        h(
          "h4",
          { class: "rda-notice__title" },
          state.workflowValidation.valid ? [icon("check"), " Grafo Acíclico Válido (DAG)"] : [icon("alert-triangle"), " Erro de Validação no Grafo"],
        ),
        h("div", { class: "small rda-notice__description" }, state.workflowValidation.message),
      ),
    state.workflowExecution?.pending_approval && approvalGateBanner(state.workflowExecution.pending_approval),
    state.workflowMode === "canvas" ? renderWorkflowCanvas(steps, edges) : renderWorkflowAccessibleList(steps, edges),
  );
}

function renderWorkflowCanvas(steps, edges) {
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  // SVG Edge Paths connecting out port to in port
  const edgePaths = edges
    .map((e) => {
      const src = stepMap.get(e.source);
      const tgt = stepMap.get(e.target);
      if (!src || !tgt) return null;
      const x1 = (src.position?.x || 100) + 210;
      const y1 = (src.position?.y || 140) + 48;
      const x2 = tgt.position?.x || 300;
      const y2 = (tgt.position?.y || 140) + 48;
      const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      return h("path", {
        d,
        stroke: "#ccf378",
        "stroke-width": "2.5",
        "stroke-opacity": "0.75",
        fill: "none",
      });
    })
    .filter(Boolean);

  const canvasSvg = h(
    "svg",
    {
      class: "workflow-canvas-svg",
      viewBox: "0 0 1600 800",
      xmlns: "http://www.w3.org/2000/svg",
    },
    edgePaths,
  );

  const nodeElements = steps.map((s) => {
    const isSelected = state.workflowSelectedStep?.id === s.id;
    const isRunning = state.workflowExecution?.step_results?.[s.id]?.status === "running";
    const isPaused = state.workflowExecution?.step_results?.[s.id]?.status === "awaiting_approval";
    const isDone = state.workflowExecution?.step_results?.[s.id]?.status === "completed";

    const nodeEl = h(
      "div",
      {
        class:
          "workflow-node" +
          (isSelected ? " selected" : "") +
          (isRunning ? " running" : "") +
          (isPaused ? " approval" : ""),
        style: `left:${s.position?.x || 100}px;top:${s.position?.y || 140}px;`,
        onClick: () => {
          state.workflowSelectedStep = s;
          render();
        },
      },
      h(
        "div",
        { class: "workflow-node-header" },
        h("span", { class: "workflow-node-kind" }, s.kind),
        isDone
          ? h("span", { style: "color:#ccf378;font-size:11px" }, icon("check"))
          : isPaused
          ? h("span", { style: "color:#fbbf24;font-size:11px" }, icon("circle-stop"))
          : null,
      ),
      h("div", { class: "workflow-node-label" }, s.label),
      h("div", { class: "workflow-node-model" }, s.model_alias || "rda/chat-default"),
      h(
        "div",
        { class: "workflow-node-ports" },
        h("span", {}, h("span", { class: "port-dot" }), " in"),
        h("span", {}, "out ", h("span", { class: "port-dot" })),
      ),
    );

    // Node Drag Handler
    let isDragging = false;
    let startX, startY, origX, origY;
    nodeEl.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = s.position?.x || 100;
      origY = s.position?.y || 140;

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        s.position = { x: Math.max(20, origX + dx), y: Math.max(20, origY + dy) };
        nodeEl.style.left = s.position.x + "px";
        nodeEl.style.top = s.position.y + "px";
      };

      const onMouseUp = () => {
        if (isDragging) {
          isDragging = false;
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
          render();
        }
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });

    return nodeEl;
  });

  const nodeLayer = h("div", { class: "workflow-node-layer" }, nodeElements);
  const viewport = h("div", { class: "workflow-viewport" }, canvasSvg, nodeLayer);

  return h("div", { class: "workflow-workspace" }, viewport, renderWorkflowInspector());
}

function renderWorkflowInspector() {
  const step = state.workflowSelectedStep;
  if (!step) {
    return h(
      "div",
      { class: "workflow-inspector rda-card rda-card--p-md", "data-color": "surface", "data-style": "matte" },
      h("h3", { class: "rda-typography rda-typography--base rda-typography--semibold" }, "Propriedades da Etapa"),
      h("p", { class: "small muted" }, "Clique em qualquer nó do canvas para editar seu papel, modelo LLM e permissões."),
    );
  }

  const roleFunctions = ["briefing", "research", "selection", "sequencing", "review", "synthesis"];
  const kinds = ["briefing", "research", "selection", "sequencing", "review", "approval_gate"];
  const modelAliases = ["rda/chat-default", "rda/fast", "rda/reasoning", "rda/vision"];

  return h(
    "div",
    { class: "workflow-inspector rda-card rda-card--p-md", "data-color": "surface", "data-style": "matte" },
    h("h3", { class: "rda-typography rda-typography--base rda-typography--semibold" }, "Editar: " + step.label),
    field(
      "Rótulo da etapa",
      h("input", {
        type: "text",
        value: step.label,
        onInput: (e) => {
          step.label = e.target.value;
          render();
        },
      }),
    ),
    field(
      "Tipo de etapa",
      h(
        "select",
        {
          onChange: (e) => {
            step.kind = e.target.value;
            render();
          },
        },
        kinds.map((k) => h("option", { value: k, selected: step.kind === k }, k)),
      ),
    ),
    field(
      "Função de IA (Role)",
      h(
        "select",
        {
          onChange: (e) => {
            step.role_function = e.target.value;
            render();
          },
        },
        roleFunctions.map((r) => h("option", { value: r, selected: step.role_function === r }, r)),
      ),
    ),
    field(
      "Modelo LLM atribuído",
      h(
        "select",
        {
          onChange: (e) => {
            step.model_alias = e.target.value;
            render();
          },
        },
        modelAliases.map((m) => h("option", { value: m, selected: step.model_alias === m }, m)),
      ),
    ),
    h(
      "label",
      { class: "rda-checkbox-field check-field row", style: "gap:8px;font-weight:normal;cursor:pointer;margin-top:4px" },
      h("input", {
        type: "checkbox",
        class: "rda-checkbox-native",
        checked: Boolean(step.requires_approval),
        onChange: (e) => {
          step.requires_approval = e.target.checked;
          render();
        },
      }),
      h("span", { class: "rda-checkbox__label small" }, "Exigir Confirmação Humana (Decisão 17A)"),
    ),
    field(
      "Instruções específicas",
      h("textarea", {
        value: step.instructions || "",
        placeholder: "Diretrizes específicas desta etapa...",
        rows: 3,
        onInput: (e) => {
          step.instructions = e.target.value;
        },
      }),
    ),
    h(
      "div",
      { style: "margin-top:auto;padding-top:10px" },
      button("Remover Etapa", () => {
        const wf = state.activeCuration.workflow;
        wf.steps = wf.steps.filter((s) => s.id !== step.id);
        wf.edges = wf.edges.filter((e) => e.source !== step.id && e.target !== step.id);
        state.workflowSelectedStep = wf.steps[0] || null;
        render();
      }, "ghost small danger"),
    ),
  );
}

function renderWorkflowAccessibleList(steps, edges) {
  return h(
    "div",
    { class: "workflow-list-container" },
    h("h3", { class: "rda-typography rda-typography--lg rda-typography--semibold" }, "Etapas do Fluxo (Modo Acessível)"),
    h(
      "p",
      { class: "small muted" },
      "Visualização linear totalmente operável por teclado para leitores de tela e dispositivos de toque.",
    ),
    steps.map((s, idx) =>
      h(
        "div",
        {
          class: "workflow-list-step rda-card rda-card--p-sm",
          "data-color": "surface",
          "data-style": "outlined",
        },
        h(
          "div",
          {},
          h("strong", {}, idx + 1 + ". " + s.label),
          h("div", { class: "small muted" }, s.kind + " · Papel: " + s.role_function + " · Modelo: " + (s.model_alias || "padrão")),
        ),
        h(
          "div",
          { class: "row", style: "gap:4px" },
          button(icon("arrow-up"), () => moveWorkflowStep(idx, -1), "ghost small", {
            "aria-label": "Mover etapa para cima",
            disabled: idx === 0,
          }),
          button(icon("arrow-down"), () => moveWorkflowStep(idx, 1), "ghost small", {
            "aria-label": "Mover etapa para baixo",
            disabled: idx === steps.length - 1,
          }),
          button("Configurar", () => {
            state.workflowSelectedStep = s;
            state.workflowMode = "canvas";
            render();
          }, "ghost small"),
        ),
      ),
    ),
  );
}

function moveWorkflowStep(idx, delta) {
  const steps = state.activeCuration.workflow.steps;
  const target = idx + delta;
  if (target < 0 || target >= steps.length) return;
  const temp = steps[idx];
  steps[idx] = steps[target];
  steps[target] = temp;
  render();
}

function approvalGateBanner(pending) {
  return h(
    "div",
    { class: "approval-gate-banner rda-notice rda-notice--warning", "data-color": "warning" },
    h("h4", { class: "rda-notice__title" }, [icon("circle-stop"), " Confirmação Humana Obrigatória (Decisão 17A)"]),
    h(
      "div",
      { class: "small rda-notice__description" },
      "O fluxo pausou no portão de aprovação antes de executar alterações no Spotify.",
    ),
    h("div", { class: "small" }, "Ação proposta: ", h("strong", {}, pending.action_type || "Publicação Curatorial")),
    h("div", { class: "approval-hash-code rda-kbd rda-kbd--md" }, "Hash Canônico Único: " + pending.payload_hash),
    h(
      "div",
      { class: "row", style: "margin-top:6px;gap:8px" },
      button("Aprovar e Publicar no Spotify", async () => {
        try {
          await api("/curations/" + state.activeCuration.id + "/execute", "POST", {
            approval_id: pending.approval_id,
            approved: true,
            payload_hash: pending.payload_hash,
          });
          toast("Aprovação registrada com sucesso.");
          state.workflowExecution.pending_approval = null;
          await loadCurations();
        } catch (err) {
          showError(err);
        }
      }, "primary small"),
      button("Recusar / Modificar", () => {
        state.workflowExecution.pending_approval = null;
        toast("Execução cancelada.");
        render();
      }, "ghost small"),
    ),
  );
}

function addWorkflowStepModal() {
  let labelInput, kindSelect, roleSelect;
  const modalContent = h(
    "div",
    { class: "modal-content stack" },
    h("h2", { class: "rda-dialog__title" }, "Adicionar Nova Etapa"),
    field("Nome da etapa", (labelInput = h("input", { type: "text", value: "Nova Etapa" }))),
    field(
      "Tipo da etapa",
      (kindSelect = h(
        "select",
        {},
        ["briefing", "research", "selection", "sequencing", "review", "approval_gate"].map((k) =>
          h("option", { value: k }, k),
        ),
      )),
    ),
    field(
      "Função do Modelo",
      (roleSelect = h(
        "select",
        {},
        ["briefing", "research", "selection", "sequencing", "review", "synthesis"].map((r) =>
          h("option", { value: r }, r),
        ),
      )),
    ),
    h(
      "div",
      { class: "modal-actions rda-dialog__footer" },
      button("Cancelar", closeModal, "ghost"),
      button("Adicionar", () => {
        const wf = state.activeCuration.workflow;
        const sid = "step_" + Date.now().toString(36);
        const lastStep = wf.steps[wf.steps.length - 1];
        const newX = lastStep ? (lastStep.position?.x || 100) + 240 : 100;
        const newY = lastStep ? lastStep.position?.y || 140 : 140;

        const newStep = {
          id: sid,
          kind: kindSelect.value,
          label: labelInput.value.trim() || "Etapa",
          role_function: roleSelect.value,
          model_alias: "rda/chat-default",
          instructions: "",
          allowed_tools: [],
          requires_approval: kindSelect.value === "approval_gate",
          position: { x: newX, y: newY },
        };
        wf.steps.push(newStep);
        if (lastStep) {
          wf.edges.push({ id: "e_" + Date.now().toString(36), source: lastStep.id, target: sid });
        }
        closeModal();
        state.workflowSelectedStep = newStep;
        render();
      }, "primary"),
    ),
  );
  openModal(modalContent);
}

async function validateWorkflowDag() {
  const cur = state.activeCuration;
  if (!cur || !cur.workflow) return;
  try {
    const res = await api("/curations/" + cur.id + "/workflow", "PUT", cur.workflow);
    state.workflowValidation = {
      valid: true,
      message: "Grafo acíclico válido. Ordem de execução: " + res.topological_order.join(", "),
    };
  } catch (err) {
    state.workflowValidation = {
      valid: false,
      message: err.message || "Ciclo ou conexão inválida detectada no grafo.",
    };
  }
  render();
}

async function saveWorkflow() {
  const cur = state.activeCuration;
  if (!cur || !cur.workflow) return;
  try {
    const res = await api("/curations/" + cur.id + "/workflow", "PUT", cur.workflow);
    cur.workflow.version = res.version;
    toast("Fluxo salvo (versão " + res.version + ").");
    state.workflowValidation = {
      valid: true,
      message: "Fluxo salvo com sucesso. Topologia: " + res.topological_order.join(", "),
    };
    render();
  } catch (err) {
    showError(err);
  }
}

async function executeWorkflow() {
  const cur = state.activeCuration;
  if (!cur) return;
  try {
    toast("Iniciando execução do fluxo...");
    const res = await api("/curations/" + cur.id + "/execute", "POST", {});
    state.workflowExecution = res;
    if (res.status === "awaiting_approval") {
      toast("Fluxo pausado no portão de aprovação humana.");
    } else {
      toast("Fluxo executado com sucesso.");
    }
    render();
  } catch (err) {
    showError(err);
  }
}

function dossierSubView() {
  if (!state.activeCuration) {
    return h(
      "div",
      { class: "empty-state rda-empty-state" },
      h("span", { class: "rda-empty-state__icon", "aria-hidden": true }, icon("layers")),
      h("h3", { class: "rda-empty-state__title" }, "Nenhum projeto selecionado"),
      h("p", { class: "small muted rda-empty-state__description" }, "Selecione um projeto para visualizar o dossiê curatorial."),
    );
  }

  const cur = state.activeCuration;
  return h(
    "div",
    { class: "dossier-container" },
    h(
      "div",
      { class: "row between", style: "margin-bottom:16px" },
      h("h2", { class: "rda-typography rda-typography--xl rda-typography--bold", style: "margin:0" }, "Dossiê Curatorial — " + cur.title),
      button("Copiar Markdown", async () => {
        try {
          const d = await api("/curations/" + cur.id + "/dossier");
          navigator.clipboard.writeText(d.markdown);
          toast("Dossiê copiado para a área de transferência.");
        } catch (err) {
          showError(err);
        }
      }, "primary small"),
    ),
    h(
      "div",
      {
        class: "dossier-markdown rda-card rda-card--p-lg",
        "data-color": "surface",
        "data-style": "matte",
        id: "dossier-content",
      },
      "Carregando dossiê curatorial...",
    ),
  );
}

// Auto-fetch dossier when opened
safe(async () => {
  if (state.view === "curations" && state.curationsTab === "dossier" && state.activeCuration) {
    try {
      const d = await api("/curations/" + state.activeCuration.id + "/dossier");
      const el = $("#dossier-content");
      if (el) el.textContent = d.markdown;
    } catch {}
  }
});

function editorialModelsSubView() {
  const drams = state.editorialModels?.dramaturgias || [];
  return h(
    "div",
    { style: "display:flex;flex-direction:column;gap:14px" },
    h("h3", { class: "rda-typography rda-typography--xl rda-typography--bold" }, "Catálogo de Metodologias & 12 Dramaturgias (Escuta & Imagem v2.0)"),
    h(
      "p",
      { class: "small muted" },
      "Cada dramaturgia define uma curva de intensidade narrativa e pacing sonoro único.",
    ),
    h(
      "div",
      { class: "dramaturgia-gallery" },
      drams.map((d) =>
        h(
          "div",
          {
            class: "dramaturgia-card rda-card rda-card--p-md",
            "data-color": "surface",
            "data-style": "matte",
          },
          h("strong", { class: "rda-typography rda-typography--base rda-typography--bold", style: "color:var(--rda-action-primary-bg)" }, d.name),
          h("div", { class: "small muted" }, d.description),
          h(
            "div",
            { class: "dramaturgia-pacing-bar" },
            d.arc.map((val) => h("span", { style: `height:${Math.round(val * 100)}%` })),
          ),
          button("Criar Projeto com este Modelo", () => {
            openNewCurationModal();
          }, "ghost small"),
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
