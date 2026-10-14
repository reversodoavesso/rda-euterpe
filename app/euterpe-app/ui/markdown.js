// Renderização de markdown do chat — movido verbatim de euterpe-app/index.js.
//
// Nada aqui mudou de comportamento: mesmo parser de tokens inline, mesmos chips
// {{spotify:...}}, mesmas tags/estilos inline. A única diferença é a função
// `copyText` compartilhada (Clipboard API + fallback) para o botão "copiar" do
// bloco de código — a mesma usada pelo botão de copiar mensagem.
import { tr } from "../lib/i18n.js";

const { React } = Spicetify;

/** Copia para a área de transferência; devolve false quando não foi possível. */
export function copyText(text) {
  const value = String(text == null ? "" : text);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {}
  // Fallback (renderer sem permissão de clipboard API): textarea temporário.
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (err) {
    return false;
  }
}

// Reexporta a camada de ícones (`ui/icons.js`): aqui é onde o markdown e o chat
// sempre buscaram o ícone nativo, então o nome fica.
import { icon as nativeIcon } from "./icons.js";
export { nativeIcon };

export function spotifyLinkIcon(size) {
  const path =
    (Spicetify &&
      Spicetify.SVGIcons &&
      (Spicetify.SVGIcons["spotify-logo"] || Spicetify.SVGIcons["external-link"] || Spicetify.SVGIcons["link"])) ||
    null;
  if (path) {
    return React.createElement("svg", {
      width: size || 14,
      height: size || 14,
      viewBox: "0 0 16 16",
      fill: "currentColor",
      dangerouslySetInnerHTML: { __html: path },
    });
  }
  return React.createElement(
    "svg",
    { width: size || 14, height: size || 14, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
    React.createElement("path", {
      d: "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3.67 11.54c-.15.24-.47.31-.71.16-1.94-1.18-4.38-1.45-7.26-.8-.28.06-.55-.12-.61-.4-.06-.28.12-.55.4-.61 3.15-.7 5.85-.4 8.01.9.25.15.32.48.17.72Zm.99-2.18c-.19.3-.58.39-.88.2-2.22-1.36-5.6-1.76-8.22-.96-.32.1-.67-.08-.77-.4-.1-.32.08-.67.4-.77 2.98-.91 6.69-.46 9.26 1.12.3.18.38.58.21.88v.01Zm.09-2.26C10.07 5.4 6.06 5.21 3.57 5.99c-.38.12-.78-.1-.9-.47-.12-.38.1-.78.47-.9 2.84-.89 7.27-.68 10.14 1.34.34.25.42.73.18 1.07-.25.34-.73.42-1.07.18l-.02-.01Z",
    })
  );
}

/* Euterpe logo — Lyre mark from assets/logo.svg.
   Same art as the manifest.json icon. Keep path in sync with manifest.json. */
export const EUTERPE_LOGO_PATH =
  "M633.112 49.516 C692.388 9.876 771.112 54.103 760.907 126.793 C756.688 156.845 729.707 180.643 699.487 179.928 C692.385 179.759 682.548 177.675 677.095 172.845 C671.605 167.983 684.326 167.436 688.81 159.504 C694.351 149.701 691.744 136.102 682.735 129.256 C676.981 124.883 671.378 124.667 664.555 126.273 C637.777 132.574 636.328 168.933 640.438 190.635 C645.632 218.058 667.207 242.704 683.444 264.887 C740.753 343.181 797.452 418.615 797.315 517.167 L797.315 518.569 C797.315 522.398 797.251 526.215 797.125 530.02 L797.319 727.701 C797.319 745.693 797.111 763.764 797.325 781.749 C797.371 785.636 797.6 790.186 797.751 794.799 C797.943 800.684 798.014 806.631 797.705 812.034 C797.576 814.278 797.383 816.461 797.117 818.559 C796.421 824.037 794.525 829.506 791.653 835.263 C789.451 839.678 786.967 843.685 784.462 846.787 C768.684 866.324 744.805 871.958 722.067 861.345 C709.781 855.61 699.019 845.869 687.108 833.01 C678.258 823.456 667.641 810.813 658.857 802.412 C657.367 800.987 655.885 799.636 654.411 798.388 C652.682 796.924 650.861 795.484 648.92 794.308 C646.364 795.632 643.222 797.906 640.879 799.667 C635.701 803.557 631.667 806.912 626.614 810.473 C619.536 815.46 610.989 819.318 603.449 823.538 C602.123 824.28 600.825 824.903 599.557 825.413 L598.938 825.711 C598.952 825.719 598.965 825.727 598.979 825.735 C598.428 825.988 597.876 826.24 597.324 826.49 L596.638 826.82 C596.638 826.82 596.63 826.817 596.612 826.811 C549.648 847.936 499.197 857.584 448.747 855.722 L448.747 855.722 C366.099 858.772 283.448 830.932 216.127 772.345 C142.192 708.002 100.18 616.955 100.18 518.569 L100.18 517.167 C100.042 418.615 156.742 343.181 214.05 264.887 C230.287 242.704 251.863 218.058 257.057 190.635 C261.167 168.933 259.718 132.574 232.94 126.273 C226.117 124.667 220.514 124.883 214.76 129.256 C205.751 136.102 203.143 149.701 208.685 159.504 C213.169 167.436 225.89 167.983 220.4 172.845 C214.947 177.675 205.11 179.759 198.007 179.928 C167.788 180.643 140.806 156.845 136.588 126.793 C126.383 54.103 205.107 9.876 264.383 49.516 C286.432 64.262 302.895 88.82 311.612 113.583 C322.63 144.887 323.297 182.192 311.958 213.518 C302.55 239.508 283.731 265.297 267.831 287.837 C217.792 358.768 165.185 424.938 169.195 517.175 L169.195 517.978 C169.197 596.4 203.138 669.862 262.013 721.099 C310.402 763.21 368.074 785.07 426.736 787.104 L426.736 722.389 C404.845 713.464 389.416 691.968 389.416 666.869 C389.416 641.77 404.845 620.275 426.736 611.35 L426.736 138.057 C426.736 125.635 436.806 115.566 449.228 115.566 C461.649 115.566 471.719 125.635 471.719 138.057 L471.719 611.252 C493.738 620.117 509.28 641.678 509.28 666.869 C509.28 692.06 493.738 713.622 471.719 722.486 L471.719 784.718 C471.806 784.193 471.873 783.667 471.919 783.143 C471.94 782.895 471.954 782.69 471.961 782.531 C471.934 783.216 471.921 784.686 471.917 787.061 C498.572 786.018 525.011 780.879 550.457 771.605 C553.707 770.271 558.465 768.193 565.042 765.038 C565.296 764.854 565.562 764.695 565.838 764.562 C570.953 762.093 595.285 747.619 599.408 744.52 C606.065 739.517 612.684 735.103 620.043 731.623 C630.676 726.595 642.083 723.986 653.894 724.868 C685.303 727.216 708.6 753.561 728.267 775.64 C728.162 759.674 728.319 743.657 728.319 727.701 C728.319 727.701 728.424 712.966 728.335 698.225 C728.245 683.484 728.298 574.322 728.3 517.978 L728.3 517.175 C732.31 424.938 679.702 358.768 629.664 287.837 C613.764 265.297 594.945 239.508 585.537 213.518 C574.198 182.192 574.864 144.887 585.883 113.583 C594.599 88.82 611.063 64.262 633.112 49.516 Z M352.531 308.629 C352.531 296.208 362.601 286.138 375.022 286.138 C387.444 286.138 397.514 296.208 397.514 308.629 L397.514 436.598 L397.289 436.598 C397.252 450.947 397.202 471.47 397.202 500.088 C397.202 520.718 393.623 536.18 387.9 548.54 C382.381 560.461 375.224 568.909 367.376 576.856 C362.567 581.726 356.807 586.995 353.454 592.083 C350.883 595.984 348.697 601.112 348.154 610.135 C347.655 618.443 349.565 624.107 352.164 628.289 C354.558 632.141 357.963 635.383 361.848 638.067 C359.656 645.845 358.483 654.051 358.483 662.531 C358.483 671.329 359.745 679.833 362.099 687.87 C355.716 685.703 348.105 682.499 340.526 677.854 C315.081 662.258 301.427 637.527 303.235 607.435 C304.251 590.542 308.969 577.806 315.879 567.321 C318.965 562.639 322.465 558.455 326.198 554.495 C329.158 551.355 332.269 548.364 335.357 545.237 C339.373 541.17 343.96 536.338 347.065 529.632 C350.044 523.198 352.202 514.188 352.202 500.088 C352.202 438.152 352.428 413.644 352.289 410.103 C352.296 410.262 352.31 410.467 352.331 410.715 C352.377 411.239 352.444 411.765 352.531 412.29 Z M499.667 310.742 C499.667 298.32 509.737 288.25 522.159 288.25 C534.58 288.25 544.65 298.32 544.65 310.742 L544.65 414.403 C544.737 413.878 544.804 413.352 544.85 412.828 C544.871 412.58 544.886 412.375 544.892 412.216 C544.753 415.757 544.979 440.264 544.979 502.201 C544.979 516.301 547.137 525.311 550.116 531.745 C553.221 538.451 557.808 543.283 561.824 547.35 C564.912 550.477 568.023 553.468 570.983 556.608 C574.716 560.568 578.216 564.752 581.302 569.434 C588.212 579.919 592.93 592.654 593.946 609.548 C595.755 639.64 582.1 664.371 556.655 679.966 C549.076 684.611 541.465 687.815 535.082 689.983 C537.436 681.945 538.698 673.442 538.698 664.644 C538.698 656.164 537.525 647.958 535.333 640.179 C539.218 637.496 542.623 634.254 545.017 630.402 C547.616 626.22 549.526 620.556 549.027 612.248 C548.484 603.225 546.298 598.097 543.727 594.195 C540.374 589.108 534.614 583.839 529.805 578.969 C521.957 571.022 514.8 562.573 509.281 550.653 C503.558 538.293 499.979 522.831 499.979 502.201 C499.979 473.582 499.929 453.059 499.892 438.711 L499.667 438.711 Z";

export function euterpeLogo(size) {
  return React.createElement(
    "svg",
    {
      width: size || 18,
      height: size || 18,
      viewBox: "0 0 898.096 901.26",
      fill: "currentColor",
      "aria-hidden": true,
      style: { display: "block" },
    },
    React.createElement("path", { fill: "currentColor", d: EUTERPE_LOGO_PATH })
  );
}

export function spotifyChip(raw, key) {
  const m = raw.match(/^\{\{\s*spotify:(track|playlist|album|artist|show|episode):([A-Za-z0-9_-]{6,})(?:\s*\|\s*([\s\S]*?))?\s*\}\}$/);
  if (!m) return null;
  const type = m[1];
  const uri = "spotify:" + type + ":" + m[2];
  const label = (m[3] || "").trim() || uri;
  const iconName = { track: "play", playlist: "playlist", album: "album", artist: "artist" }[type] || "play";
  const isArtist = type === "artist";
  const play = () => {
    try {
      const P = Spicetify.Player;
      if (P && typeof P.playUri === "function") {
        P.playUri(uri);
      } else if (P && P.origin && typeof P.origin.play === "function") {
        P.origin.play({ uri });
      }
    } catch (err) {}
  };
  const open = () => {
    try {
      if (window.euterpe && typeof window.euterpe.openUri === "function") {
        if (window.euterpe.openUri(uri)) return;
      }
    } catch (err) {}
    try {
      const hist = Spicetify.Platform && Spicetify.Platform.History;
      if (hist && typeof hist.push === "function") {
        hist.push(uri);
      }
    } catch (err) {}
  };
  if (isArtist) {
    return React.createElement(
      "button",
      {
        key,
        onClick: open,
        title: tr("chip.artistTitle"),
        style: {
          background: "none",
          border: "none",
          color: "var(--euterpe-accent)",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 13,
          padding: 0,
          margin: "2px 4px 2px 0",
          verticalAlign: "middle",
          textDecoration: "underline",
          textUnderlineOffset: 2,
          textDecorationColor: "var(--euterpe-accent)",
        },
      },
      ...mdInline(label, `${key}-lb`)
    );
  }
  return React.createElement(
    "span",
    {
      key,
      title: uri,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "var(--euterpe-chip-bg)",
        border: "1px solid var(--euterpe-chip-border)",
        borderRadius: "500px",
        padding: "3px 8px 3px 8px",
        margin: "2px 4px 2px 0",
        verticalAlign: "middle",
      },
    },
    React.createElement("span", { style: { display: "inline-flex", opacity: 0.9, color: "var(--euterpe-accent)" } }, nativeIcon(iconName)),
    React.createElement(
      "button",
      {
        onClick: play,
        title: tr("chip.play"),
        style: {
          background: "none",
          border: "none",
          color: "var(--euterpe-text)",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 13,
          padding: 0,
        },
      },
      ...mdInline(label, `${key}-lb`)
    ),
    React.createElement(
      "button",
      {
        onClick: open,
        title: tr("chip.open"),
        "aria-label": tr("chip.open"),
        style: {
          background: "none",
          border: "none",
          color: "var(--euterpe-accent)",
          cursor: "pointer",
          fontSize: 11,
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
        },
      },
      spotifyLinkIcon(12)
    )
  );
}

export function mdInline(text, keyPrefix) {
  const nodes = [];
  const tokenRe =
    /(\{\{spotify:[\s\S]+?\}\}|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|~~[^~\n]+~~|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(React.createElement("span", { key: `${keyPrefix}-t${k++}` }, text.slice(last, m.index)));
    }
    const tok = m[0];
    let el = null;
    if (tok.startsWith("{{spotify:")) {
      el = spotifyChip(tok, `${keyPrefix}-sp${k++}`);
      if (!el) {
        el = React.createElement("span", { key: `${keyPrefix}-spraw${k++}` }, tok);
      }
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      el = React.createElement("strong", { key: `${keyPrefix}-b${k++}` }, ...mdInline(tok.slice(2, -2), `${keyPrefix}-bin${k}`));
    } else if (tok.startsWith("`")) {
      el = React.createElement(
        "code",
        {
          key: `${keyPrefix}-c${k++}`,
          style: {
            background: "var(--euterpe-code-bg)",
            padding: "1px 5px",
            borderRadius: 4,
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.9em",
          },
        },
        tok.slice(1, -1)
      );
    } else if (tok.startsWith("~~")) {
      el = React.createElement("s", { key: `${keyPrefix}-s${k++}` }, ...mdInline(tok.slice(2, -2), `${keyPrefix}-sin${k}`));
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) {
        el = React.createElement(
          "a",
          {
            key: `${keyPrefix}-a${k++}`,
            href: mm[2],
            target: "_blank",
            rel: "noopener noreferrer",
            style: { color: "var(--euterpe-accent)", textDecoration: "underline" },
          },
          ...mdInline(mm[1], `${keyPrefix}-ain${k}`)
        );
      }
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      el = React.createElement("em", { key: `${keyPrefix}-i${k++}` }, ...mdInline(tok.slice(1, -1), `${keyPrefix}-iin${k}`));
    }
    if (el) nodes.push(el);
    last = m.index + tok.length;
  }
  if (last < text.length) {
    nodes.push(React.createElement("span", { key: `${keyPrefix}-t${k++}` }, text.slice(last)));
  }
  return nodes;
}

export function renderMarkdown(md, keyBase = "md") {
  if (!md) return [];
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      const codeText = code.join("\n");
      const copy = () => {
        copyText(codeText);
      };
      blocks.push(
        React.createElement(
          "div",
          {
            key: `${keyBase}-code${key++}`,
            style: {
              background: "var(--euterpe-code-bg)",
              borderRadius: 10,
              padding: "10px 12px",
              margin: "6px 0",
              position: "relative",
            },
          },
          React.createElement(
            "pre",
            { style: { margin: 0, overflowX: "auto", fontFamily: "ui-monospace, monospace", fontSize: "12px", whiteSpace: "pre-wrap" } },
            React.createElement("code", null, codeText)
          ),
          React.createElement(
            "button",
            {
              onClick: copy,
              style: {
                position: "absolute",
                top: 6,
                right: 6,
                background: "var(--euterpe-btn-bg)",
                border: "none",
                borderRadius: 6,
                padding: "3px 8px",
                fontSize: 11,
                color: "var(--euterpe-text)",
                cursor: "pointer",
              },
            },
            tr("code.copy")
          )
        )
      );
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const sizes = { 1: "1.35em", 2: "1.2em", 3: "1.1em", 4: "1em", 5: ".95em", 6: ".9em" };
      const tag = "h" + level;
      blocks.push(
        React.createElement(
          tag,
          { key: `${keyBase}-h${key++}`, style: { margin: "10px 0 4px", fontSize: sizes[level], fontWeight: 700 } },
          ...mdInline(h[2], `${keyBase}-h${key}`)
        )
      );
      i++;
      continue;
    }

    if (line.trim().startsWith(">")) {
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        React.createElement(
          "blockquote",
          {
            key: `${keyBase}-q${key++}`,
            style: {
              margin: "6px 0",
              padding: "2px 12px",
              borderLeft: "3px solid var(--euterpe-accent)",
              color: "var(--euterpe-text-dim)",
            },
          },
          ...mdInline(quote.join("\n"), `${keyBase}-q${key}`)
        )
      );
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(
        React.createElement("hr", {
          key: `${keyBase}-hr${key++}`,
          style: { border: "none", borderTop: "1px solid var(--euterpe-divider)", margin: "8px 0" },
        })
      );
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+/.test(line);
    const ordered = /^\s*\d+\.\s+/.test(line);
    if (bullet || ordered) {
      const isTask = /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line);
      const items = [];
      while (i < lines.length) {
        const bl = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const ol = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (bullet && bl) {
          items.push(bl[1]);
          i++;
        } else if (ordered && ol) {
          items.push(ol[1]);
          i++;
        } else break;
      }
      if (isTask) {
        blocks.push(
          React.createElement(
            "div",
            { key: `${keyBase}-t${key++}`, style: { margin: "6px 0", display: "flex", flexDirection: "column", gap: "3px" } },
            items.map((it, j) => {
              const tm = it.match(/^\[([ xX])\]\s+(.*)$/);
              const checked = tm ? /[xX]/.test(tm[1]) : false;
              const body = tm ? tm[2] : it;
              return React.createElement(
                "div",
                { key: j, style: { display: "flex", alignItems: "flex-start", gap: 8 } },
                React.createElement(
                  "span",
                  {
                    style: {
                      color: checked ? "var(--euterpe-accent)" : "var(--euterpe-text-muted)",
                      fontSize: 13,
                      lineHeight: "1.5",
                    },
                  },
                  checked ? "☑" : "☐"
                ),
                React.createElement("span", { style: checked ? { opacity: 0.6, textDecoration: "line-through" } : {} }, ...mdInline(body, `${keyBase}-tk${key}${j}`))
              );
            })
          )
        );
        continue;
      }
      blocks.push(
        React.createElement(
          bullet ? "ul" : "ol",
          { key: `${keyBase}-l${key++}`, style: { margin: "6px 0", paddingLeft: "22px" } },
          items.map((it, j) =>
            React.createElement("li", { key: j, style: { margin: "2px 0" } }, ...mdInline(it, `${keyBase}-li${key}${j}`))
          )
        )
      );
      continue;
    }

    const soloChip = line.trim().match(/^\{\{spotify:[\s\S]+?\}\}$/);
    if (soloChip) {
      const chip = spotifyChip(line.trim(), `${keyBase}-solo${key++}`);
      if (chip) {
        blocks.push(React.createElement("div", { key: `${keyBase}-solo${key}`, style: { margin: "4px 0" } }, chip));
        i++;
        continue;
      }
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().startsWith("```")) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      blocks.push(
        React.createElement("p", { key: `${keyBase}-p${key++}`, style: { margin: "4px 0" } }, ...mdInline(para.join(" "), `${keyBase}-p${key}`))
      );
    } else {
      i++;
    }
  }
  return blocks;
}
