/**
 * 页面浮动按钮：一键导出当前主题为 Obsidian MD
 * 通过动态 import 加载转换库（需 web_accessible_resources）
 */

(function () {
  const BTN_ID = "l2md-fab";
  const TOAST_ID = "l2md-toast";

  function isTopicPage() {
    return /\/t\/(?:[^/]+\/)?\d+/.test(location.pathname);
  }

  function ensureFab() {
    if (!isTopicPage()) {
      document.getElementById(BTN_ID)?.remove();
      return;
    }
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.title = "导出为 Obsidian 笔记";
    btn.innerHTML = `<span class="l2md-fab-icon">N</span><span class="l2md-fab-text">导出笔记</span>`;
    btn.addEventListener("click", onClick);
    document.documentElement.appendChild(btn);
  }

  function toast(msg, type = "info") {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      document.documentElement.appendChild(el);
    }
    el.className = `l2md-toast l2md-toast-${type}`;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove("show"), 4200);
  }

  function setBusy(busy, text) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle("busy", !!busy);
    const t = btn.querySelector(".l2md-fab-text");
    if (t) t.textContent = text || (busy ? "导出中…" : "导出笔记");
  }

  async function loadExport() {
    const url = chrome.runtime.getURL("lib/export.js");
    return import(url);
  }

  async function loadSettings() {
    try {
      const defaults = {
        includeImages: true,
        imageMode: "url",
        skipEmoji: true,
        includeMeta: true,
        mode: "all",
        enableNoteSync: false,
        noteFolderName: "",
        askSaveAs: false,
        compactPostHeader: false,
        postHeadingLevel: 4,
        webdav: null,
      };
      const local = await chrome.storage.local.get(defaults);
      const sync = await chrome.storage.sync.get(defaults).catch(() => ({}));
      return {
        ...defaults,
        ...sync,
        ...local,
        webdav: local.webdav || sync.webdav || null,
      };
    } catch {
      return {
        includeImages: true,
        imageMode: "url",
        skipEmoji: true,
        includeMeta: true,
        mode: "all",
        enableNoteSync: false,
        noteFolderName: "",
        askSaveAs: false,
        compactPostHeader: false,
        postHeadingLevel: 4,
        webdav: null,
      };
    }
  }

  async function onClick() {
    if (!isTopicPage()) {
      toast("请在主题帖页面使用", "err");
      return;
    }
    setBusy(true, "导出中…");
    toast("开始导出，请稍候…");

    try {
      const { exportTopicMarkdown } = await loadExport();
      const settings = await loadSettings();
      const allowed = new Set(["all", "author", "op", "range"]);
      const mode = allowed.has(settings.mode) ? settings.mode : "all";
      let imageMode = settings.imageMode || "url";
      if (!settings.imageMode && settings.includeImages === false) imageMode = "url";
      const options = {
        mode,
        includeImages: imageMode !== "url",
        imageMode,
        webdav: imageMode === "webdav" ? settings.webdav : null,
        skipEmojiImg: !!settings.skipEmoji,
        includeMeta: !!settings.includeMeta,
        compactPostHeader: !!settings.compactPostHeader,
        postHeadingLevel: Number(settings.postHeadingLevel) || 4,
        contentHeadingOffset: 3,
      };

      const result = await exportTopicMarkdown(
        location.href,
        options,
        (p) => {
          if (p?.message) setBusy(true, p.message.slice(0, 10));
        }
      );

      // 页面浮动按钮：走下载 API（侧边栏可选文件夹写入）
      const dl = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_MARKDOWN",
        filename: result.filename,
        content: result.markdown,
        vaultPath: "",
        saveAs: !!settings.askSaveAs,
      });
      if (!dl?.ok) throw new Error(dl?.error || "下载失败");

      toast(`已导出 ${result.postCount} 层 · ${result.filename}`, "ok");
    } catch (e) {
      console.error("[L2MD]", e);
      toast(e?.message || String(e), "err");
    } finally {
      setBusy(false, "导出笔记");
    }
  }

  // Discourse 是 SPA，监听 URL 变化
  let last = location.href;
  const tick = () => {
    if (location.href !== last) {
      last = location.href;
      ensureFab();
    }
  };
  setInterval(tick, 800);
  ensureFab();

  // 初次进入
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureFab);
  }
})();
