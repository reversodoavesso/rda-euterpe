// Ícones — do PRÓPRIO client, não emoji.
//
// O Spotify publica um icon set via spicetify: `Spicetify.SVGIcons`, um mapa
// nome → `<path>` (16x16, `fill: currentColor`). São os ícones do DS dele — a
// lista completa é `Object.keys(Spicetify.SVGIcons)` (77 nomes em 1.3.4).
//
// Por que não emoji: emoji não herda `currentColor` (não acompanha o tema), muda
// de forma por plataforma/fonte e destoa do traço do Spotify. Por que não uma lib
// externa: não é necessário — todos os conceitos da UI existem no set do client
// (`search`, `check`, `x`, `collapseLibrary`, `expandLibrary`, `enhance`,
// `locked`, `play`, `heart`, `share`, `more`, `edit`, `copy`…). Se um dia faltar,
// o caminho é acrescentar o path aqui com a licença citada, nunca inventar.
const { React } = Spicetify;

/**
 * Nomes usados pela UI, com o significado (o nome cru do client não diz muito).
 * Só constantes daqui: nome inexistente devolve `null` e o chamador precisa de
 * fallback — foi o que deixou o botão de limpar conversa invisível com "ban".
 */
export const ICON = {
  search: "search", // campo de busca do rail
  check: "check", // item concluído / perfil ativo
  close: "x", // fechar / apagar conversa
  collapse: "chevron-left", // recolher o rail para a esquerda
  expand: "chevron-right", // expandir o rail para a direita
  chevronLeft: "chevron-left",
  chevronRight: "chevron-right",
  profile: "enhance", // ✨ perfil/boost aplicado à conversa (era ⚡)
  pinned: "locked", // 🔒 perfil fixado nesta conversa (era 📌)
  copy: "copy",
  play: "play",
  playlist: "playlist",
  album: "album",
  artist: "artist",
};

/** O client tem esse ícone? */
export function hasIcon(name) {
  return !!(Spicetify && Spicetify.SVGIcons && Spicetify.SVGIcons[name]);
}

/**
 * `<svg>` do ícone nativo, ou `null` se o nome não existir no set.
 * Sempre use `ICON.*` (tipado) e trate o `null` com um fallback visível.
 */
export function icon(name, size = 16) {
  try {
    const path = Spicetify && Spicetify.SVGIcons && Spicetify.SVGIcons[name];
    if (!path) {
      console.warn(`[euterpe] icone "${name}" nao existe no Spicetify.SVGIcons`);
      return null;
    }
    return React.createElement("svg", {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": true,
      dangerouslySetInnerHTML: { __html: path },
    });
  } catch (err) {
    return null;
  }
}

/** Ícone embrulhado num `<span>` alinhado ao texto (uso inline, em linha de copy). */
export function InlineIcon({ name, size = 14, style }) {
  const svg = icon(name, size);
  if (!svg) return null;
  return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", flexShrink: 0, ...style } }, svg);
}
