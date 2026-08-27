import WebSocket from "ws";

const cfg = await (await fetch("http://127.0.0.1:8337/config")).json();
const ws = new WebSocket("ws://127.0.0.1:8337/ws");
const got = [];

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(), 60000);
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    got.push(msg);
    if (msg.type === "chat.done") {
      clearTimeout(timer);
      resolve();
    }
  });
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== "tool.call") return;
  let data = { mocked: true };
  if (msg.name === "get_playlists") data = { playlists: [{ id: "p1", name: "Minhas Favoritas", tracks: 10 }, { id: "p2", name: "Trabalho", tracks: 5 }] };
  if (msg.name === "get_top_artists") data = [{ id: "a1", name: "Radiohead", genres: ["art rock", "alternative rock"] }, { id: "a2", name: "Björk", genres: ["art pop"] }];
  if (msg.name === "search_spotify") data = { tracks: [{ id: "t1", uri: "spotify:track:t1", name: "Exit Music" }], artists: [] };
  ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: true, data }));
});

await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
ws.send(JSON.stringify({ type: "hello", secret: cfg.secret, appVersion: "0.1.0" }));
await new Promise((r) => setTimeout(r, 500));
ws.send(JSON.stringify({ type: "chat.send", text: "lista minhas playlists e recomenda artistas similares a Radiohead", sessionId: "live-log" }));
await done;
ws.close();

for (const m of got) {
  if (m.type === "chat.status") console.log("[status]", m.detail || m.status);
  else if (m.type === "tool.call") console.log("[tool.call]", m.name, JSON.stringify(m.args).slice(0, 100));
  else if (m.type === "chat.stream") process.stdout.write(m.delta);
  else if (m.type === "chat.done") console.log("\n[done]");
}
