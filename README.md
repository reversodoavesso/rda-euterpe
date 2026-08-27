# Euterpe

Centro agentic pessoal dentro do Spotify desktop (spicetify). Chat com um agente (DeepSeek) que lê suas playlists/músicas, cruza com websearch (SearXNG), letras e metadados, e cria playlists curadas — com capa.

Veja [PLAN.md](./PLAN.md) para o plano completo.

## Estrutura

```
app/      Custom App + Extension do spicetify (interface no Spotify)
agent/    Servidor local do agente (Node/TS, Fastify + ws)
docker-compose.yml   SearXNG (websearch open-source)
```

## Setup rápido

1. Instale e aplique o spicetify (ver `app/README.md`).
2. Suba o SearXNG: `docker compose up -d`
3. Agente: `cd agent && npm install && copy .env.example .env` (coloque a chave DeepSeek) e `npm run dev`
4. Instale o custom app e a extension (ver `app/README.md`).
