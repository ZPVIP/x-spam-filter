/**
 * X Spam Filter —— service worker
 *
 * 只做三件事：首次安装写入默认配置、首次安装拉一次社区词库、
 * 把 content script 报上来的过滤条数显示在图标徽标上。
 */

importScripts(chrome.runtime.getURL("src/shared.js"));

/**
 * 社区词库不在扩展包里，装好后先取一次，用户不打开设置面板也能用上。
 * 失败不重试也不报错 —— 设置面板里还有手动同步按钮。
 */
async function primeCommunityKeywords() {
  try {
    const keywords = await globalThis.XSF_fetchKeywordSource("community");
    const stored = await chrome.storage.local.get("config");
    const config = { ...globalThis.XSF_DEFAULTS, ...(stored.config || {}) };
    if (Array.isArray(config.communityKeywords)) return; // 期间用户已经手动同步过
    await chrome.storage.local.set({
      config: { ...config, communityKeywords: keywords, communitySyncedAt: Date.now() }
    });
  } catch (error) {
    console.warn("[XSF] 社区词库首次获取失败，可在设置面板手动同步:", error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("config");
  const merged = { ...globalThis.XSF_DEFAULTS, ...(stored.config || {}) };
  await chrome.storage.local.set({ config: merged });
  chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });

  if (merged.useCommunity && !Array.isArray(merged.communityKeywords)) {
    primeCommunityKeywords();
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "XSF_COUNT") return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;

  const count = Number(message.count) || 0;
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#1d9bf0" });
});
