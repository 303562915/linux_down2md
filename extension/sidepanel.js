import { parseTopicFromUrl } from "./lib/discourse.js";
import { exportTopicMarkdown } from "./lib/export.js";
import { lookupPageUploadUrls } from "./lib/page-upload-lookup.js";
import {
  clearNoteDirectory,
  ensureNoteDirectoryPermission,
  getNoteDirectoryHandle,
  pickNoteDirectory,
  supportsDirectoryPicker,
  writeMarkdownToDirectory,
} from "./lib/folder-handle.js";
import {
  ensureDir,
  joinRemotePath,
  listDirectories,
  normalizeBaseUrl,
  normalizeRemotePath,
  testConnection,
  uploadTextFile,
} from "./lib/webdav.js";

const $ = (id) => document.getElementById(id);

const JIANGUOYUN_DAV = "https://dav.jianguoyun.com/dav/";

const ui = {
  pageStatus: $("pageStatus"),
  topicCard: $("topicCard"),
  topicTitle: $("topicTitle"),
  topicMeta: $("topicMeta"),
  rangeRow: $("rangeRow"),
  modeHint: $("modeHint"),
  fromFloor: $("fromFloor"),
  toFloor: $("toFloor"),
  contentSourceHint: $("contentSourceHint"),
  imageModeHint: $("imageModeHint"),
  webdavCard: $("webdavCard"),
  davUrl: $("davUrl"),
  davUser: $("davUser"),
  davPass: $("davPass"),
  davRoot: $("davRoot"),
  davRootDisplay: $("davRootDisplay"),
  davImagePath: $("davImagePath"),
  davImagePathDisplay: $("davImagePathDisplay"),
  webdavPathsCard: $("webdavPathsCard"),
  folderBrowser: $("folderBrowser"),
  folderTargetLabel: $("folderTargetLabel"),
  folderCur: $("folderCur"),
  folderList: $("folderList"),
  newFolderName: $("newFolderName"),
  btnBrowseRoot: $("btnBrowseRoot"),
  btnBrowseImage: $("btnBrowseImage"),
  btnFolderUp: $("btnFolderUp"),
  btnFolderRefresh: $("btnFolderRefresh"),
  btnFolderClose: $("btnFolderClose"),
  btnNewFolder: $("btnNewFolder"),
  btnUseFolder: $("btnUseFolder"),
  btnTestDav: $("btnTestDav"),
  btnTogglePwd: $("btnTogglePwd"),
  btnRefresh: $("btnRefresh"),
  davStatus: $("davStatus"),
  enableDavNoteUpload: $("enableDavNoteUpload"),
  davNotePathFields: $("davNotePathFields"),
  davNoteOffHint: $("davNoteOffHint"),
  enableNoteSync: $("enableNoteSync"),
  noteSyncFields: $("noteSyncFields"),
  noteSyncOffHint: $("noteSyncOffHint"),
  noteFolderDisplay: $("noteFolderDisplay"),
  btnBrowseNoteFolder: $("btnBrowseNoteFolder"),
  btnClearNoteFolder: $("btnClearNoteFolder"),
  pathPreview: $("pathPreview"),
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
  url: "保留 L 站原图链接",
  base64: "内嵌 base64",
  webdav: "上传到图片路径",
};

const CONTENT_SOURCE_HINTS = {
  html: "读取页面 HTML 后转换为 Markdown",
  raw: "直接读取论坛 Raw Markdown，不经过 HTML 转换",
};

const DEFAULT_SETTINGS = {
  includeImages: true,
  imageMode: "url",
  skipEmoji: true,
  includeMeta: true,
  mode: "all",
  contentSource: "html",
  enableNoteSync: false, // 本地导出，默认关
  enableDavNoteUpload: false, // 笔记上传 WebDAV，默认关
  noteFolderName: "",
  compactPostHeader: false,
  postHeadingLevel: 4,
  webdav: {
    baseUrl: JIANGUOYUN_DAV,
    username: "",
    password: "",
    // notePath：笔记 md 上传目录（原 rootPath）
    notePath: "/",
    rootPath: "/", // 兼容旧字段
    imagePath: "/attachments",
    linkStyle: "relative",
  },
};

let lastResult = null;
let currentTab = null;
/** @type {'root'|'image'|null} */
let browseTarget = null;
let browsePath = "/";
/** @type {FileSystemDirectoryHandle|null} */
let noteDirHandle = null;

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
  return el ? el.value : "url";
}

function contentSourceValue() {
  const el = document.querySelector('input[name="contentSource"]:checked');
  return el ? el.value : "html";
}

function setDavPathDisplay(hiddenInput, displayEl, path, fallback = "/") {
  const p = normalizeRemotePath(path || fallback);
  if (hiddenInput) hiddenInput.value = p;
  if (displayEl) {
    displayEl.textContent = p;
    displayEl.title = p;
  }
}

function setNotePathDisplay(path) {
  setDavPathDisplay(ui.davRoot, ui.davRootDisplay, path, "/");
}

function setImagePathDisplay(path) {
  setDavPathDisplay(ui.davImagePath, ui.davImagePathDisplay, path, "/attachments");
}

function updateDavNoteUploadUi() {
  const on = !!ui.enableDavNoteUpload?.checked;
  if (ui.davNotePathFields) ui.davNotePathFields.hidden = !on;
  if (ui.davNoteOffHint) ui.davNoteOffHint.hidden = on;
}

function updateNoteFolderDisplay(name) {
  if (!ui.noteFolderDisplay) return;
  if (name) {
    ui.noteFolderDisplay.textContent = `📁 ${name}`;
    ui.noteFolderDisplay.title = name;
  } else {
    ui.noteFolderDisplay.textContent = "未选择";
    ui.noteFolderDisplay.title = "";
  }
}

function updatePathPreview() {
  if (!ui.pathPreview) return;
  if (!ui.enableNoteSync?.checked) {
    ui.pathPreview.textContent = "";
    return;
  }
  if (noteDirHandle?.name) {
    ui.pathPreview.textContent = `已选：${noteDirHandle.name}`;
    return;
  }
  ui.pathPreview.textContent = "";
}

function updateNoteSyncUi() {
  const on = !!ui.enableNoteSync?.checked;
  if (ui.noteSyncFields) ui.noteSyncFields.hidden = !on;
  if (ui.noteSyncOffHint) ui.noteSyncOffHint.hidden = on;
  updatePathPreview();
}

function updateImageModeUi() {
  const mode = imageModeValue();
  const isDav = mode === "webdav";
  if (ui.imageModeHint) ui.imageModeHint.textContent = IMAGE_MODE_HINTS[mode] || "";
  if (ui.webdavCard) ui.webdavCard.hidden = !isDav;
  if (ui.webdavPathsCard) ui.webdavPathsCard.hidden = !isDav;
  if (!isDav && ui.folderBrowser) {
    ui.folderBrowser.hidden = true;
    browseTarget = null;
  }
}

function updateContentSourceUi() {
  const source = contentSourceValue();
  if (ui.contentSourceHint) {
    ui.contentSourceHint.textContent = CONTENT_SOURCE_HINTS[source] || "";
  }
}

function updateModeUi() {
  const mode = modeValue();
  ui.rangeRow.hidden = mode !== "range";
  if (ui.modeHint) ui.modeHint.textContent = MODE_HINTS[mode] || "";
}

function readWebdavFromForm() {
  const notePath = normalizeRemotePath(
    ui.davRoot?.value || wNotePathFallback()
  );
  return {
    baseUrl: (ui.davUrl.value || "").trim() || JIANGUOYUN_DAV,
    username: (ui.davUser.value || "").trim(),
    password: ui.davPass.value || "",
    notePath,
    // export 图片逻辑仍读 imagePath；rootPath 兼容旧代码
    rootPath: notePath,
    imagePath: normalizeRemotePath(ui.davImagePath?.value || "/attachments"),
    linkStyle: "relative",
    publicBaseUrl: "",
    noteRelativePrefix: "",
  };
}

function wNotePathFallback() {
  return "/";
}

function fillWebdavForm(w = {}) {
  ui.davUrl.value = w.baseUrl || JIANGUOYUN_DAV;
  ui.davUser.value = w.username || "";
  ui.davPass.value = w.password || "";
  // 兼容旧 rootPath
  setNotePathDisplay(w.notePath || w.rootPath || "/");
  setImagePathDisplay(w.imagePath || "/attachments");
}

function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS).then(async (local) => {
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
    contentSource: contentSourceValue(),
    enableNoteSync: !!ui.enableNoteSync.checked,
    enableDavNoteUpload: !!ui.enableDavNoteUpload?.checked,
    noteFolderName: noteDirHandle?.name || "",
    compactPostHeader: !!ui.compactPostHeader.checked,
    postHeadingLevel: Number(ui.postHeadingLevel.value) || 4,
    webdav: readWebdavFromForm(),
  };
  await chrome.storage.local.set(data);
  const { password, ...webdavPublic } = data.webdav;
  await chrome.storage.sync.set({
    ...data,
    webdav: { ...webdavPublic, password: "" },
  });
  updatePathPreview();
  updateImageModeUi();
  updateContentSourceUi();
  updateNoteSyncUi();
  updateDavNoteUploadUi();
}

function setDavStatus(text, type = "") {
  if (!ui.davStatus) return;
  ui.davStatus.textContent = text || "";
  ui.davStatus.className = "dav-status" + (type ? " " + type : "");
}

async function ensureWebdavPermission(baseUrl) {
  const base = normalizeBaseUrl(baseUrl || JIANGUOYUN_DAV);
  if (!base) throw new Error("请填写服务器地址");
  const origin = new URL(base).origin;
  const patterns = [`${origin}/*`];
  try {
    const has = await chrome.permissions.contains({ origins: patterns });
    if (has) return true;
    const granted = await chrome.permissions.request({ origins: patterns });
    if (!granted) {
      throw new Error("未授予 WebDAV 访问权限，请在浏览器弹窗中点「允许」");
    }
    return true;
  } catch (e) {
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
    await testConnection({ ...cfg, rootPath: "/" });
    if (ui.enableDavNoteUpload?.checked && cfg.notePath && cfg.notePath !== "/") {
      await ensureDir(cfg, cfg.notePath);
    }
    if (cfg.imagePath) await ensureDir(cfg, cfg.imagePath);
    setDavStatus("连接成功", "ok");
    await saveSettings();
  } catch (e) {
    setDavStatus(e?.message || String(e), "err");
  }
}

/**
 * @param {'root'|'image'} target
 */
async function openDavFolderBrowser(target) {
  browseTarget = target;
  ui.folderBrowser.hidden = false;
  if (ui.folderTargetLabel) {
    ui.folderTargetLabel.textContent =
      target === "root" ? "选择：笔记上传目录" : "选择：图片上传目录";
  }
  const notePath = normalizeRemotePath(ui.davRoot?.value || "/");
  const image = normalizeRemotePath(ui.davImagePath?.value || notePath);
  browsePath = target === "root" ? notePath || "/" : image || "/";
  await refreshFolderList();
}

function closeFolderBrowser() {
  if (ui.folderBrowser) ui.folderBrowser.hidden = true;
  browseTarget = null;
}

async function refreshFolderList() {
  ui.folderList.innerHTML = `<div class="folder-empty">加载中…</div>`;
  ui.folderCur.textContent = browsePath;
  try {
    const cfg = readWebdavFromForm();
    await ensureWebdavPermission(cfg.baseUrl);
    const dirs = await listDirectories(cfg, browsePath);
    ui.folderList.innerHTML = "";

    const head = document.createElement("div");
    head.className = "folder-empty";
    head.style.textAlign = "left";
    head.innerHTML = `当前：<code>${escapeHtml(browsePath)}</code> · 子文件夹 ${dirs.length} 个`;
    ui.folderList.appendChild(head);

    if (!dirs.length) {
      const empty = document.createElement("div");
      empty.className = "folder-empty";
      empty.textContent = "无子文件夹，可直接选中当前目录";
      ui.folderList.appendChild(empty);
      return;
    }

    for (const d of dirs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "folder-item";
      btn.innerHTML = `<span class="ico">📁</span><span>${escapeHtml(d.name)}</span>`;
      btn.title = d.path;
      btn.addEventListener("click", async () => {
        browsePath = d.path;
        await refreshFolderList();
      });
      ui.folderList.appendChild(btn);
    }
  } catch (e) {
    console.error("[L2MD] list dir", e);
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
  if (browsePath === "/") return;
  const parts = browsePath.split("/").filter(Boolean);
  parts.pop();
  browsePath = parts.length ? "/" + parts.join("/") : "/";
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
  const path = normalizeRemotePath(browsePath || "/");
  if (browseTarget === "root") {
    setNotePathDisplay(path);
    setDavStatus(`笔记上传目录：${path}`, "ok");
  } else {
    setImagePathDisplay(path);
    setDavStatus(`图片上传目录：${path}`, "ok");
  }
  closeFolderBrowser();
  saveSettings();
}

async function refreshNoteFolderFromStore() {
  noteDirHandle = await getNoteDirectoryHandle();
  updateNoteFolderDisplay(noteDirHandle?.name || "");
  updatePathPreview();
  if (noteDirHandle?.name) {
    await chrome.storage.local.set({ noteFolderName: noteDirHandle.name });
  }
}

async function onBrowseNoteFolder() {
  try {
    const { handle, name } = await pickNoteDirectory();
    noteDirHandle = handle;
    updateNoteFolderDisplay(name);
    await chrome.storage.local.set({ noteFolderName: name, enableNoteSync: true });
    if (ui.enableNoteSync) ui.enableNoteSync.checked = true;
    updateNoteSyncUi();
    ui.hint.textContent = `本地保存：${name}`;
    await saveSettings();
  } catch (e) {
    if (e?.name === "AbortError") return;
    showError(e?.message || String(e));
  }
}

async function onClearNoteFolder() {
  await clearNoteDirectory();
  noteDirHandle = null;
  updateNoteFolderDisplay("");
  await chrome.storage.local.set({ noteFolderName: "" });
  updatePathPreview();
  await saveSettings();
  ui.hint.textContent = "已清除本地保存路径";
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
  document.querySelectorAll('input[name="contentSource"]').forEach((el) => {
    el.addEventListener("change", () => {
      updateContentSourceUi();
      if (contentSourceValue() === "raw") detectPage().catch(() => {});
      saveSettings();
    });
  });

  [
    ui.skipEmoji,
    ui.includeMeta,
    ui.compactPostHeader,
    ui.postHeadingLevel,
    ui.enableNoteSync,
    ui.enableDavNoteUpload,
  ].forEach((el) => el?.addEventListener("change", saveSettings));

  ui.enableNoteSync?.addEventListener("change", updateNoteSyncUi);
  ui.enableDavNoteUpload?.addEventListener("change", updateDavNoteUploadUi);

  [ui.davUrl, ui.davUser, ui.davPass].forEach((el) => {
    el?.addEventListener("change", saveSettings);
  });

  ui.btnBrowseNoteFolder?.addEventListener("click", onBrowseNoteFolder);
  ui.btnClearNoteFolder?.addEventListener("click", onClearNoteFolder);

  ui.btnTestDav?.addEventListener("click", testDav);
  ui.btnBrowseRoot?.addEventListener("click", () => openDavFolderBrowser("root"));
  ui.btnBrowseImage?.addEventListener("click", () => openDavFolderBrowser("image"));
  ui.btnFolderUp?.addEventListener("click", folderUp);
  ui.btnFolderRefresh?.addEventListener("click", refreshFolderList);
  ui.btnFolderClose?.addEventListener("click", closeFolderBrowser);
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

  // Raw 全量不需要主题 JSON；避免预览请求触发 Cloudflare 限流。
  if (contentSourceValue() === "raw") {
    ui.topicCard.hidden = false;
    ui.topicTitle.textContent =
      tab.title?.replace(/\s*[-–|]\s*LINUX DO.*$/i, "") || `Topic ${parsed.topicId}`;
    ui.topicMeta.textContent = `ID ${parsed.topicId}`;
    return;
  }

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

  // 权限恢复与目录选择都必须在点击「导出」的用户手势内进行。
  if (ui.enableNoteSync?.checked && supportsDirectoryPicker()) {
    try {
      if (noteDirHandle) {
        const granted = await ensureNoteDirectoryPermission(noteDirHandle);
        if (!granted) throw new Error("未获得已选文件夹的写入权限");
      } else {
        const picked = await pickNoteDirectory();
        noteDirHandle = picked.handle;
        updateNoteFolderDisplay(picked.name);
        await chrome.storage.local.set({ noteFolderName: picked.name, enableNoteSync: true });
        updatePathPreview();
      }
    } catch (e) {
      if (e?.name !== "AbortError") showError(e?.message || String(e));
      ui.progress.hidden = true;
      ui.btnExport.disabled = false;
      return;
    }
  }

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
    contentSource: contentSourceValue(),
    topicTitle: currentTab.title || "",
    lookupRawUploads: (shortUrls) => lookupPageUploadUrls(currentTab.id, shortUrls),
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

    // 1) 本地导出（默认关 → 下载目录）
    const enableNoteSync = !!ui.enableNoteSync.checked;
    const parts = [];

    if (enableNoteSync) {
      if (!noteDirHandle) noteDirHandle = await getNoteDirectoryHandle();
      if (noteDirHandle) {
        const savedName = await writeMarkdownToDirectory(
          noteDirHandle,
          result.filename,
          result.markdown
        );
        parts.push(`本地 ${noteDirHandle.name}/`);
        result.filename = savedName;
      } else if (supportsDirectoryPicker()) {
        throw new Error("请先点击「浏览选择」设置本地文件夹，再导出");
      } else {
        const dl = await chrome.runtime.sendMessage({
          type: "DOWNLOAD_MARKDOWN",
          filename: result.filename,
          content: result.markdown,
          vaultPath: "",
          saveAs: false,
        });
        if (!dl?.ok) throw new Error(dl?.error || "下载失败");
        parts.push("下载目录");
      }
    } else {
      const dl = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_MARKDOWN",
        filename: result.filename,
        content: result.markdown,
        vaultPath: "",
        saveAs: false,
      });
      if (!dl?.ok) throw new Error(dl?.error || "下载失败");
      parts.push("下载目录");
    }

    // 2) 笔记上传 WebDAV（默认关）
    const uploadNoteDav =
      imageMode === "webdav" && !!ui.enableDavNoteUpload?.checked;
    if (uploadNoteDav) {
      setProgress(96, "上传笔记到 WebDAV…");
      const noteDir = normalizeRemotePath(webdav.notePath || webdav.rootPath || "/");
      const remoteMd = joinRemotePath(noteDir, result.filename);
      await uploadTextFile(webdav, remoteMd, result.markdown);
      parts.push(`WebDAV ${noteDir}/`);
    }

    lastResult = result;
    const imgInfo =
      result.imageMode === "webdav"
        ? `图 ${result.webdavUploaded || result.imageCount}`
        : result.imageMode === "url"
          ? "L站链接"
          : `图 ${result.imageCount}`;
    setProgress(100, `完成：${result.postCount} 层，${imgInfo}`);
    ui.hint.textContent = `已保存：${parts.join(" · ")}${result.filename}`;
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
  ui.enableNoteSync.checked = !!settings.enableNoteSync;
  if (ui.enableDavNoteUpload) {
    ui.enableDavNoteUpload.checked = !!settings.enableDavNoteUpload;
  }
  ui.postHeadingLevel.value = String(settings.postHeadingLevel || 4);

  const allowedModes = new Set(["all", "author", "op", "range"]);
  const mode = allowedModes.has(settings.mode) ? settings.mode : "all";
  const modeEl = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (modeEl) modeEl.checked = true;

  const contentSource = settings.contentSource === "raw" ? "raw" : "html";
  const sourceEl = document.querySelector(
    `input[name="contentSource"][value="${contentSource}"]`
  );
  if (sourceEl) sourceEl.checked = true;

  let imageMode = settings.imageMode || "url";
  if (!settings.imageMode && settings.includeImages === false) imageMode = "url";
  const imgEl = document.querySelector(`input[name="imageMode"][value="${imageMode}"]`);
  if (imgEl) imgEl.checked = true;
  else {
    const urlEl = document.querySelector('input[name="imageMode"][value="url"]');
    if (urlEl) urlEl.checked = true;
  }

  fillWebdavForm({
    ...DEFAULT_SETTINGS.webdav,
    ...(settings.webdav || {}),
    baseUrl: settings.webdav?.baseUrl || JIANGUOYUN_DAV,
  });

  await refreshNoteFolderFromStore();
  if (!noteDirHandle && settings.noteFolderName) {
    updateNoteFolderDisplay(settings.noteFolderName + "（需重新选择）");
  }

  updateModeUi();
  updateContentSourceUi();
  updateImageModeUi();
  updateNoteSyncUi();
  updateDavNoteUploadUi();
  updatePathPreview();

  ui.btnExport.addEventListener("click", doExport);
  ui.btnCopy.addEventListener("click", copyMd);
  ui.btnRefresh?.addEventListener("click", () => detectPage());

  try {
    chrome.tabs.onActivated.addListener(() => {
      detectPage().catch(() => {});
    });
    chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
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
