/**
 * Discourse cooked HTML → Obsidian Markdown
 * 需在有 DOMParser 的环境运行（popup / content script）
 */

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "META", "LINK"]);
const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE", "TR",
  "HR", "DETAILS", "SUMMARY", "ASIDE", "FIGURE", "FIGCAPTION",
]);

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text) {
  return String(text || "").replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, g) => {
    if (g[0] === "#") {
      const code =
        g[1] === "x" || g[1] === "X"
          ? parseInt(g.slice(2), 16)
          : parseInt(g.slice(1), 10);
      if (!Number.isNaN(code)) return String.fromCodePoint(code);
      return m;
    }
    return ENTITY_MAP[g] ?? m;
  });
}

function classListOf(el) {
  if (!el || !el.classList) return [];
  return [...el.classList];
}

function parseFragment(html) {
  const doc = new DOMParser().parseFromString(
    `<div id="__l2md_root">${html || ""}</div>`,
    "text/html"
  );
  return doc.getElementById("__l2md_root");
}

/**
 * @param {string} html
 * @param {object} opts
 * @param {(src:string, img:Element)=>Promise<string|null>} opts.resolveImage
 */
export async function htmlToMarkdown(html, opts = {}) {
  const {
    resolveImage = async (src) => src,
    skipEmojiImg = true,
    headingOffset = 1,
  } = opts;

  const wrap = parseFragment(html);

  async function walk(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue || "";
      if (!text.trim()) {
        return /[ \t\n\r]/.test(text) ? " " : "";
      }
      return decodeEntities(text.replace(/ /g, " "));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag)) return "";

    const classes = classListOf(el);

    if (classes.includes("meta") && el.closest(".lightbox-wrapper")) return "";

    if (classes.includes("lightbox-wrapper")) {
      const img = el.querySelector("img");
      return img ? await handleImage(img) : await children(el);
    }

    if (tag === "IMG") return handleImage(el);
    if (tag === "BR") return "\n";
    if (tag === "HR") return "\n\n---\n\n";

    if (tag === "STRONG" || tag === "B") {
      const inner = (await inlineChildren(el)).trim();
      return inner ? `**${inner}**` : "";
    }
    if (tag === "EM" || tag === "I") {
      const inner = (await inlineChildren(el)).trim();
      return inner ? `*${inner}*` : "";
    }

    if (tag === "CODE" && el.parentElement?.tagName !== "PRE") {
      return `\`${el.textContent || ""}\``;
    }

    if (tag === "PRE") {
      let code = el.textContent || "";
      let lang = "";
      const codeEl = el.querySelector("code");
      if (codeEl) {
        const cls = classListOf(codeEl).join(" ");
        const m = cls.match(/language-([\w+-]+)/);
        if (m) lang = m[1];
        code = codeEl.textContent || code;
      }
      return `\n\n\`\`\`${lang}\n${code.replace(/\n+$/, "")}\n\`\`\`\n\n`;
    }

    if (/^H[1-6]$/.test(tag)) {
      const level = Math.min(parseInt(tag[1], 10) + headingOffset, 6);
      // 去掉 Discourse 锚点链接，避免标题变成 #p-123-h-4什么是量化?
      const clone = el.cloneNode(true);
      clone
        .querySelectorAll("a.anchor, a[name], svg, .hash-link, .heading-link")
        .forEach((n) => n.remove());
      let inner = (await inlineChildren(clone)).trim();
      inner = cleanHeadingText(inner);
      if (!inner) return "";
      return `\n\n${"#".repeat(level)} ${inner}\n\n`;
    }

    if (tag === "A") {
      if (classes.includes("lightbox")) return children(el);
      // Discourse 标题锚点：无文本或仅 #p-xxx
      if (
        classes.includes("anchor") ||
        classes.includes("hash-link") ||
        classes.includes("heading-link") ||
        el.hasAttribute("name")
      ) {
        const t = (await inlineChildren(el)).trim();
        return t && !/^#?p-\d+/i.test(t) ? t : "";
      }
      const href = (el.getAttribute("href") || "").trim();
      const inner = (await inlineChildren(el)).trim();
      if (!href || href.toLowerCase().startsWith("javascript:")) {
        return inner;
      }
      // 纯页内锚点且无有效文本：跳过
      if (href.startsWith("#") && (!inner || /^#?p-\d+/i.test(inner))) {
        return "";
      }
      return `[${inner || href}](${href})`;
    }

    if (tag === "BLOCKQUOTE" || (tag === "ASIDE" && classes.includes("quote"))) {
      const clone = el.cloneNode(true);
      clone
        .querySelectorAll(".quote-controls, button, .svg-icon, .svg-icon-title")
        .forEach((n) => n.remove());
      const titleEl = clone.querySelector(".title");
      let headerText = "";
      if (titleEl) {
        headerText = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
        titleEl.remove();
      }
      let body = (await walkFragment(clone)).trim();
      const parts = [];
      if (headerText) parts.push(`**${headerText}**`);
      if (body) parts.push(body);
      const quoted = parts.join("\n");
      const lines = quoted.split("\n").map((ln) => (ln.trim() ? `> ${ln}` : ">"));
      return `\n\n${lines.join("\n")}\n\n`;
    }

    if (tag === "UL") {
      const items = [];
      for (const li of el.querySelectorAll(":scope > li")) {
        items.push(`- ${(await children(li)).trim()}`);
      }
      return items.length ? `\n\n${items.join("\n")}\n\n` : "";
    }

    if (tag === "OL") {
      const items = [];
      let i = 1;
      for (const li of el.querySelectorAll(":scope > li")) {
        items.push(`${i}. ${(await children(li)).trim()}`);
        i += 1;
      }
      return items.length ? `\n\n${items.join("\n")}\n\n` : "";
    }

    if (tag === "LI") return (await children(el)).trim();

    if (tag === "DETAILS") {
      const summary = el.querySelector(":scope > summary");
      const summaryText = summary
        ? (await inlineChildren(summary)).trim() || "详情"
        : "详情";
      const clone = el.cloneNode(true);
      const sum = clone.querySelector(":scope > summary");
      if (sum) sum.remove();
      const body = (await walkFragment(clone)).trim();
      const folded = body
        .split("\n")
        .map((ln) => (ln.trim() ? `> ${ln}` : ">"))
        .join("\n");
      return `\n\n> [!note]- ${summaryText}\n${folded}\n\n`;
    }

    if (tag === "SUMMARY") return (await inlineChildren(el)).trim();

    if (tag === "TABLE") return tableToMd(el);

    if (tag === "P") {
      let inner = (await children(el)).trim();
      inner = inner.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
      return inner ? `\n\n${inner}\n\n` : "";
    }

    if (tag === "SPAN") return children(el);

    const inner = await children(el);
    if (BLOCK.has(tag)) {
      const t = inner.trim();
      return t ? `\n\n${t}\n\n` : "";
    }
    return inner;
  }

  async function children(el) {
    let out = "";
    for (const child of el.childNodes) out += await walk(child);
    return out;
  }

  async function inlineChildren(el) {
    let text = await children(el);
    text = text.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ");
    return text;
  }

  async function walkFragment(root) {
    let out = "";
    for (const child of root.childNodes) out += await walk(child);
    return out;
  }

  async function handleImage(img) {
    const classes = classListOf(img);
    const src = (img.getAttribute("src") || "").trim();
    const alt = (img.getAttribute("alt") || img.getAttribute("title") || "").trim();
    const title = (img.getAttribute("title") || "").trim();

    if (classes.includes("avatar") || classes.includes("avatar-img")) return "";

    if (classes.includes("emoji") || (title.startsWith(":") && title.endsWith(":"))) {
      if (skipEmojiImg) return title || alt || "";
    }

    if (!src) return "";

    let fetchSrc = src;
    const parentA = img.closest("a.lightbox");
    if (parentA) {
      const href = parentA.getAttribute("href");
      if (href && !href.startsWith("data:")) fetchSrc = href;
    }

    let finalSrc = src;
    try {
      const resolved = await resolveImage(fetchSrc, img);
      if (resolved === null) return alt ? `[图片: ${alt}]` : "[图片]";
      if (resolved) finalSrc = resolved;
    } catch {
      finalSrc = fetchSrc || src;
    }

    const altEsc = alt.replace(/]/g, "\\]");
    if (title && !title.startsWith(":")) {
      return `![${altEsc}](${finalSrc} "${title}")`;
    }
    return `![${altEsc}](${finalSrc})`;
  }

  async function tableToMd(table) {
    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = [];
      for (const cell of tr.querySelectorAll(":scope > th, :scope > td")) {
        const t = (await children(cell)).trim().replace(/\n/g, " ");
        cells.push(t);
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const norm = rows.map((r) => {
      const x = r.slice();
      while (x.length < width) x.push("");
      return x;
    });
    const lines = [
      `| ${norm[0].join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`,
    ];
    for (let i = 1; i < norm.length; i++) {
      lines.push(`| ${norm[i].join(" | ")} |`);
    }
    return `\n\n${lines.join("\n")}\n\n`;
  }

  let md = await walkFragment(wrap);
  md = md.replace(/[ \t]+\n/g, "\n");
  md = md.replace(/\n[ \t]+/g, "\n");
  md = md.replace(/[ \t]{2,}/g, " ");
  // 二次清理：标题行里残留的 Discourse 锚点
  md = md.replace(/^(#{1,6}\s+)(.*)$/gm, (_, hashes, rest) => {
    const cleaned = cleanHeadingText(rest);
    return cleaned ? `${hashes}${cleaned}` : "";
  });
  md = md.replace(/\n{3,}/g, "\n\n");
  return md.trim();
}

/** 清理 Discourse / 脏标题文本 */
export function cleanHeadingText(text) {
  let t = String(text || "").trim();
  // [#p-18018459-h-4](#p-...) 或裸 #p-18018459-h-4
  t = t.replace(/\[#?p-\d+(?:-h-\d+)?\]\([^)]+\)/gi, "");
  t = t.replace(/^#?p-\d+(?:-h-\d+)?\s*/i, "");
  t = t.replace(/#p-\d+(?:-h-\d+)?/gi, "");
  // 残留的空 markdown 链接
  t = t.replace(/\[\s*\]\([^)]*\)/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

export function yamlEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

export function safeFilename(title, fallback = "topic") {
  let name = String(title || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!name) name = fallback;
  if (name.length > 80) name = name.slice(0, 80).replace(/[. ]+$/g, "");
  return name;
}
