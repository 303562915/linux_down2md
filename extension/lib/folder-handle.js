/**
 * 本地文件夹选择 / 持久化（File System Access API）
 * 用于把 md 直接写进用户选中的 Obsidian 目录
 */

const DB_NAME = "l2md-fs";
const STORE = "handles";
const KEY_NOTE_DIR = "noteDir";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function supportsDirectoryPicker() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/**
 * 弹出系统文件夹选择器
 * @returns {Promise<{handle: FileSystemDirectoryHandle, name: string}>}
 */
export async function pickNoteDirectory() {
  if (!supportsDirectoryPicker()) {
    throw new Error("当前浏览器不支持文件夹选择，请用 Chrome/Edge 114+，或勾选「每次弹出另存为」");
  }
  const handle = await window.showDirectoryPicker({
    id: "l2md-obsidian-notes",
    mode: "readwrite",
    startIn: "documents",
  });
  // 申请持久权限
  if (handle.requestPermission) {
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      throw new Error("未获得文件夹写入权限");
    }
  }
  await idbSet(KEY_NOTE_DIR, handle);
  return { handle, name: handle.name || "已选文件夹" };
}

export async function clearNoteDirectory() {
  await idbDel(KEY_NOTE_DIR);
}

/**
 * 读取已保存的目录句柄。初始化时只恢复句柄，不主动请求权限。
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function getNoteDirectoryHandle() {
  try {
    const handle = await idbGet(KEY_NOTE_DIR);
    if (!handle) return null;
    return handle;
  } catch {
    return null;
  }
}

/** 在「导出」点击手势内恢复目录写入权限。 */
export async function ensureNoteDirectoryPermission(handle) {
  if (!handle) return false;
  if (handle.requestPermission) {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  }
  if (handle.queryPermission) {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  }
  return true;
}

/**
 * 写入 markdown 到已选文件夹
 */
export async function writeMarkdownToDirectory(handle, filename, content) {
  if (!handle) throw new Error("未选择笔记文件夹");
  const safe = String(filename || "topic.md").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const fileHandle = await handle.getFileHandle(safe, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
  return safe;
}
