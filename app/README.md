# Euterpe — instalação no Spotify (spicetify)

Requisitos: spicetify CLI instalado e aplicado (veja https://spicetify.app/docs/getting-started), agente local rodando (`cd agent && npm install && npm run dev`), SearXNG no Docker (`docker compose up -d`).

## Automático (recomendado)

```
node app/install.mjs
```

Copia os arquivos, ativa `custom_apps`/`extensions`, roda `spicetify apply` e, se houver mismatch de backup (update do Spotify), executa `spicetify backup apply` automaticamente. Reinicie o Spotify e abra **Euterpe** na sidebar.

## Manual

### Custom App

```
app/euterpe-app/   →  ~/.config/spicetify/CustomApps/euterpe-app/   (Linux)
                      %appdata%\spicetify\CustomApps\euterpe-app\  (Windows)
```

Ative e aplique:

```
spicetify config custom_apps euterpe-app
spicetify apply
```

## Extension

```
app/euterpe-extension/euterpe.js  →  ~/.config/spicetify/Extensions/euterpe.js   (Linux)
                                     %appdata%\spicetify\Extensions\euterpe.js  (Windows)
```

Ative e aplique:

```
spicetify config extensions euterpe.js
spicetify apply
```

Reinicie o Spotify. A extensão conecta sozinha no agente (`ws://127.0.0.1:8337`). Abra **Euterpe** na sidebar pra usar o chat.

## Desfazer (restore)

Se algo quebrar após um update do Spotify:

```
spicetify restore backup apply
```
