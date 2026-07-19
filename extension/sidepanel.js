import { parseTopicFromUrl } from "./lib/discourse.js";
import { exportTopicMarkdown } from "./lib/export.js";
import {
  ensureDir,
  joinRemotePath,
  listDirectories,
  normalizeBaseUrl,
  normalizeRemotePath,
  testConnection,
} from "./lib/webdav.js";

const $ = (id) => document.getElementById(id);

const ui = {
  pageStatus: $("pageStatus"),
  topicCard: $("topicCard"),
  topicTitle: $("topicTitle"),
  topicMeta: $("topicMeta"),
  rangeRow: $("rangeRow"),
  modeHint: $("modeHint"),
  fromFloor: $("fromFloor"),
  toFloor: $("toFloor"),
  imageModeHint: $("imageModeHint"),
  webdavCard: $("webdavCard"),
  davUrl: $("davUrl"),
  davUser: $("davUser"),
  davPass: $("davPass"),
  davRoot: $("davRoot"),
  davImagePath: $("davImagePath"),
  davLinkStyle: $("davLinkStyle"),
  davPublicUrl: $("davPublicUrl"),
  davNotePrefix: $("davNotePrefix"),
  publicUrlRow: $("publicUrlRow"),
  folderBrowser: $("folderBrowser"),
  folderCur: $("folderCur"),
  folderList: $("folderList"),
  newFolderName: $("newFolderName"),
  btnBrowseDav: $("btnBrowseDav"),
  btnFolderUp: $("btnFolderUp"),
  btnFolderRefresh: $("btnFolderRefresh"),
  btnNewFolder: $("btnNewFolder"),
  btnUseFolder: $("btnUseFolder"),
  btnTestDav: $("btnTestDav"),
  btnTogglePwd: $("btnTogglePwd"),
  btnRefresh: $("btnRefresh"),
  davStatus: $("davStatus"),
  vaultPath: $("vaultPath"),
  pathPreview: $("pathPreview"),
  askSaveAs: $("askSaveAs"),
  skipEmoji: $("skipEmoji"),
  includeMeta: $("includeMeta"),
  compactPostHeader: $("compactPostHeader"),
  postHeadingLevel: $("postHeadingLevel"),
  progress: $("progress"),
  barFill: $("barFill"),
  progressText: $("progressText"),
  btnExport: $("btnExport"),
  btnCopy: $("btnCopy"),
  hint: $("hint"),
  err: $("err"),
};

const MODE_HINTS = {
  all: "导出主题内所有楼层",
  author: "只导出贴主发过的全部楼层（含一楼与后续回复）",
  op: "只导出第 1 楼正文",
  range: "按楼层号区间导出",
};

const IMAGE_MODE_HINTS = {
  base64: "默认：图片内嵌 base64，笔记可离线打开",
  webdav: "图片上传到 WebDAV 文件夹，笔记里写文件链接（体积小）",
  url: "不下载图片，笔记保留原 CDN 链接（需联网）",
};

const DEFAULT_SETTINGS = {
  includeImages: true,
  imageMode: "base64",
  skipEmoji: true,
  includeMeta: true,
  mode: "all",
  vaultPath: "",
  askSaveAs: false,
  compactPostHeader: false,
  postHeadingLevel: 4,
  webdav: {
    baseUrl: "",
    username: "",
    password: "",
    rootPath: "/",
    imagePath: "/attachments",
    linkStyle: "relative",
    publicBaseUrl: "",
    noteRelativePrefix: "",
  },
};

let lastResult = null;
let currentTab = null;
let browsePath = "/";

function showError(msg) {
  ui.err.hidden = !msg;
  ui.err.textContent = msg || "";
}

function setProgress(pct, text) {
  ui.progress.hidden = false;
  ui.barFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  ui.progressText.textContent = text || "";
}

function onExportProgress(p) {
  const { phase, done, total, message } = p || {};
  let pct = 0;
  if (phase === "meta") pct = 5;
  else if (phase === "posts") pct = 10 + (total ? (done / total) * 30 : 15);
  else if (phase === "images") pct = 40 + (total ? (done / total) * 40 : 25);
  else if (phase === "convert") pct = 85 + (total ? (done / total) * 12 : 8);
  else if (phase === "done") pct = 100;
  setProgress(pct, message || phase || "");
}

function modeValue() {
  const el = document.querySelector('input[name="mode"]:checked');
  return el ? el.value : "all";
}

function imageModeValue() {
  const el = document.querySelector('input[name="imageMode"]:checked');
  return el ? el.value : "base64";
}

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

function updatePathPreview() {
  if (!ui.pathPreview) return;
  if (ui.askSaveAs?.checked) {
    ui.pathPreview.textContent = "将弹出「另存为」对话框";
    return;
  }
  const sub = sanitizeVaultSubpath(ui.vaultPath?.value || "");
  if (!sub) {
    ui.pathPreview.textContent =
      "保存到：浏览器默认下载目录（可在路径里填 vault 子文件夹）";
    return;
  }
  ui.pathPreview.textContent = `保存到：下载目录 / ${sub}/文件名.md`;
}

function updateModeUi() {
  const mode = modeValue();
  ui.rangeRow.hidden = mode !== "range";
  if (ui.modeHint) ui.modeHint.textContent = MODE_HINTS[mode] || "";
}

function updateImageModeUi() {
  const mode = imageModeValue();
  if (ui.imageModeHint) ui.imageModeHint.textContent = IMAGE_MODE_HINTS[mode] || "";
  if (ui.webdavCard) ui.webdavCard.hidden = mode !== "webdav";
  if (ui.publicUrlRow) {
    ui.publicUrlRow.hidden = ui.davLinkStyle.value !== "public";
  }
}

function readWebdavFromForm() {
  return {
    baseUrl: (ui.davUrl.value || "").trim(),
    username: (ui.davUser.value || "").trim(),
    password: ui.davPass.value || "",
    rootPath: normalizeRemotePath(ui.davRoot.value || "/"),
    imagePath: normalizeRemotePath(ui.davImagePath.value || "/attachments"),
    linkStyle: ui.davLinkStyle.value || "relative",
    publicBaseUrl: (ui.davPublicUrl.value || "").trim(),
    noteRelativePrefix: (ui.davNotePrefix.value || "").trim().replace(/\\/g, "/"),
  };
}

function fillWebdavForm(w = {}) {
  ui.davUrl.value = w.baseUrl || "";
  ui.davUser.value = w.username || "";
  ui.davPass.value = w.password || "";
  ui.davRoot.value = w.rootPath || "/";
  ui.davImagePath.value = w.imagePath || "/attachments";
  ui.davLinkStyle.value = w.linkStyle || "relative";
  ui.davPublicUrl.value = w.publicBaseUrl || "";
  ui.davNotePrefix.value = w.noteRelativePrefix || "";
}

function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS).then(async (local) => {
    // 兼容旧 sync 设置
    const sync = await chrome.storage.sync.get(DEFAULT_SETTINGS).catch(() => ({}));
    return {
      ...DEFAULT_SETTINGS,
      ...sync,
      ...local,
      webdav: {
        ...DEFAULT_SETTINGS.webdav,
        ...(sync.webdav || {}),
        ...(local.webdav || {}),
      },
    };
  });
}

async function saveSettings() {
  const imageMode = imageModeValue();
  const data = {
    includeImages: imageMode !== "url",
    imageMode,
    skipEmoji: ui.skipEmoji.checked,
    includeMeta: ui.includeMeta.checked,
    mode: modeValue(),
    vaultPath: sanitizeVaultSubpath(ui.vaultPath.value),
    askSaveAs: !!ui.askSaveAs.checked,
    compactPostHeader: !!ui.compactPostHeader.checked,
    postHeadingLevel: Number(ui.postHeadingLevel.value) || 4,
    webdav: readWebdavFromForm(),
  };
  // 敏感信息放 local，避免 sync 配额/同步
  await chrome.storage.local.set(data);
  // 非敏感同步一份（不含密码）
  const { password, ...webdavPublic } = data.webdav;
  await chrome.storage.sync.set({
    ...data,
    webdav: { ...webdavPublic, password: "" },
  });
  updatePathPreview();
  updateImageModeUi();
}

function setDavStatus(text, type = "") {
  ui.davStatus.textContent = text || "";
  ui.davStatus.className = "dav-status" + (type ? " " + type : "");
}

async function ensureWebdavPermission(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error("请填写服务器地址");
  const origin = new URL(base).origin;
  const patterns = [`${origin}/*`];
  // 必须在 popup 用户手势下 request，SW 里常被拒绝
  try {
    const has = await chrome.permissions.contains({ origins: patterns });
    if (has) return true;
    const granted = await chrome.permissions.request({ origins: patterns });
    if (!granted) {
      throw new Error("未授予 WebDAV 访问权限，请在浏览器弹窗中点「允许」");
    }
    return true;
  } catch (e) {
    // 兼容：走 background
    const res = await chrome.runtime.sendMessage({
      type: "ENSURE_WEBDAV_HOST",
      origin,
    });
    if (!res?.ok || !res.granted) {
      throw new Error(e?.message || res?.error || "申请 WebDAV 权限失败");
    }
    return true;
  }
}

async function testDav() {
  setDavStatus("测试中…");
  try {
    const cfg = readWebdavFromForm();
    await ensureWebdavPermission(cfg.baseUrl);
    await testConnection(cfg);
    // 确保图片目录
    if (cfg.imagePath) await ensureDir(cfg, cfg.imagePath);
    setDavStatus("连接成功", "ok");
    await saveSettings();
  } catch (e) {
    setDavStatus(e?.message || String(e), "err");
  }
}

async function openFolderBrowser() {
  ui.folderBrowser.hidden = false;
  const root = normalizeRemotePath(ui.davRoot.value || "/");
  const current = normalizeRemotePath(ui.davImagePath.value || root);
  browsePath = current || root || "/";
  await refreshFolderList();
}

async function refreshFolderList() {
  ui.folderList.innerHTML = `<div class="folder-empty">加载中…</div>`;
  ui.folderCur.textContent = browsePath;
  try {
    const cfg = readWebdavFromForm();
    await ensureWebdavPermission(cfg.baseUrl);
    const dirs = await listDirectories(cfg, browsePath);
    if (!dirs.length) {
      ui.folderList.innerHTML = `<div class="folder-empty">此目录下没有子文件夹</div>`;
      return;
    }
    ui.folderList.innerHTML = "";
    for (const d of dirs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "folder-item";
      btn.innerHTML = `<span class="ico">📁</span><span>${escapeHtml(d.name)}</span>`;
      btn.addEventListener("click", async () => {
        browsePath = d.path;
        await refreshFolderList();
      });
      ui.folderList.appendChild(btn);
    }
  } catch (e) {
    ui.folderList.innerHTML = `<div class="folder-empty">${escapeHtml(e?.message || String(e))}</div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function folderUp() {
  const root = normalizeRemotePath(ui.davRoot.value || "/");
  if (browsePath === "/" || browsePath === root) return;
  const parts = browsePath.split("/").filter(Boolean);
  parts.pop();
  browsePath = parts.length ? "/" + parts.join("/") : "/";
  // 不允许高于 root？允许浏览，但提示
  await refreshFolderList();
}

async function createFolder() {
  const name = (ui.newFolderName.value || "").trim().replace(/[\\/]/g, "");
  if (!name) {
    setDavStatus("请输入新文件夹名", "err");
    return;
  }
  try {
    const cfg = readWebdavFromForm();
    await ensureWebdavPermission(cfg.baseUrl);
    const target = joinRemotePath(browsePath, name);
    await ensureDir(cfg, target);
    ui.newFolderName.value = "";
    browsePath = target;
    setDavStatus(`已创建 ${target}`, "ok");
    await refreshFolderList();
  } catch (e) {
    setDavStatus(e?.message || String(e), "err");
  }
}

function useCurrentFolder() {
  ui.davImagePath.value = normalizeRemotePath(browsePath);
  ui.folderBrowser.hidden = true;
  setDavStatus(`图片目录：${ui.davImagePath.value}`, "ok");
  saveSettings();
}

function bindUi() {
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener("change", () => {
      updateModeUi();
      saveSettings();
    });
  });
  document.querySelectorAll('input[name="imageMode"]').forEach((el) => {
    el.addEventListener("change", () => {
      updateImageModeUi();
      saveSettings();
    });
  });

  [
    ui.skipEmoji,
    ui.includeMeta,
    ui.compactPostHeader,
    ui.askSaveAs,
    ui.postHeadingLevel,
    ui.davLinkStyle,
  ].forEach((el) => el?.addEventListener("change", saveSettings));

  ui.davLinkStyle?.addEventListener("change", updateImageModeUi);

  [
    ui.davUrl,
    ui.davUser,
    ui.davPass,
    ui.davRoot,
    ui.davImagePath,
    ui.davPublicUrl,
    ui.davNotePrefix,
    ui.vaultPath,
  ].forEach((el) => {
    el?.addEventListener("change", saveSettings);
  });

  ui.vaultPath?.addEventListener("input", updatePathPreview);
  ui.vaultPath?.addEventListener("blur", () => {
    ui.vaultPath.value = sanitizeVaultSubpath(ui.vaultPath.value);
    saveSettings();
  });

  ui.btnTestDav?.addEventListener("click", testDav);
  ui.btnBrowseDav?.addEventListener("click", openFolderBrowser);
  ui.btnFolderUp?.addEventListener("click", folderUp);
  ui.btnFolderRefresh?.addEventListener("click", refreshFolderList);
  ui.btnNewFolder?.addEventListener("click", createFolder);
  ui.btnUseFolder?.addEventListener("click", useCurrentFolder);
  ui.btnTogglePwd?.addEventListener("click", () => {
    const isPwd = ui.davPass.type === "password";
    ui.davPass.type = isPwd ? "text" : "password";
    ui.btnTogglePwd.textContent = isPwd ? "隐藏" : "显示";
  });
}

async function previewTopic(url) {
  const parsed = parseTopicFromUrl(url);
  if (!parsed) return null;
  const res = await fetch(`${parsed.origin}/t/${parsed.topicId}.json`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!res.ok) throw new Error(`预览失败 HTTP ${res.status}`);
  const data = await res.json();
  return {
    title: data.title,
    posts_count: data.posts_count,
    category_name: data.category_name || "",
    tags: data.tags || [],
    topicId: parsed.topicId,
  };
}

async function detectPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  if (!tab?.url) {
    ui.pageStatus.textContent = "无法读取当前标签页";
    return;
  }

  const parsed = parseTopicFromUrl(tab.url);
  if (!parsed) {
    ui.pageStatus.textContent = "请打开 linux.do 主题帖页面";
    ui.btnExport.disabled = true;
    showError("当前不是主题页。\n示例：https://linux.do/t/slug/12345");
    return;
  }

  ui.pageStatus.textContent = `主题 #${parsed.topicId}`;
  ui.btnExport.disabled = false;
  showError("");

  try {
    const info = await previewTopic(tab.url);
    ui.topicCard.hidden = false;
    ui.topicTitle.textContent = info.title || tab.title || "未命名主题";
    const parts = [];
    if (info.posts_count) parts.push(`${info.posts_count} 层`);
    if (info.category_name) parts.push(info.category_name);
    if (info.tags?.length) parts.push(info.tags.join(", "));
    ui.topicMeta.textContent = parts.join(" · ");
    if (info.posts_count) {
      ui.toFloor.placeholder = String(info.posts_count);
      if (!ui.toFloor.value) ui.toFloor.value = String(info.posts_count);
    }
  } catch {
    ui.topicCard.hidden = false;
    ui.topicTitle.textContent =
      tab.title?.replace(/\s*[-–|]\s*LINUX DO.*$/i, "") || `Topic ${parsed.topicId}`;
    ui.topicMeta.textContent = `ID ${parsed.topicId}`;
  }
}

async function doExport() {
  if (!currentTab?.url) return;
  lastResult = null;
  ui.btnCopy.disabled = true;
  ui.btnExport.disabled = true;
  showError("");
  setProgress(2, "开始导出…");
  await saveSettings();

  const imageMode = imageModeValue();
  const webdav = readWebdavFromForm();

  if (imageMode === "webdav") {
    try {
      await ensureWebdavPermission(webdav.baseUrl);
    } catch (e) {
      showError(e?.message || String(e));
      ui.progress.hidden = true;
      ui.btnExport.disabled = false;
      return;
    }
  }

  const options = {
    mode: modeValue(),
    from: Number(ui.fromFloor.value) || 1,
    to: Number(ui.toFloor.value) || undefined,
    includeImages: imageMode !== "url",
    imageMode,
    webdav: imageMode === "webdav" ? webdav : null,
    skipEmojiImg: ui.skipEmoji.checked,
    includeMeta: ui.includeMeta.checked,
    compactPostHeader: ui.compactPostHeader.checked,
    postHeadingLevel: Number(ui.postHeadingLevel.value) || 4,
    contentHeadingOffset: 3,
  };

  try {
    const result = await exportTopicMarkdown(
      currentTab.url,
      options,
      onExportProgress
    );

    const vaultPath = sanitizeVaultSubpath(ui.vaultPath.value);
    const askSaveAs = !!ui.askSaveAs.checked;

    const dl = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_MARKDOWN",
      filename: result.filename,
      content: result.markdown,
      vaultPath,
      saveAs: askSaveAs,
    });
    if (!dl?.ok) throw new Error(dl?.error || "下载失败");

    lastResult = result;
    const imgInfo =
      result.imageMode === "webdav"
        ? `WebDAV 上传 ${result.webdavUploaded || result.imageCount}`
        : `图片 ${result.imageCount}`;
    setProgress(100, `完成：${result.postCount} 层，${imgInfo}`);
    const where = askSaveAs
      ? "已弹出另存为"
      : vaultPath
        ? `已保存到 下载/${vaultPath}/`
        : "已保存到下载目录";
    ui.hint.textContent = `${where}${result.filename}`;
    ui.btnCopy.disabled = false;
  } catch (e) {
    console.error(e);
    showError(e?.message || String(e));
    ui.progress.hidden = true;
  } finally {
    ui.btnExport.disabled = false;
  }
}

async function copyMd() {
  if (!lastResult?.markdown) return;
  try {
    await navigator.clipboard.writeText(lastResult.markdown);
    ui.hint.textContent = "已复制 Markdown 到剪贴板";
  } catch {
    const ta = document.createElement("textarea");
    ta.value = lastResult.markdown;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    ui.hint.textContent = "已复制 Markdown 到剪贴板";
  }
}

async function main() {
  bindUi();
  const settings = await loadSettings();

  ui.skipEmoji.checked = !!settings.skipEmoji;
  ui.includeMeta.checked = !!settings.includeMeta;
  ui.compactPostHeader.checked = !!settings.compactPostHeader;
  ui.askSaveAs.checked = !!settings.askSaveAs;
  ui.vaultPath.value = settings.vaultPath || "";
  ui.postHeadingLevel.value = String(settings.postHeadingLevel || 4);

  const allowedModes = new Set(["all", "author", "op", "range"]);
  const mode = allowedModes.has(settings.mode) ? settings.mode : "all";
  const modeEl = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (modeEl) modeEl.checked = true;

  let imageMode = settings.imageMode || "base64";
  // 兼容旧 includeImages
  if (!settings.imageMode && settings.includeImages === false) imageMode = "url";
  const imgEl = document.querySelector(`input[name="imageMode"][value="${imageMode}"]`);
  if (imgEl) imgEl.checked = true;

  fillWebdavForm(settings.webdav || {});
  updateModeUi();
  updateImageModeUi();
  updatePathPreview();

  ui.btnExport.addEventListener("click", doExport);
  ui.btnCopy.addEventListener("click", copyMd);
  ui.btnRefresh?.addEventListener("click", () => detectPage());

  // 侧边栏常开：切换标签 / 当前页 URL 变化时自动刷新主题信息
  try {
    chrome.tabs.onActivated.addListener(() => {
      detectPage().catch(() => {});
    });
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (info.status === "complete" || info.url) {
        if (tab?.active) detectPage().catch(() => {});
      }
    });
  } catch {
    /* ignore */
  }

  await detectPage();
}

main();
