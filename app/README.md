# Euterpe — instalação no Spotify (spicetify)

Requisitos: **spicetify CLI** instalado e aplicado ([getting-started](https://spicetify.app/docs/getting-started))
e o daemon `euterpe.exe` disponível (ver `../core/README.md` — **não há mais Docker nem Node obrigatórios**).

## Automático (recomendado)

```
node app/install.mjs
```

O que ele faz:

1. gera o bundle da UI (`node app/build.mjs` → `app/euterpe-app/dist/index.js`);
2. copia o bundle + `manifest.json` para `%appdata%\spicetify\CustomApps\euterpe-app\`;
3. copia `app/euterpe-extension/euterpe.js` para `%appdata%\spicetify\Extensions\euterpe.js`;
4. copia `core/target/.../release/euterpe.exe` para `%APPDATA%\euterpe\euterpe.exe` (se existir)
   e registra o autostart;
5. migra `agent/data/euterpe.db` → `%APPDATA%\euterpe\euterpe.db` (**só** se o destino não existir);
6. ativa `custom_apps`/`extensions`, roda `spicetify apply` (com fallback
   `spicetify backup apply`) e imprime os snippets prontos para plugar o MCP.

Reinicie o Spotify e abra **Euterpe** na sidebar.

## Manual

### Custom App

```
app/euterpe-app/dist/index.js  →  %appdata%\spicetify\CustomApps\euterpe-app\index.js   (Windows)
app/euterpe-app/manifest.json  →  %appdata%\spicetify\CustomApps\euterpe-app\manifest.json
                                  ~/.config/spicetify/CustomApps/euterpe-app/           (Linux)
```

Depois:

```
spicetify config custom_apps euterpe-app
spicetify apply
```

### Extension

```
app/euterpe-extension/euterpe.js  →  %appdata%\spicetify\Extensions\euterpe.js  (Windows)
                                     ~/.config/spicetify/Extensions/euterpe.js  (Linux)
```

```
spicetify config extensions euterpe.js
spicetify apply
```

Reinicie o Spotify. A extensão conecta sozinha no daemon (`http://127.0.0.1:8337`, handshake WS
em `ws://127.0.0.1:8337/ws` — o segredo vem de `GET /config`).

## Diagnóstico: "alterei e não pegou"

O spicetify mantém **três** cópias da extensão. Se os SHA-1 não baterem, o Spotify está rodando
código velho:

```powershell
Get-FileHash app\euterpe-extension\euterpe.js, `
  "$env:APPDATA\spicetify\Extensions\euterpe.js", `
  "$env:APPDATA\Spotify\Apps\xpui\extensions\euterpe.js" -Algorithm SHA1 |
  Format-Table Path, Hash
```

Se divergir, rode `node app/install.mjs` (ou `spicetify apply`) e reinicie o Spotify.

## Desfazer (restore)

Se algo quebrar após um update do Spotify:

```
spicetify restore backup apply
```
