// Cliente HTTP+SSE do daemon Euterpe (euterpe.exe na 8337).
//
// A porta é a MESMA da extensão (o WS continua em ws://127.0.0.1:8337/ws):
// o daemon Rust é o dono da 8337 e responde /config, /health, /chat, /providers,
// /models, /settings e /mcp. Contratos em core/src/http/*.rs — não invente campos.
//
// POST /chat é SSE: cada evento tem `event:` + `data:` (JSON). O parser abaixo
// tolera chunk cortando no meio de uma linha (mesmo problema que o sse.rs do
// daemon resolve do outro lado).
export const BASE = "http://127.0.0.1:8337";

async function request(path, init) {
  const res = await fetch(BASE + path, init);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {}
  if (!res.ok) {
    const detail = (body && (body.detail || body.error)) || `HTTP ${res.status}`;
    const error = new Error(String(detail));
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

function qs(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

export function getConfig() {
  return request("/config");
}

export function getHealth() {
  return request("/health");
}

// /probe responde 503/502 por design; devolvemos o status em vez de lançar.
export async function probe() {
  const res = await fetch(`${BASE}/probe`);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {}
  return { status: res.status, ok: res.ok, body };
}

export function listSessions() {
  return request("/sessions");
}

export function readSession(id) {
  return request(`/sessions/${encodeURIComponent(id)}`);
}

export function getSettings() {
  return request("/settings");
}

export function saveSettings(patch) {
  return request("/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch || {}),
  });
}

export function listProviders() {
  return request("/providers");
}

export function saveProvider(provider) {
  return request("/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(provider || {}),
  });
}

export function deleteProvider(id) {
  return request(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// 502 quando o provider não responde: o erro sobe com `detail` do daemon.
export function listModels(params) {
  return request(`/models${qs(params)}`);
}

export function testProvider(body) {
  return request("/providers/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

// Dados do painel MCP: clientes conectados + data dir (para o snippet stdio).
export async function mcpInfo() {
  const out = { ok: false, clients: 0, version: null, dataDir: null, url: `${BASE}/mcp` };
  try {
    const health = await getHealth();
    out.ok = health && health.ok === true;
    out.clients = Number(health && health.clients) || 0;
    out.version = (health && health.version) || null;
    const settings = await getSettings();
    const runtime = (settings && settings.runtime) || {};
    out.dataDir = runtime.dataDir || null;
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  }
  return out;
}

/**
 * Consome `POST /chat` (SSE) e chama `onEvent(evento, payload)` por evento.
 * `signal` (AbortController) é o botão stop do chat: abortar o fetch corta a
 * conexão e o cliente para de receber — o loop do daemon ainda conclui do lado
 * dele e persiste a resposta no histórico (pendência P12 do CHANGES.md:
 * propagar cancelamento até o loop para interromper as chamadas ao provider).
 */
export async function streamChat({ text, sessionId, locale, signal, onEvent }) {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId, locale }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = (body && (body.detail || body.error)) || detail;
    } catch (err) {}
    throw new Error(String(detail));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = () => {
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let name = "message";
      const data = [];
      for (const rawLine of block.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        // `: keep-alive` (comentário SSE) não tem campo: ignora.
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      let payload = null;
      try {
        payload = JSON.parse(data.join("\n"));
      } catch (err) {}
      if (onEvent) onEvent(name, payload);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flush();
    }
  } finally {
    buffer += decoder.decode();
    flush();
    try {
      reader.releaseLock();
    } catch (err) {}
  }
}
