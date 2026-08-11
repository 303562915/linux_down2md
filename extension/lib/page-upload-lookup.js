/**
 * 在当前论坛标签页中解析 Discourse upload:// 短码。
 * lookup-urls 是登录保护的 POST 接口，必须使用页面自身的 Cookie 和 CSRF token。
 */
export async function lookupPageUploadUrls(tabId, shortUrls) {
  const urls = [...new Set((shortUrls || []).map((url) => String(url || "").trim()).filter(Boolean))];
  if (!urls.length || !Number.isInteger(tabId)) return [];

  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [urls],
    func: async (pageShortUrls) => {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
      const body = new URLSearchParams();
      for (const shortUrl of pageShortUrls) body.append("short_urls[]", shortUrl);
      const response = await fetch("/uploads/lookup-urls", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-CSRF-Token": csrfToken,
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
      });
      if (!response.ok) throw new Error(`上传短链解析失败 HTTP ${response.status}`);
      return response.json();
    },
  });

  const result = injected?.[0]?.result;
  return Array.isArray(result) ? result : [];
}
