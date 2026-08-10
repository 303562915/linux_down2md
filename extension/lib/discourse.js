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
      if (isHttpResponseError(e)) throw e;
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

function isTransientRequestError(error) {
  const message = String(error?.message || error || "");
  return /\b429\b|\b5(?:0[0-9]|2[0-9])\b|just a moment|failed to fetch|networkerror/i.test(
    message
  );
}

function isHttpResponseError(error) {
  return /^HTTP\s+\d{3}\b/i.test(String(error?.message || error || ""));
}

async function retryRequest(request, onRetry = () => {}) {
  const maxAttempts = 5;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isTransientRequestError(error) || attempt === maxAttempts - 1) break;

      const rateLimited = /\b429\b|just a moment/i.test(
        String(error?.message || error || "")
      );
      const baseDelay = rateLimited ? 8_000 : 1_000;
      const delayMs = Math.min(60_000, baseDelay * 2 ** attempt) + Math.floor(Math.random() * 500);
      onRetry({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function fetchJsonWithRetry(url, onRetry) {
  return retryRequest(() => fetchJson(url), onRetry);
}

async function fetchText(url) {
  if (canUseBackground()) {
    try {
      return await bgRequest({ type: "EXT_FETCH_TEXT", url });
    } catch (e) {
      if (isHttpResponseError(e)) throw e;
      console.warn("[L2MD] bg text fail, fallback", e);
    }
  }
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`请求失败 ${res.status}: ${url}\n${text.slice(0, 200)}`);
  }
  return res.text();
}

function fetchTextWithRetry(url, onRetry) {
  return retryRequest(() => fetchText(url), onRetry);
}

/**
 * 获取 Discourse 某层的原始 Markdown。
 * /raw/:topicId/:postNumber 与站点「Raw」链接使用同一接口。
 */
export async function fetchRawPost(origin, topicId, postNumber, onRetry) {
  const base = origin.replace(/\/$/, "");
  const topic = encodeURIComponent(String(topicId));
  const post = Number(postNumber) || 1;
  return fetchTextWithRetry(`${base}/raw/${topic}/${post}`, onRetry);
}

/**
 * 只读取主题摘要和首屏楼层，不分页取得全部 cooked HTML。
 * Raw 导出全部/范围时用它确定最高楼层后即可直接请求 /raw。
 */
export async function fetchTopicSummary(origin, topicId, onProgress = () => {}) {
  const base = origin.replace(/\/$/, "");
  onProgress({ phase: "meta", done: 0, total: 1, message: "读取主题信息…" });
  const topic = await fetchJsonWithRetry(`${base}/t/${topicId}.json`, ({ delayMs }) => {
    onProgress({
      phase: "meta",
      done: 0,
      total: 1,
      message: `请求过快，${Math.ceil(delayMs / 1000)} 秒后重试…`,
    });
  });
  return { topic, posts: topic.post_stream?.posts || [] };
}

/**
 * 拉取主题元数据 + 全部楼层
 */
export async function fetchFullTopic(origin, topicId, onProgress = () => {}) {
  const base = origin.replace(/\/$/, "");
  onProgress({ phase: "meta", done: 0, total: 1, message: "读取主题信息…" });

  const topic = await fetchJsonWithRetry(`${base}/t/${topicId}.json`, ({ delayMs }) => {
    onProgress({
      phase: "meta",
      done: 0,
      total: 1,
      message: `请求过快，${Math.ceil(delayMs / 1000)} 秒后重试…`,
    });
  });
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
  // 小批次配合节流，避免 linux.do / Cloudflare 将大批 post_ids 请求判定为过快。
  const chunkSize = 10;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    const qs = chunk.map((id) => `post_ids[]=${id}`).join("&");
    const data = await fetchJsonWithRetry(
      `${base}/t/${topicId}/posts.json?${qs}`,
      ({ attempt, delayMs }) => {
        onProgress({
          phase: "posts",
          done: byId.size,
          total: stream.length || byId.size,
          message: `触发限流，${Math.ceil(delayMs / 1000)} 秒后重试（第 ${attempt} 次）…`,
        });
      }
    );
    const posts = data.post_stream?.posts || data.posts || [];
    for (const p of posts) byId.set(p.id, p);
    onProgress({
      phase: "posts",
      done: byId.size,
      total: stream.length || byId.size,
      message: `已获取 ${byId.size}/${stream.length || byId.size} 层`,
    });
    if (i + chunkSize < missing.length) await sleep(450);
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
