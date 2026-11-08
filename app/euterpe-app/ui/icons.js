// Official RDA DS catalog and renderer, bundled with the desktop application.
import { iconMarkup } from "../../../web/dist/rda-icons.js";
import { ICONS_DATA } from "../../../web/dist/rda-icons-data.js";

const { React } = Spicetify;

export const ICON = {
  search: "search", check: "check", close: "x",
  collapse: "chevron-left", expand: "chevron-right",
  chevronLeft: "chevron-left", chevronRight: "chevron-right",
  profile: "sparkles", pinned: "lock", copy: "copy", play: "play",
  playlist: "list-music", album: "disc-3", artist: "user",
};

// Preserve the existing semantic names used by markdown chips.
const aliases = { playlist: ICON.playlist, album: ICON.album, artist: ICON.artist };
export function hasIcon(name) {
  return Object.hasOwn(ICONS_DATA, aliases[name] || name);
}
export function icon(name, size = 16) {
  return React.createElement("span", {
    style: { display: "inline-flex", verticalAlign: "middle", flexShrink: 0, lineHeight: 0 },
    "aria-hidden": true,
    dangerouslySetInnerHTML: { __html: iconMarkup(aliases[name] || name, { size }) },
  });
}
export function InlineIcon({ name, size = 14, style }) {
  return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", flexShrink: 0, ...style } }, icon(name, size));
}
