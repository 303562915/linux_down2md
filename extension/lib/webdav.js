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

export function encodePath(path) {
  return normalizeRemotePath(path)
    .split("/")
    .map((seg) => (seg ? encodeURIComponent(seg) : ""))
    .join("/");
}

export function authHeader(username, password) {
  const token = btoa(unescape(encodeURIComponent(`${username}:${password}`)));
  return `Basic ${token}`;
}

function canUseBackground() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function davRequest(cfg, { method, path, headers = {}, body, bodyBase64, contentType }) {
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) throw new Error("请填写 WebDAV 服务器地址");
  if (!cfg.username) throw new Error("请填写 WebDAV 用户名");

  const remotePath = encodePath(path || "/");
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
      returnType: "meta", // status + text/base64
    });
    if (!res?.ok) throw new Error(res?.error || "WebDAV 请求失败");
    return res.data;
  }

  // 降级：直接 fetch（popup 同源策略下通常仍会失败，仅调试用）
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
  };
}

/** 测试连接：PROPFIND 根或指定目录 */
export async function testConnection(cfg) {
  const path = normalizeRemotePath(cfg.rootPath || "/");
  const res = await davRequest(cfg, {
    method: "PROPFIND",
    path,
    headers: { Depth: "0" },
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`,
    contentType: "application/xml; charset=utf-8",
  });
  if (!(res.ok || res.status === 207)) {
    throw new Error(`连接失败 HTTP ${res.status}${res.text ? ": " + res.text.slice(0, 120) : ""}`);
  }
  return true;
}

/**
 * 列出目录下的子文件夹
 * @returns {Promise<{name:string, path:string}[]>}
 */
export async function listDirectories(cfg, path = "/") {
  const dir = normalizeRemotePath(path);
  const res = await davRequest(cfg, {
    method: "PROPFIND",
    path: dir,
    headers: { Depth: "1" },
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`,
    contentType: "application/xml; charset=utf-8",
  });

  if (!(res.ok || res.status === 207)) {
    throw new Error(`列出目录失败 HTTP ${res.status}`);
  }

  return parsePropfindDirectories(res.text || "", dir, normalizeBaseUrl(cfg.baseUrl));
}

function parsePropfindDirectories(xmlText, currentPath, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const responses = [
    ...doc.getElementsByTagNameNS("DAV:", "response"),
    ...doc.getElementsByTagName("d:response"),
    ...doc.getElementsByTagName("D:response"),
    ...doc.getElementsByTagName("response"),
  ];

  // 去重
  const seen = new Set();
  const dirs = [];

  for (const resp of responses) {
    const hrefEl =
      resp.getElementsByTagNameNS("DAV:", "href")[0] ||
      resp.getElementsByTagName("d:href")[0] ||
      resp.getElementsByTagName("D:href")[0] ||
      resp.getElementsByTagName("href")[0];
    if (!hrefEl) continue;

    let href = (hrefEl.textContent || "").trim();
    if (!href) continue;

    // href 可能是绝对 URL 或 /dav/xxx
    let path;
    try {
      if (/^https?:\/\//i.test(href)) {
        const u = new URL(href);
        const base = new URL(baseUrl);
        path = decodeURIComponent(u.pathname);
        // 去掉 base path 前缀（如 /dav）
        if (base.pathname && base.pathname !== "/" && path.startsWith(base.pathname)) {
          path = path.slice(base.pathname.length) || "/";
        }
      } else {
        path = decodeURIComponent(href);
        try {
          const base = new URL(baseUrl);
          if (base.pathname && base.pathname !== "/" && path.startsWith(base.pathname)) {
            path = path.slice(base.pathname.length) || "/";
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      path = decodeURIComponent(href);
    }

    path = normalizeRemotePath(path);

    const isCollection =
      resp.getElementsByTagNameNS("DAV:", "collection").length > 0 ||
      resp.getElementsByTagName("d:collection").length > 0 ||
      resp.getElementsByTagName("D:collection").length > 0 ||
      resp.getElementsByTagName("collection").length > 0;

    if (!isCollection) continue;
    if (path === normalizeRemotePath(currentPath)) continue; // 自身
    if (seen.has(path)) continue;
    seen.add(path);

    const name =
      path.split("/").filter(Boolean).pop() || path;
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
    });
    // 201 created, 405/409 already exists — 都可接受
    if (
      res.status === 201 ||
      res.status === 405 ||
      res.status === 409 ||
      res.status === 301 ||
      res.status === 200 ||
      res.ok
    ) {
      continue;
    }
    // 有的服务器对已存在返回 403/405
    if (res.status === 403) continue;
    throw new Error(`创建目录失败 ${cur} HTTP ${res.status}`);
  }
}

/**
 * 上传二进制文件
 * @param {object} cfg
 * @param {string} remotePath 完整远程路径含文件名
 * @param {ArrayBuffer|Uint8Array} data
 * @param {string} contentType
 */
export async function uploadFile(cfg, remotePath, data, contentType = "application/octet-stream") {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);

  // base64
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const bodyBase64 = btoa(binary);

  // 确保父目录
  const parent = normalizeRemotePath(remotePath.split("/").slice(0, -1).join("/") || "/");
  await ensureDir(cfg, parent);

  const res = await davRequest(cfg, {
    method: "PUT",
    path: remotePath,
    bodyBase64,
    contentType,
  });

  if (!(res.ok || res.status === 201 || res.status === 204 || res.status === 200)) {
    throw new Error(`上传失败 HTTP ${res.status}: ${remotePath}`);
  }
  return true;
}

/**
 * 生成 Markdown 中使用的图片链接
 */
export function buildImageMarkdownSrc(cfg, remoteFilePath, filename) {
  const linkStyle = cfg.linkStyle || "relative"; // relative | absolute | public
  const path = normalizeRemotePath(remoteFilePath);

  if (linkStyle === "absolute") {
    return normalizeBaseUrl(cfg.baseUrl) + encodePath(path);
  }

  if (linkStyle === "public" && cfg.publicBaseUrl) {
    const pub = normalizeBaseUrl(cfg.publicBaseUrl);
    // publicBaseUrl 对应 rootPath 的公开映射
    const root = normalizeRemotePath(cfg.rootPath || "/");
    let rel = path;
    if (root !== "/" && path.startsWith(root)) {
      rel = path.slice(root.length) || "/";
    }
    return pub + encodePath(rel);
  }

  // relative：相对笔记的路径（推荐 Obsidian + 同步盘）
  // 若配置了 noteRelativePrefix 则用它，否则用文件名所在目录名/文件名
  if (cfg.noteRelativePrefix) {
    const prefix = String(cfg.noteRelativePrefix).replace(/\\/g, "/").replace(/\/+$/, "");
    return `${prefix}/${filename}`.replace(/\/{2,}/g, "/");
  }

  // 默认：attachments/xxx.png 或 用户文件夹名/xxx.png
  const folder = path.split("/").filter(Boolean);
  folder.pop(); // remove filename
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
  const data =
    buffer instanceof ArrayBuffer ? buffer : buffer.buffer || buffer;
  if (crypto?.subtle) {
    const hash = await crypto.subtle.digest("SHA-1", data);
    const arr = [...new Uint8Array(hash)];
    return arr.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  }
  // 降级：长度+抽样
  const bytes = new Uint8Array(data);
  let h = bytes.length;
  for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 32))) {
    h = (h * 33 + bytes[i]) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
