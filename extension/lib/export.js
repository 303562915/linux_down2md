import { htmlToMarkdown, yamlEscape, safeFilename } from "./html2md.js";
import {
  fetchFullTopic,
  fetchRawPost,
  fetchTopicSummary,
  imageUrlToDataUrl,
  imageUrlToBytes,
  parseTopicFromUrl,
} from "./discourse.js";
import {
  buildImageMarkdownSrc,
  ensureDir,
  guessExtFromMime,
  joinRemotePath,
  normalizeRemotePath,
  sha1Short,
  uploadFile,
} from "./webdav.js";

/**
 * @typedef {object} ExportOptions
 * @property {'all'|'op'|'author'|'range'} mode
 *   all=全部楼层, op=仅一楼, author=仅贴主全部回复, range=楼层范围
 * @property {number} [from]
 * @property {number} [to]
 * @property {boolean} includeImages  处理正文图（base64 或 webdav）
 * @property {'base64'|'webdav'|'url'} [imageMode]  默认 base64
 * @property {object} [webdav]  WebDAV 配置（imageMode=webdav 时）
 * @property {boolean} skipEmojiImg   emoji 用 :name:
 * @property {boolean} includeMeta
 * @property {number} [maxImageBytes]
 * @property {number} [postHeadingLevel] 楼层标题级别 1-6，默认 4（####）
 * @property {number} [contentHeadingOffset] 正文标题相对下沉级数，默认 3
 * @property {boolean} [compactPostHeader] 楼层用加粗而非标题（大纲更干净）
 * @property {'html'|'raw'} [contentSource] html=转换 cooked HTML，raw=直取 Discourse 原始 Markdown
 */

const DEFAULT_OPTS = {
  mode: "all",
  includeImages: true,
  imageMode: "url", // url(L站链接) | base64 | webdav
  webdav: null,
  skipEmojiImg: true,
  includeMeta: true,
  maxImageBytes: 8 * 1024 * 1024,
  // Obsidian：楼层 ####，正文 h1→#### / h2→#####，避免大纲被刷屏
  postHeadingLevel: 4,
  contentHeadingOffset: 3,
  compactPostHeader: false,
  contentSource: "html",
};

function isRawSource(value) {
  return value === "raw";
}

/**
 * Raw 模式默认原样保留 Markdown。只有用户选择 Base64/WebDAV 时，才改写图片目标。
 * 按行跳过 fenced code block，避免把示例代码里的图片语法当成真实图片。
 */
async function rewriteRawMarkdownImages(markdown, resolveImage) {
  let inFence = false;
  const lines = String(markdown || "").split(/(\r?\n)/);
  const imageRe = /!\[([^\]]*)\]\((<[^>\n]+>|[^\s)]+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g;

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const matches = [...line.matchAll(imageRe)];
    if (!matches.length) continue;

    let cursor = 0;
    let out = "";
    for (const match of matches) {
      const [full, alt, wrappedSrc, titleSuffix = ""] = match;
      const src = wrappedSrc.startsWith("<") ? wrappedSrc.slice(1, -1) : wrappedSrc;
      const resolved = await resolveImage(src, null);
      out += line.slice(cursor, match.index);
      out += resolved ? `![${alt}](${resolved}${titleSuffix})` : full;
      cursor = match.index + full.length;
    }
    lines[i] = out + line.slice(cursor);
  }
  return lines.join("");
}

function countRawMarkdownImages(markdown) {
  return (String(markdown || "").match(/!\[[^\]]*\]\(/g) || []).length;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawPostCandidates(topic, firstPosts, mode, from, to) {
  const byNumber = new Map(
    (firstPosts || []).map((post) => [Number(post.post_number), post])
  );
  const highest = Math.max(
    Number(topic?.highest_post_number) || 0,
    Number(topic?.posts_count) || 0,
    ...byNumber.keys(),
    1
  );
  const start = mode === "op" ? 1 : mode === "range" ? Math.max(1, Number(from) || 1) : 1;
  const end = mode === "op"
    ? 1
    : mode === "range"
      ? Math.min(highest, Number(to) || highest)
      : highest;
  const posts = [];
  for (let number = start; number <= end; number += 1) {
    posts.push(byNumber.get(number) || { post_number: number });
  }
  return posts;
}

function isNotFoundError(error) {
  return /\b404\b/.test(String(error?.message || error || ""));
}

/** 解析主题贴主 username（优先 details.created_by，回退一楼作者） */
function resolveTopicAuthor(topic, posts) {
  const fromDetails =
    topic?.details?.created_by?.username ||
    topic?.details?.created_by?.name ||
    "";
  if (fromDetails) return String(fromDetails);

  const op = (posts || []).find((p) => p.post_number === 1) || (posts || [])[0];
  return op?.username || op?.name || "";
}

/**
 * 主导出：从当前页 URL 导出 Markdown
 */
export async function exportTopicMarkdown(pageUrl, options = {}, onProgress = () => {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const contentSource = isRawSource(opts.contentSource) ? "raw" : "html";
  const parsed = parseTopicFromUrl(pageUrl);
  if (!parsed) {
    throw new Error("当前页面不是 linux.do 主题帖（URL 需类似 /t/xxx/12345）");
  }

  const { origin, topicId } = parsed;
  const rawWithoutAuthorFilter = contentSource === "raw" && opts.mode !== "author";
  const fetched = rawWithoutAuthorFilter
    ? await fetchTopicSummary(origin, topicId, onProgress)
    : await fetchFullTopic(origin, topicId, onProgress);
  const { topic, posts } = fetched;

  // 过滤楼层
  let selected = rawWithoutAuthorFilter
    ? rawPostCandidates(topic, posts, opts.mode, opts.from, opts.to)
    : posts;
  let authorUsername = "";
  if (!rawWithoutAuthorFilter && opts.mode === "op") {
    selected = posts.filter((p) => p.post_number === 1);
  } else if (!rawWithoutAuthorFilter && opts.mode === "author") {
    authorUsername = resolveTopicAuthor(topic, posts);
    if (!authorUsername) {
      throw new Error("无法识别贴主，请改用「仅一楼」或「全部楼层」");
    }
    const key = authorUsername.toLowerCase();
    selected = posts.filter((p) => {
      const u = (p.username || "").toLowerCase();
      return u && u === key;
    });
    // 极少数匿名/改名情况：至少保留一楼
    if (!selected.length) {
      selected = posts.filter((p) => p.post_number === 1);
    }
  } else if (!rawWithoutAuthorFilter && opts.mode === "range") {
    const from = Number(opts.from) || 1;
    const to = Number(opts.to) || Infinity;
    selected = posts.filter(
      (p) => (p.post_number || 0) >= from && (p.post_number || 0) <= to
    );
  }

  if (!selected.length) {
    throw new Error("没有符合条件的楼层可导出");
  }

  // 图片缓存，避免重复下载
  const imgCache = new Map();
  let imgDone = 0;
  let imgTotal = 0;
  let webdavUploaded = 0;

  const imageMode = opts.includeImages
    ? opts.imageMode || "base64"
    : "url";
  const webdavCfg = opts.webdav || null;

  if (imageMode === "webdav") {
    if (!webdavCfg?.baseUrl || !webdavCfg?.username) {
      throw new Error("已选 WebDAV 传图，请先在设置里填写服务器地址和账号");
    }
    // 预创建图片目录
    const imgDir = normalizeRemotePath(
      webdavCfg.imagePath || joinRemotePath(webdavCfg.rootPath || "/", "attachments")
    );
    onProgress({
      phase: "images",
      done: 0,
      total: 1,
      message: `准备 WebDAV 目录 ${imgDir}…`,
    });
    await ensureDir(webdavCfg, imgDir);
    webdavCfg._resolvedImagePath = imgDir;
  }

  // HTML 模式可在转换前预统计图片。Raw 模式在每层读取后统计。
  if (imageMode !== "url" && contentSource === "html") {
    for (const p of selected) {
      const cooked = p.cooked || "";
      const imgs = cooked.match(/<img\b[^>]*>/gi) || [];
      imgTotal += imgs.length;
    }
  }

  async function resolveImage(src, imgEl) {
    if (!src) return null;

    // 跳过站点 emoji 图，交给 :name: 文本
    if (/\/images\/emoji\//i.test(src) && opts.skipEmojiImg) {
      return null;
    }
    const classes = imgEl?.classList ? [...imgEl.classList] : [];
    if (classes.includes("emoji") && opts.skipEmojiImg) {
      const title = imgEl?.getAttribute?.("title") || "";
      return title || null;
    }

    if (imageMode === "url") {
      if (src.startsWith("data:")) return null;
      if (src.startsWith("//")) return "https:" + src;
      if (src.startsWith("/")) return origin + src;
      return src;
    }

    // base64 模式：已是 data 直接返回
    if (imageMode === "base64" && src.startsWith("data:")) return src;

    const key = `${imageMode}:${src}`;
    if (imgCache.has(key)) return imgCache.get(key);

    onProgress({
      phase: "images",
      done: imgDone,
      total: Math.max(imgTotal, imgDone + 1),
      message:
        imageMode === "webdav"
          ? `上传图片 ${imgDone + 1}…`
          : `下载图片 ${imgDone + 1}…`,
    });

    try {
      let out;
      if (imageMode === "webdav") {
        out = await uploadOneToWebdav(src, webdavCfg, origin, opts.maxImageBytes);
        webdavUploaded += 1;
      } else {
        out = await imageUrlToDataUrl(src, {
          maxBytes: opts.maxImageBytes,
          pageOrigin: origin,
        });
      }
      imgCache.set(key, out);
      imgDone += 1;
      onProgress({
        phase: "images",
        done: imgDone,
        total: Math.max(imgTotal, imgDone),
        message:
          imageMode === "webdav"
            ? `WebDAV ${imgDone}/${Math.max(imgTotal, imgDone)}`
            : `图片 ${imgDone}/${Math.max(imgTotal, imgDone)}`,
      });
      return out;
    } catch (e) {
      imgDone += 1;
      console.warn("[L2MD] image fail", src, e);
      // 失败回退：webdav 失败时尝试 base64；再失败用 URL
      try {
        if (imageMode === "webdav") {
          const dataUrl = await imageUrlToDataUrl(src, {
            maxBytes: opts.maxImageBytes,
            pageOrigin: origin,
          });
          imgCache.set(key, dataUrl);
          return dataUrl;
        }
      } catch {
        /* ignore */
      }
      let fallback = src;
      if (fallback.startsWith("//")) fallback = "https:" + fallback;
      if (fallback.startsWith("/")) fallback = origin + fallback;
      if (fallback.startsWith("data:")) fallback = null;
      imgCache.set(key, fallback);
      return fallback;
    }
  }

  async function uploadOneToWebdav(src, cfg, pageOrigin, maxImageBytes) {
    const { buffer, contentType } = await imageUrlToBytes(src, {
      maxBytes: maxImageBytes,
      pageOrigin,
    });
    const ext = guessExtFromMime(contentType, src);
    const hash = await sha1Short(buffer);
    const filename = `${hash}.${ext}`;
    const dir = cfg._resolvedImagePath ||
      normalizeRemotePath(cfg.imagePath || joinRemotePath(cfg.rootPath || "/", "attachments"));
    const remoteFile = joinRemotePath(dir, filename);
    await uploadFile(cfg, remoteFile, buffer, contentType || "image/png");
    return buildImageMarkdownSrc(cfg, remoteFile, filename);
  }

  onProgress({
    phase: "convert",
    done: 0,
    total: selected.length,
    message: contentSource === "raw" ? "读取原始 Markdown…" : "转换为 Markdown…",
  });

  const postBlocks = [];
  for (let i = 0; i < selected.length; i++) {
    const p = selected[i];
    let contentMd;
    if (contentSource === "raw") {
      try {
        contentMd = await fetchRawPost(origin, topicId, p.post_number, ({ attempt, delayMs }) => {
          onProgress({
            phase: "convert",
            done: i,
            total: selected.length,
            message: `Raw 请求过快，${Math.ceil(delayMs / 1000)} 秒后重试（第 ${attempt} 次）…`,
          });
        });
      } catch (error) {
        // 已删除的楼层没有 /raw 响应；Raw 快速路径无需为此中断整个主题导出。
        if (rawWithoutAuthorFilter && isNotFoundError(error)) {
          onProgress({
            phase: "convert",
            done: i + 1,
            total: selected.length,
            message: `跳过不可读取的楼层 ${p.post_number}`,
          });
          continue;
        }
        throw error;
      }
      if (imageMode !== "url") {
        imgTotal += countRawMarkdownImages(contentMd);
        contentMd = await rewriteRawMarkdownImages(contentMd, resolveImage);
      }
      contentMd = contentMd.trim();
    } else {
      contentMd = await htmlToMarkdown(p.cooked || "", {
        resolveImage,
        skipEmojiImg: opts.skipEmojiImg,
        headingOffset: Number(opts.contentHeadingOffset) || 3,
      });
    }

    postBlocks.push({
      number: p.post_number,
      // 快速 Raw 路径不请求全部帖子索引，避免二次拉取 cooked HTML。
      author: rawWithoutAuthorFilter ? "" : p.name || p.username || "匿名",
      username: rawWithoutAuthorFilter ? "" : p.username || "",
      authorUrl:
        !rawWithoutAuthorFilter && p.username ? `${origin}/u/${p.username}` : "",
      createdAt: rawWithoutAuthorFilter ? "" : formatDiscourseDate(p.created_at),
      replyTo: !rawWithoutAuthorFilter && p.reply_to_user
        ? `回复 @${p.reply_to_user.username || p.reply_to_user}`
        : "",
      contentMd,
    });

    onProgress({
      phase: "convert",
      done: i + 1,
      total: selected.length,
      message:
        contentSource === "raw"
          ? `读取原文 ${i + 1}/${selected.length}`
          : `转换楼层 ${i + 1}/${selected.length}`,
    });

    // Raw 是一层一请求；控制到约 1 req/s，避免 Cloudflare 在大主题中途限流。
    if (contentSource === "raw" && i + 1 < selected.length) await wait(1_100);
  }

  if (!postBlocks.length) {
    throw new Error("没有可读取的 Raw 楼层");
  }

  const md = buildMarkdown({
    topic,
    origin,
    topicId,
    posts: postBlocks,
    includeMeta: opts.includeMeta,
    mode: opts.mode,
    authorUsername,
    postHeadingLevel: opts.postHeadingLevel,
    compactPostHeader: opts.compactPostHeader,
    contentSource,
  });

  const title = topic.title || `topic-${topicId}`;
  let suffix = "";
  if (opts.mode === "op") suffix = "-一楼";
  else if (opts.mode === "author") suffix = "-贴主";
  else if (opts.mode === "range") {
    const from = Number(opts.from) || 1;
    const to = Number(opts.to) || selected[selected.length - 1]?.post_number || "";
    suffix = `-${from}-${to}`;
  }
  const filename = `${topicId}-${safeFilename(title)}${suffix}.md`;

  onProgress({ phase: "done", done: 1, total: 1, message: "完成" });

  return {
    markdown: md,
    filename,
    title,
    topicId,
    postCount: postBlocks.length,
    imageCount: imgCache.size,
    imageMode,
    webdavUploaded,
    mode: opts.mode,
    authorUsername,
    contentSource,
  };
}

function formatDiscourseDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")} ${hh}:${mm}`;
  } catch {
    return String(iso);
  }
}

function buildMarkdown({
  topic,
  origin,
  topicId,
  posts,
  includeMeta,
  mode = "all",
  authorUsername = "",
  postHeadingLevel = 4,
  compactPostHeader = false,
  contentSource = "html",
}) {
  const title = topic.title || `Topic ${topicId}`;
  const url = `${origin}/t/topic/${topicId}`;
  const category =
    topic.category_name ||
    (topic.category_id != null ? String(topic.category_id) : "");
  const tags = Array.isArray(topic.tags) ? topic.tags : [];

  const modeLabel =
    mode === "op"
      ? "仅一楼"
      : mode === "author"
        ? `仅贴主${authorUsername ? ` @${authorUsername}` : ""}`
        : mode === "range"
          ? "楼层范围"
          : "全部楼层";

  const level = Math.min(6, Math.max(1, Number(postHeadingLevel) || 4));
  const hashes = "#".repeat(level);

  const fm = ["---", `title: "${yamlEscape(title)}"`];
  fm.push(`source: ${url}`);
  fm.push(`topic_id: ${topicId}`);
  if (category) fm.push(`category: "${yamlEscape(category)}"`);
  if (tags.length) {
    fm.push("tags:");
    for (const t of tags) fm.push(`  - "${yamlEscape(t)}"`);
  }
  fm.push(`export_mode: "${yamlEscape(mode)}"`);
  fm.push(`content_source: "${yamlEscape(contentSource)}"`);
  if (authorUsername) fm.push(`author: "${yamlEscape(authorUsername)}"`);
  fm.push("site: linux.do");
  fm.push(`exported: "${yamlEscape(new Date().toISOString())}"`);
  fm.push("---", "");

  const lines = [...fm];
  lines.push(`# ${title}`, "");

  if (includeMeta) {
    const bits = [];
    if (category) bits.push(`**分类**: ${category}`);
    if (tags.length) bits.push("**标签**: " + tags.map((t) => `\`${t}\``).join(" · "));
    bits.push(`**原帖**: [${url}](${url})`);
    bits.push(`**Topic ID**: ${topicId}`);
    bits.push(`**导出范围**: ${modeLabel}`);
    bits.push(`**正文来源**: ${contentSource === "raw" ? "Raw Markdown" : "HTML 转换"}`);
    bits.push(`**导出楼层**: ${posts.length}`);
    lines.push(bits.join("  \n"), "", "---", "");
  }

  for (const p of posts) {
    // 不要写成 #### #1，否则 Obsidian 会显示多余的 #；楼层号用纯数字
    const label = `${p.number} ${p.author}${p.createdAt ? ` · ${p.createdAt}` : ""}`.trim();
    // Obsidian：默认 #### 楼层；紧凑模式用加粗，不占大纲
    if (compactPostHeader) {
      lines.push(`**${label}**`, "");
    } else {
      lines.push(`${hashes} ${label}`, "");
    }
    if (p.authorUrl) {
      lines.push(`*作者*: [${p.author}](${p.authorUrl})`, "");
    }
    if (p.replyTo) {
      lines.push(`> ${p.replyTo}`, "");
    }
    if (p.contentMd) {
      lines.push(p.contentMd, "");
    }
    lines.push("---", "");
  }

  lines.push(`*Exported from linux.do on ${new Date().toLocaleString()}*`, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export { parseTopicFromUrl, safeFilename };
