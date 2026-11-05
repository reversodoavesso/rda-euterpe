import { ICONS_DATA as l } from "./rda-icons-data.js";
const o = (e) => e.replace(/[&<>"']/g, (t) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[t]);
function b(e, t = {}) {
  const n = Object.hasOwn(l, e) ? e : "help-circle", i = l[n], s = String(t.size ?? "1em"), r = /^\d+(\.\d+)?(px|em|rem)?$/.test(s) ? s : "1em", a = i.elements?.map(([d, m]) => `<${d} ${Object.entries(m).map(([h, u]) => `${h}="${o(u)}"`).join(" ")}/>`).join("") ?? i.rawHtml ?? "", c = t.label ? `role="img" aria-label="${o(t.label)}"` : 'aria-hidden="true"';
  return `<svg class="rda-icon" data-icon="${n}" xmlns="http://www.w3.org/2000/svg" viewBox="${i.viewBox}" width="${r}" height="${r}" fill="${i.type === "fill" ? "currentColor" : "none"}" stroke="${i.type === "stroke" ? "currentColor" : "none"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${c}>${a}</svg>`;
}
function g() {
  if (typeof customElements > "u" || customElements.get("rda-icon")) return;
  class e extends HTMLElement {
    static observedAttributes = ["name", "size", "label"];
    connectedCallback() {
      this.render();
    }
    attributeChangedCallback() {
      this.isConnected && this.render();
    }
    render() {
      this.style.display = "inline-flex", this.style.verticalAlign = "middle", this.style.flexShrink = "0", this.style.lineHeight = "0", this.innerHTML = b(this.getAttribute("name") || "", {
        size: this.getAttribute("size") || "1em",
        label: this.getAttribute("label") || void 0
      });
    }
  }
  customElements.define("rda-icon", e);
}
g();
export {
  b as iconMarkup,
  g as registerIcons
};

