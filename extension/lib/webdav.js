/**
 * WebDAV 客户端（坚果云 / Nextcloud / 通用）
 * 通过 background 代理请求，避免 CORS
 */

export function normalizeBaseUrl(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

export function normalizeRemotePath(path) {
  let p = String(path || "/").trim() || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

export function joinRemotePath(...parts) {
  const segs = [];
  for (const part of parts) {
    String(part || "")
      .split("/")
      .filter(Boolean)
      .forEach((s) => segs.push(s));
  }
  return "/" + segs.join("/");
}

/** 编码路径；dirSlash=true 时目录强制带尾部 /（PROPFIND 需要） */
export function encodePath(path, { dirSlash = false } = {}) {
  const norm = normalizeRemotePath(path);
  if (norm === "/") return "/";
  const encoded = norm
    .split("/")
    .map((seg) => (seg ? encodeURIComponent(seg) : ""))
    .join("/");
  return dirSlash ? encoded + "/" : encoded;
}

export function authHeader(username, password) {
  // 支持中文用户名
  const raw = `${username}:${password || ""}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return `Basic ${btoa(binary)}`;
}

function canUseBackground() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function davRequest(
  cfg,
  { method, path, headers = {}, body, bodyBase64, contentType, dirSlash = false }
) {
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) throw new Error("请填写 WebDAV 服务器地址");
  if (!cfg.username) throw new Error("请填写 WebDAV 用户名");

  const remotePath = encodePath(path || "/", { dirSlash });
  const url = base + remotePath;

  const reqHeaders = {
    Authorization: authHeader(cfg.username, cfg.password || ""),
    ...headers,
  };
  if (contentType) reqHeaders["Content-Type"] = contentType;

  if (canUseBackground()) {
    const res = await chrome.runtime.sendMessage({
      type: "WEBDAV_REQUEST",
      url,
      method: method || "GET",
      headers: reqHeaders,
      bodyBase64: bodyBase64 || null,
      bodyText: typeof body === "string" ? body : null,
    });
    if (!res?.ok) throw new Error(res?.error || "WebDAV 请求失败");
    return { ...res.data, url };
  }

  const init = { method: method || "GET", headers: reqHeaders };
  if (bodyBase64) {
    const bin = atob(bodyBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    init.body = bytes;
  } else if (body != null) {
    init.body = body;
  }
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  return {
    status: res.status,
    ok: res.ok || res.status === 201 || res.status === 204 || res.status === 207,
    text,
    contentType: res.headers.get("content-type") || "",
    url,
  };
}

/** 测试连接 */
export async function testConnection(cfg) {
  const path = normalizeRemotePath(cfg.rootPath || "/");
  const res = await davRequest(cfg, {
    method: "PROPFIND",
    path,
    dirSlash: true,
    headers: { Depth: "0" },
    body: `<?xml version="1.0" encoding="utf-8" ?>
<propfind xmlns="DAV:">
  <prop><resourcetype/><displayname/></prop>
</propfind>`,
    contentType: "application/xml; charset=utf-8",
  });
  if (!(res.ok || res.status === 207)) {
    throw new Error(
      `连接失败 HTTP ${res.status}${res.text ? ": " + res.text.slice(0, 160) : ""}`
    );
  }
  return true;
}

/**
 * 列出目录下的子文件夹（坚果云兼容）
 * @returns {Promise<{name:string, path:string}[]>}
 */
export async function listDirectories(cfg, path = "/") {
  const dir = normalizeRemotePath(path);

  // 坚果云：目录 PROPFIND 建议 URL 带尾部 /
  let res = await davRequest(cfg, {
    method: "PROPFIND",
    path: dir,
    dirSlash: true,
    headers: { Depth: "1" },
    body: `<?xml version="1.0" encoding="utf-8" ?>
<propfind xmlns="DAV:">
  <prop>
    <resourcetype/>
    <displayname/>
    <getcontenttype/>
    <getcontentlength/>
  </prop>
</propfind>`,
    contentType: "application/xml; charset=utf-8",
  });

  // 部分服务不接受 propfind 体，改 allprop
  if (!(res.ok || res.status === 207)) {
    res = await davRequest(cfg, {
      method: "PROPFIND",
      path: dir,
      dirSlash: true,
      headers: { Depth: "1" },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<propfind xmlns="DAV:"><allprop/></propfind>`,
      contentType: "application/xml; charset=utf-8",
    });
  }

  if (!(res.ok || res.status === 207)) {
    const hint = (res.text || "").replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`列出目录失败 HTTP ${res.status}${hint ? " · " + hint : ""}`);
  }

  const xml = res.text || "";
  let dirs = parsePropfindDirectories(xml, dir, normalizeBaseUrl(cfg.baseUrl));

  // 再兜底：纯正则扫 href
  if (!dirs.length) {
    dirs = parseDirectoriesByHrefRegex(xml, dir, normalizeBaseUrl(cfg.baseUrl));
  }

  return dirs;
}

function localName(el) {
  if (!el) return "";
  return (el.localName || el.nodeName || "").replace(/^.*:/, "").toLowerCase();
}

function findChildByLocal(parent, name) {
  if (!parent?.children) return null;
  const want = name.toLowerCase();
  for (const c of parent.children) {
    if (localName(c) === want) return c;
  }
  return null;
}

function findDescByLocal(root, name) {
  if (!root) return null;
  const want = name.toLowerCase();
  const all = root.getElementsByTagName("*");
  for (const el of all) {
    if (localName(el) === want) return el;
  }
  return null;
}

function hasCollection(respEl) {
  // <resourcetype><collection/></resourcetype>
  const rt = findDescByLocal(respEl, "resourcetype");
  if (!rt) return false;
  if (findDescByLocal(rt, "collection")) return true;
  // 有的实现把 collection 写成属性/空标签文本
  const t = (rt.textContent || "").toLowerCase();
  return t.includes("collection");
}

function hrefToRemotePath(href, baseUrl) {
  let raw = String(href || "").trim();
  if (!raw) return null;

  // 去掉查询串
  raw = raw.split("?")[0];

  let path;
  try {
    if (/^https?:\/\//i.test(raw)) {
      path = decodeURIComponent(new URL(raw).pathname);
    } else {
      path = decodeURIComponent(raw);
    }
  } catch {
    try {
      path = decodeURIComponent(raw);
    } catch {
      path = raw;
    }
  }

  // 去掉 baseUrl 的 pathname 前缀，如 /dav
  try {
    const base = new URL(baseUrl);
    let basePath = base.pathname || "";
    if (basePath.length > 1 && basePath.endsWith("/")) {
      basePath = basePath.slice(0, -1);
    }
    if (basePath && basePath !== "/" && path.startsWith(basePath + "/")) {
      path = path.slice(basePath.length) || "/";
    } else if (basePath && basePath !== "/" && path === basePath) {
      path = "/";
    }
  } catch {
    /* ignore */
  }

  // 再兜底去掉常见前缀 /dav
  if (path === "/dav" || path.startsWith("/dav/")) {
    path = path.slice(4) || "/";
  }

  return normalizeRemotePath(path);
}

function isImmediateChild(parentPath, childPath) {
  const p = normalizeRemotePath(parentPath);
  const c = normalizeRemotePath(childPath);
  if (c === p) return false;
  if (p === "/") {
    // 一级：/foo
    return c.split("/").filter(Boolean).length === 1;
  }
  if (!c.startsWith(p + "/")) return false;
  const rest = c.slice(p.length + 1);
  // 只要直接子级，不要孙子
  return rest.length > 0 && !rest.includes("/");
}

function parsePropfindDirectories(xmlText, currentPath, baseUrl) {
  if (!xmlText || !xmlText.trim()) return [];

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  // 解析错误时走正则
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) {
    return parseDirectoriesByHrefRegex(xmlText, currentPath, baseUrl);
  }

  const responses = [];
  for (const el of doc.getElementsByTagName("*")) {
    if (localName(el) === "response") responses.push(el);
  }

  const seen = new Set();
  const dirs = [];
  const cur = normalizeRemotePath(currentPath);

  for (const resp of responses) {
    let href = "";
    const hrefEl = findDescByLocal(resp, "href");
    if (hrefEl) href = (hrefEl.textContent || "").trim();
    if (!href) continue;

    const path = hrefToRemotePath(href, baseUrl);
    if (!path) continue;

    // 目录判定：collection 或 href 以 / 结尾
    const hrefLooksDir = /\/$/.test(href.split("?")[0]);
    const collection = hasCollection(resp);
    // 内容类型
    const ctypeEl = findDescByLocal(resp, "getcontenttype");
    const ctype = (ctypeEl?.textContent || "").toLowerCase();
    const isDirType =
      ctype.includes("directory") || ctype.includes("folder") || ctype === "httpd/unix-directory";

    // 有 contentlength 且非 0、且不像目录 → 文件
    const lenEl = findDescByLocal(resp, "getcontentlength");
    const len = lenEl ? parseInt((lenEl.textContent || "").trim(), 10) : NaN;

    let isDir = collection || hrefLooksDir || isDirType;
    // 若完全看不出，且路径没有文件扩展名，当作目录候选（仅直接子级）
    if (!isDir && !Number.isFinite(len)) {
      const last = path.split("/").filter(Boolean).pop() || "";
      if (last && !/\.[a-z0-9]{1,6}$/i.test(last)) {
        // 保守：不自动当目录，避免把文件当文件夹
      }
    }

    if (!isDir) continue;
    if (path === cur) continue;
    if (!isImmediateChild(cur, path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);

    const nameEl = findDescByLocal(resp, "displayname");
    let name = (nameEl?.textContent || "").trim();
    if (!name) name = path.split("/").filter(Boolean).pop() || path;
    // 去掉 displayname 里的路径噪声
    name = name.replace(/\/+$/, "").split("/").pop() || name;

    dirs.push({ name, path });
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return dirs;
}

/** 正则兜底：从 multistatus 抽所有 href，尾部 / 的视为目录 */
function parseDirectoriesByHrefRegex(xmlText, currentPath, baseUrl) {
  const cur = normalizeRemotePath(currentPath);
  const seen = new Set();
  const dirs = [];
  const re = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    const href = m[1].trim();
    const path = hrefToRemotePath(href, baseUrl);
    if (!path || path === cur) continue;
    const looksDir = /\/\s*$/.test(href) || /\/$/.test(href.split("?")[0]);
    if (!looksDir) continue;
    if (!isImmediateChild(cur, path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const name = path.split("/").filter(Boolean).pop() || path;
    dirs.push({ name, path });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return dirs;
}

/** 递归创建目录（已存在则忽略） */
export async function ensureDir(cfg, path) {
  const full = normalizeRemotePath(path);
  if (full === "/") return;

  const parts = full.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    const res = await davRequest(cfg, {
      method: "MKCOL",
      path: cur,
      dirSlash: true,
    });
    if (
      res.status === 201 ||
      res.status === 405 ||
      res.status === 409 ||
      res.status === 301 ||
      res.status === 200 ||
      res.status === 403 ||
      res.ok
    ) {
      continue;
    }
    throw new Error(`创建目录失败 ${cur} HTTP ${res.status}`);
  }
}

/**
 * 上传二进制文件
 */
export async function uploadFile(cfg, remotePath, data, contentType = "application/octet-stream") {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);

  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const bodyBase64 = btoa(binary);

  const parent = normalizeRemotePath(remotePath.split("/").slice(0, -1).join("/") || "/");
  await ensureDir(cfg, parent);

  const res = await davRequest(cfg, {
    method: "PUT",
    path: remotePath,
    dirSlash: false,
    bodyBase64,
    contentType,
  });

  if (!(res.ok || res.status === 201 || res.status === 204 || res.status === 200)) {
    throw new Error(`上传失败 HTTP ${res.status}: ${remotePath}`);
  }
  return true;
}

/** 上传 UTF-8 文本（如 .md 笔记） */
export async function uploadTextFile(
  cfg,
  remotePath,
  text,
  contentType = "text/markdown; charset=utf-8"
) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  return uploadFile(cfg, remotePath, bytes, contentType);
}

export function buildImageMarkdownSrc(cfg, remoteFilePath, filename) {
  const linkStyle = cfg.linkStyle || "relative";
  const path = normalizeRemotePath(remoteFilePath);

  if (linkStyle === "absolute") {
    return normalizeBaseUrl(cfg.baseUrl) + encodePath(path);
  }

  if (linkStyle === "public" && cfg.publicBaseUrl) {
    const pub = normalizeBaseUrl(cfg.publicBaseUrl);
    const root = normalizeRemotePath(cfg.rootPath || "/");
    let rel = path;
    if (root !== "/" && path.startsWith(root)) {
      rel = path.slice(root.length) || "/";
    }
    return pub + encodePath(rel);
  }

  if (cfg.noteRelativePrefix) {
    const prefix = String(cfg.noteRelativePrefix).replace(/\\/g, "/").replace(/\/+$/, "");
    return `${prefix}/${filename}`.replace(/\/{2,}/g, "/");
  }

  const folder = path.split("/").filter(Boolean);
  folder.pop();
  const lastFolder = folder[folder.length - 1] || "attachments";
  return `${lastFolder}/${filename}`;
}

export function guessExtFromMime(mime, fallbackUrl = "") {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("svg")) return "svg";
  const u = fallbackUrl.toLowerCase().split("?")[0];
  const m2 = u.match(/\.([a-z0-9]{2,5})$/);
  return m2 ? m2[1] : "png";
}

export async function sha1Short(buffer) {
  const data = buffer instanceof ArrayBuffer ? buffer : buffer.buffer || buffer;
  if (crypto?.subtle) {
    const hash = await crypto.subtle.digest("SHA-1", data);
    const arr = [...new Uint8Array(hash)];
    return arr.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  }
  const bytes = new Uint8Array(data);
  let h = bytes.length;
  for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 32))) {
    h = (h * 33 + bytes[i]) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
