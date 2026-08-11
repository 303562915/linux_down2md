/**
 * Service Worker：侧边栏 + 下载 + 跨域网络代理
 */

// 点击扩展图标 → 打开侧边栏（不要设置 default_popup）
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("[L2MD] setPanelBehavior", e));
} catch (e) {
  console.warn("[L2MD] sidePanel API unavailable", e);
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[L2MD] installed");
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.sidePanel.setOptions({
      path: "sidepanel.html",
      enabled: true,
    });
  } catch (e) {
    console.warn("[L2MD] sidePanel setup", e);
  }
});

// 兼容：部分环境仍发 action 点击
chrome.action?.onClicked?.addListener(async (tab) => {
  try {
    if (tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    console.warn("[L2MD] open sidePanel", e);
  }
});

function sanitizeDownloadName(name) {
  return String(name || "topic.md")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.+$/g, "");
}

/**
 * 规范化 vault 子路径（相对浏览器「下载」目录）
 * 例：Obsidian/LinuxDo → Obsidian/LinuxDo
 */
function sanitizeVaultSubpath(raw) {
  let p = String(raw || "").trim();
  if (!p) return "";
  p = p.replace(/^[a-zA-Z]:[\\/]/, "");
  p = p.replace(/^~[\\/]?/, "");
  p = p.replace(/\\/g, "/");
  p = p.replace(/^\/+/, "");
  return p
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => seg.replace(/[<>:"|?*\x00-\x1f]/g, "_"))
    .join("/");
}

function joinDownloadPath(vaultPath, filename) {
  const file = sanitizeDownloadName(filename);
  const sub = sanitizeVaultSubpath(vaultPath);
  return sub ? `${sub}/${file}` : file;
}

function arrayBufferToDataUrl(buf, ctype) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${ctype};base64,${btoa(binary)}`;
}

function guessMime(url) {
  const u = String(url).toLowerCase().split("?")[0];
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".gif")) return "image/gif";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".svg")) return "image/svg+xml";
  return null;
}

const FORUM_REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url, init = {}, timeoutMs = FORUM_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒）: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function downloadMarkdown(filename, content, { vaultPath = "", saveAs = false } = {}) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const url = `data:text/markdown;charset=utf-8;base64,${b64}`;
  const fullPath = joinDownloadPath(vaultPath, filename);

  return chrome.downloads.download({
    url,
    filename: fullPath,
    saveAs: !!saveAs,
    conflictAction: "uniquify",
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === "DOWNLOAD_MARKDOWN") {
    (async () => {
      try {
        if (!msg.content) throw new Error("空内容");
        // 未显式传 vault 时，读 storage
        let vaultPath = msg.vaultPath;
        let saveAs = msg.saveAs;
        if (vaultPath == null || saveAs == null) {
          const st = await chrome.storage.sync.get({
            vaultPath: "",
            askSaveAs: false,
          });
          if (vaultPath == null) vaultPath = st.vaultPath || "";
          if (saveAs == null) saveAs = !!st.askSaveAs;
        }
        const id = await downloadMarkdown(msg.filename, msg.content, {
          vaultPath,
          saveAs,
        });
        sendResponse({
          ok: true,
          downloadId: id,
          path: joinDownloadPath(vaultPath, msg.filename),
        });
      } catch (e) {
        console.error("[L2MD] download failed", e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "EXT_FETCH_JSON") {
    (async () => {
      try {
        const res = await fetchWithTimeout(msg.url, {
          credentials: "include",
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${msg.url}\n${text.slice(0, 200)}`);
        }
        const data = await res.json();
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "EXT_FETCH_TEXT") {
    (async () => {
      try {
        const res = await fetchWithTimeout(msg.url, {
          credentials: "include",
          headers: { Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8" },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${msg.url}\n${body.slice(0, 200)}`);
        }
        sendResponse({ ok: true, data: await res.text() });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "EXT_LOOKUP_UPLOAD_URLS") {
    (async () => {
      try {
        const base = String(msg.origin || "").replace(/\/$/, "");
        const shortUrls = Array.isArray(msg.shortUrls) ? msg.shortUrls.filter(Boolean) : [];
        const body = new URLSearchParams();
        for (const shortUrl of shortUrls) body.append("short_urls[]", shortUrl);
        const res = await fetchWithTimeout(`${base}/uploads/lookup-urls`, {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${base}/uploads/lookup-urls\n${text.slice(0, 200)}`);
        }
        sendResponse({ ok: true, data: await res.json() });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "EXT_FETCH_DATA_URL") {
    (async () => {
      try {
        let url = msg.url;
        if (url.startsWith("//")) url = "https:" + url;
        const res = await fetch(url, {
          credentials: "include",
          referrer: msg.referrer || "https://linux.do/",
        });
        if (!res.ok) throw new Error(`图片 HTTP ${res.status}: ${url}`);
        const buf = await res.arrayBuffer();
        const maxBytes = msg.maxBytes || 8 * 1024 * 1024;
        if (buf.byteLength > maxBytes) {
          throw new Error(
            `图片过大 (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB)`
          );
        }
        const ctype =
          res.headers.get("content-type")?.split(";")[0]?.trim() ||
          guessMime(url) ||
          "image/png";
        const dataUrl = arrayBufferToDataUrl(buf, ctype);
        sendResponse({ ok: true, data: dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "EXT_FETCH_BYTES") {
    (async () => {
      try {
        let url = msg.url;
        if (url.startsWith("//")) url = "https:" + url;
        const res = await fetch(url, {
          credentials: "include",
          referrer: msg.referrer || "https://linux.do/",
        });
        if (!res.ok) throw new Error(`图片 HTTP ${res.status}: ${url}`);
        const buf = await res.arrayBuffer();
        const maxBytes = msg.maxBytes || 8 * 1024 * 1024;
        if (buf.byteLength > maxBytes) {
          throw new Error(
            `图片过大 (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB)`
          );
        }
        const ctype =
          res.headers.get("content-type")?.split(";")[0]?.trim() ||
          guessMime(url) ||
          "image/png";
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        sendResponse({
          ok: true,
          data: { base64: btoa(binary), contentType: ctype },
        });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "WEBDAV_REQUEST") {
    (async () => {
      try {
        const init = {
          method: msg.method || "GET",
          headers: msg.headers || {},
        };
        if (msg.bodyBase64) {
          const bin = atob(msg.bodyBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          init.body = bytes;
        } else if (msg.bodyText != null) {
          init.body = msg.bodyText;
        }

        const res = await fetch(msg.url, init);
        const status = res.status;
        const ok =
          res.ok || status === 201 || status === 204 || status === 207 || status === 405;
        const contentType = res.headers.get("content-type") || "";
        let text = "";
        // PROPFIND 需要 XML 文本；PUT 通常无体
        if (status !== 204) {
          try {
            text = await res.text();
          } catch {
            text = "";
          }
        }
        sendResponse({
          ok: true,
          data: { status, ok, text, contentType },
        });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "ENSURE_WEBDAV_HOST") {
    (async () => {
      try {
        const origin = msg.origin;
        if (!origin) throw new Error("缺少 origin");
        // MV3 optional_host_permissions
        const pattern = origin.endsWith("/") ? origin + "*" : origin + "/*";
        const has = await chrome.permissions.contains({ origins: [pattern] });
        if (has) {
          sendResponse({ ok: true, granted: true });
          return;
        }
        const granted = await chrome.permissions.request({ origins: [pattern] });
        sendResponse({ ok: true, granted: !!granted });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }
});
