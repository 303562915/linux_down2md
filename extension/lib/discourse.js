/**
 * Discourse (linux.do) 主题拉取
 * 网络请求优先走扩展后台，避免 content script 的 CORS 限制
 */

export function parseTopicFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    const m = u.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)(?:\/(\d+))?/);
    if (!m) return null;
    return {
      topicId: m[1],
      postNumber: m[2] ? parseInt(m[2], 10) : null,
      origin: u.origin,
    };
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function canUseBackground() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id && !!chrome.runtime.sendMessage;
  } catch {
    return false;
  }
}

async function bgRequest(payload) {
  const res = await chrome.runtime.sendMessage(payload);
  if (!res?.ok) throw new Error(res?.error || "后台请求失败");
  return res.data;
}

async function fetchJson(url) {
  if (canUseBackground()) {
    try {
      return await bgRequest({ type: "EXT_FETCH_JSON", url });
    } catch (e) {
      // popup 里有时也可直接 fetch；后台失败再降级
      console.warn("[L2MD] bg json fail, fallback", e);
    }
  }
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`请求失败 ${res.status}: ${url}\n${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 拉取主题元数据 + 全部楼层
 */
export async function fetchFullTopic(origin, topicId, onProgress = () => {}) {
  const base = origin.replace(/\/$/, "");
  onProgress({ phase: "meta", done: 0, total: 1, message: "读取主题信息…" });

  const topic = await fetchJson(`${base}/t/${topicId}.json`);
  const stream = topic.post_stream?.stream || [];
  const firstPosts = topic.post_stream?.posts || [];
  const byId = new Map(firstPosts.map((p) => [p.id, p]));

  onProgress({
    phase: "posts",
    done: byId.size,
    total: stream.length || byId.size,
    message: `已获取 ${byId.size}/${stream.length || byId.size} 层`,
  });

  const missing = stream.filter((id) => !byId.has(id));
  const chunkSize = 20;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    const qs = chunk.map((id) => `post_ids[]=${id}`).join("&");
    const data = await fetchJson(`${base}/t/${topicId}/posts.json?${qs}`);
    const posts = data.post_stream?.posts || data.posts || [];
    for (const p of posts) byId.set(p.id, p);
    onProgress({
      phase: "posts",
      done: byId.size,
      total: stream.length || byId.size,
      message: `已获取 ${byId.size}/${stream.length || byId.size} 层`,
    });
    if (i + chunkSize < missing.length) await sleep(120);
  }

  let ordered;
  if (stream.length) {
    ordered = stream.map((id) => byId.get(id)).filter(Boolean);
  } else {
    ordered = [...byId.values()].sort(
      (a, b) => (a.post_number || 0) - (b.post_number || 0)
    );
  }

  return { topic, posts: ordered };
}

/**
 * 图片 URL → data URL（base64）
 */
export async function imageUrlToDataUrl(
  url,
  { maxBytes = 8 * 1024 * 1024, pageOrigin = "https://linux.do" } = {}
) {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (url.startsWith("//")) url = "https:" + url;
  if (url.startsWith("/")) url = pageOrigin.replace(/\/$/, "") + url;

  if (canUseBackground()) {
    try {
      return await bgRequest({
        type: "EXT_FETCH_DATA_URL",
        url,
        maxBytes,
        referrer: pageOrigin + "/",
      });
    } catch (e) {
      console.warn("[L2MD] bg image fail, fallback", e);
    }
  }

  const res = await fetch(url, {
    credentials: "include",
    referrer: pageOrigin + "/",
  });
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(
      `图片过大 (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB): ${url}`
    );
  }
  const ctype =
    res.headers.get("content-type")?.split(";")[0]?.trim() ||
    guessMime(url) ||
    "image/png";
  return arrayBufferToDataUrl(buf, ctype);
}

export function arrayBufferToDataUrl(buf, ctype) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${ctype};base64,${btoa(binary)}`;
}

/**
 * 图片 URL → { buffer, contentType }
 * WebDAV 上传时用，避免先转 data URL 再解码
 */
export async function imageUrlToBytes(
  url,
  { maxBytes = 8 * 1024 * 1024, pageOrigin = "https://linux.do" } = {}
) {
  if (!url) return null;
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) throw new Error("无法解析 data URL");
    const bin = atob(m[2].replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { buffer: bytes.buffer, contentType: m[1] || "image/png" };
  }
  if (url.startsWith("//")) url = "https:" + url;
  if (url.startsWith("/")) url = pageOrigin.replace(/\/$/, "") + url;

  if (canUseBackground()) {
    try {
      const data = await bgRequest({
        type: "EXT_FETCH_BYTES",
        url,
        maxBytes,
        referrer: pageOrigin + "/",
      });
      // data: { base64, contentType }
      const bin = atob(data.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { buffer: bytes.buffer, contentType: data.contentType || "image/png" };
    } catch (e) {
      console.warn("[L2MD] bg bytes fail, fallback", e);
    }
  }

  const res = await fetch(url, {
    credentials: "include",
    referrer: pageOrigin + "/",
  });
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(
      `图片过大 (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB): ${url}`
    );
  }
  const ctype =
    res.headers.get("content-type")?.split(";")[0]?.trim() ||
    guessMime(url) ||
    "image/png";
  return { buffer: buf, contentType: ctype };
}

function guessMime(url) {
  const u = url.toLowerCase().split("?")[0];
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".gif")) return "image/gif";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".svg")) return "image/svg+xml";
  return null;
}
