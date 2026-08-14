/**
 * X Spam Filter —— popup
 *
 * 配置整份存在 storage.local 的 "config" key 下；content script 通过
 * storage.onChanged 实时收到变更，页面立刻生效，不需要刷新。
 *
 * 两份词库在这里是**只读**的：同步会整份替换，改了也保不住。
 * 误伤靠「白名单」减词 —— 每一行右边一个按钮，点一下就把那条规则停掉。
 */
(() => {
  "use strict";

  const DEFAULTS = globalThis.XSF_DEFAULTS;
  const parseKeywords = globalThis.XSF_parseKeywordText;
  const asRegex = globalThis.XSF_asRegex;
  let builtinKeywords = [];

  /** 超过这么多天没同步，社区词库那栏提醒一句。 */
  const STALE_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const $ = (id) => document.getElementById(id);

  const el = {
    body: document.body,
    enabled: $("enabled"),
    status: $("status"),
    modeDim: $("mode-dim"),
    modeHide: $("mode-hide"),
    opacityRow: $("opacity-row"),
    opacity: $("opacity"),
    opacityVal: $("opacity-val"),
    previewRow: $("preview-row"),
    userKeywords: $("user-keywords"),
    saved: $("saved"),
    whitelist: $("whitelist"),
    whitelistCount: $("whitelist-count"),
    whitelistSaved: $("whitelist-saved"),
    highlightHit: $("highlight-hit"),
    matchNames: $("match-names"),
    ignoreSpaces: $("ignore-spaces"),
    caseSensitive: $("case-sensitive"),
    count: $("count"),
    reset: $("reset"),
    confirm: $("confirm"),
    confirmUserCount: $("confirm-user-count"),
    confirmWlCount: $("confirm-wl-count"),
    confirmOk: $("confirm-ok"),
    confirmCancel: $("confirm-cancel")
  };

  /**
   * 两份词库共用一套 UI 和一套同步逻辑，只有「没有本地副本时回落到什么」不同：
   * 内置词库回落到扩展包里的出厂副本，社区词库没有出厂副本，回落到空。
   */
  const SOURCES = {
    builtin: {
      label: "内置词库",
      block: $("builtin-source"),
      toggle: $("use-builtin"),
      count: $("builtin-count"),
      details: $("builtin-details"),
      filter: $("builtin-filter"),
      list: $("builtin-list"),
      syncButton: $("sync-builtin"),
      status: $("builtin-status"),
      resolve: () =>
        Array.isArray(cfg.builtinKeywords) ? cfg.builtinKeywords : builtinKeywords
    },
    community: {
      label: "社区词库",
      block: $("community-source"),
      toggle: $("use-community"),
      count: $("community-count"),
      details: $("community-details"),
      filter: $("community-filter"),
      list: $("community-list"),
      syncButton: $("sync-community"),
      status: $("community-status"),
      resolve: () => (Array.isArray(cfg.communityKeywords) ? cfg.communityKeywords : [])
    }
  };

  let cfg = { ...DEFAULTS };
  let saveTimer = 0;
  const syncing = new Set();
  const savedTimers = new WeakMap();

  // ==================== 读写 ====================

  /** 归一化相关的开关；白名单比对必须跟着它们走。 */
  function matchFlags() {
    return {
      caseSensitive: el.caseSensitive.checked,
      ignoreSpaces: el.ignoreSpaces.checked
    };
  }

  function whitelistIndex() {
    return globalThis.XSF_buildWhitelistIndex(
      parseKeywords(el.whitelist.value),
      matchFlags()
    );
  }

  function collect() {
    return {
      enabled: el.enabled.checked,
      mode: el.modeHide.checked ? "hide" : "dim",
      opacity: Number(el.opacity.value),
      useBuiltin: SOURCES.builtin.toggle.checked,
      // 两份词库是只读的，面板不产生改动，原样带回去
      builtinKeywords: Array.isArray(cfg.builtinKeywords) ? cfg.builtinKeywords : null,
      useCommunity: SOURCES.community.toggle.checked,
      communityKeywords: Array.isArray(cfg.communityKeywords) ? cfg.communityKeywords : null,
      communitySyncedAt: cfg.communitySyncedAt || 0,
      userKeywords: parseKeywords(el.userKeywords.value),
      whitelist: parseKeywords(el.whitelist.value),
      highlightHit: el.highlightHit.checked,
      matchNames: el.matchNames.checked,
      ignoreSpaces: el.ignoreSpaces.checked,
      caseSensitive: el.caseSensitive.checked
    };
  }

  function flash(node) {
    if (!node) return;
    node.classList.add("show");
    clearTimeout(savedTimers.get(node));
    savedTimers.set(node, setTimeout(() => node.classList.remove("show"), 1200));
  }

  function save(node) {
    cfg = collect();
    chrome.storage.local.set({ config: cfg }, () => flash(node));
  }

  function saveSoon(node) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(node), 400);
  }

  // ==================== 渲染 ====================

  function renderPreview() {
    const hide = el.modeHide.checked;
    el.previewRow.classList.toggle("gone", hide);
    el.previewRow.style.opacity = hide
      ? "1"
      : String((100 - Number(el.opacity.value)) / 100);
  }

  function renderMode() {
    el.opacityRow.hidden = el.modeHide.checked;
    el.opacityVal.textContent = el.opacity.value + "%";
    renderPreview();
  }

  function renderEnabled() {
    el.body.classList.toggle("on", el.enabled.checked);
    el.status.textContent = el.enabled.checked
      ? "仅在推文详情页过滤回复"
      : "已关闭，所有回复正常显示";
  }

  // ==================== 词库逐条列表 ====================

  function buildRow(keyword, whitelisted) {
    const row = document.createElement("div");
    row.className = whitelisted ? "kw-row wl" : "kw-row";
    row.dataset.kw = keyword;

    const text = document.createElement("span");
    text.className = "kw-text";
    text.textContent = keyword;
    // 正则那种长字符串会被省略号截断，鼠标悬停看全文
    text.title = keyword;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "kw-btn";
    button.textContent = whitelisted ? "撤销" : "白名单";
    button.title = whitelisted
      ? "从白名单移除，这条词重新生效"
      : "加入白名单，这条词不再生效";

    row.append(text, button);
    return row;
  }

  /**
   * 列表懒渲染：两份词库合起来七百多条，全渲染成 DOM 会拖慢弹窗打开速度，
   * 所以只在 <details> 展开时才建行。
   */
  function renderList(key) {
    const source = SOURCES[key];
    const list = source.resolve();
    source.count.textContent = String(list.length);
    if (!source.details.open) return;

    const flags = matchFlags();
    const term = source.filter.value.trim().toLowerCase();
    // 上游词里夹着零宽字符（「求主␣人」这种），所以归一化后再比一次，
    // 否则用户按看到的字搜索反而搜不到那几条
    const normTerm = term && globalThis.XSF_normalizeKeyword(term, flags);
    const whitelist = whitelistIndex();
    const frag = document.createDocumentFragment();
    let shown = 0;

    for (const keyword of list) {
      if (term &&
        !keyword.toLowerCase().includes(term) &&
        !globalThis.XSF_normalizeKeyword(keyword, flags).includes(normTerm)) continue;
      frag.appendChild(buildRow(keyword, whitelist.has(keyword)));
      shown++;
    }

    if (!shown) {
      const empty = document.createElement("p");
      empty.className = "kw-empty";
      empty.textContent = list.length
        ? "没有匹配的词"
        : key === "community"
          ? "还没有同步过，点上面的「同步」获取"
          : "词库是空的";
      frag.appendChild(empty);
    }

    source.list.replaceChildren(frag);
  }

  /** 白名单变了：已经建好的行只改状态，不整份重建。 */
  function refreshRowStates() {
    const whitelist = whitelistIndex();
    for (const key of Object.keys(SOURCES)) {
      const rows = SOURCES[key].list.querySelectorAll(".kw-row");
      for (const row of rows) {
        const on = whitelist.has(row.dataset.kw);
        row.classList.toggle("wl", on);
        const button = row.querySelector(".kw-btn");
        button.textContent = on ? "撤销" : "白名单";
        button.title = on
          ? "从白名单移除，这条词重新生效"
          : "加入白名单，这条词不再生效";
      }
    }
  }

  function renderWhitelistCount() {
    el.whitelistCount.textContent = String(parseKeywords(el.whitelist.value).length);
  }

  /** 点行尾按钮：加进白名单，或者撤销。 */
  function toggleWhitelist(keyword) {
    const flags = matchFlags();
    const current = parseKeywords(el.whitelist.value);
    const on = globalThis.XSF_buildWhitelistIndex(current, flags).has(keyword);

    const next = on
      ? current.filter((item) => !globalThis.XSF_sameKeyword(item, keyword, flags))
      : [...current, keyword];

    el.whitelist.value = next.join("\n");
    renderWhitelistCount();
    refreshRowStates();
    save(el.whitelistSaved);
  }

  function renderSource(key) {
    SOURCES[key].block.classList.toggle("off", !SOURCES[key].toggle.checked);
    renderList(key);
  }

  // ==================== 同步 ====================

  function showStatus(key, message, type = "") {
    const node = SOURCES[key].status;
    node.textContent = message;
    node.className = `sync-status ${type}`.trim();
    node.hidden = !message;
  }

  /** 社区词库是联网取的，把「多久没同步」摆在明面上，别让用户对着一份陈词库瞎猜。 */
  function renderCommunityFreshness() {
    const syncedAt = Number(cfg.communitySyncedAt) || 0;

    if (!syncedAt) {
      showStatus(
        "community",
        SOURCES.community.resolve().length ? "" : "还没有同步过，点右边的「同步」获取"
      );
      return;
    }

    const days = Math.floor((Date.now() - syncedAt) / DAY_MS);
    const when = days <= 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
    showStatus(
      "community",
      days >= STALE_DAYS ? `上次同步：${when}，可以再同步一次` : `上次同步：${when}`
    );
  }

  async function syncSource(key, { auto = false } = {}) {
    if (syncing.has(key)) return;
    const source = SOURCES[key];
    syncing.add(key);
    clearTimeout(saveTimer);
    source.syncButton.disabled = true;
    source.syncButton.classList.add("syncing");
    showStatus(key, auto ? `首次使用，正在获取${source.label}...` : "正在从 GitHub 同步...");

    try {
      const keywords = await globalThis.XSF_fetchKeywordSource(key);
      const nextConfig = { ...collect() };
      if (key === "community") {
        nextConfig.communityKeywords = keywords;
        nextConfig.communitySyncedAt = Date.now();
      } else {
        nextConfig.builtinKeywords = keywords;
      }
      await chrome.storage.local.set({ config: nextConfig });

      cfg = nextConfig;
      renderList(key);
      showStatus(key, `同步成功，共 ${keywords.length} 条规则`, "success");
    } catch (error) {
      console.error(`[XSF] ${source.label}同步失败:`, error);
      const reason = error instanceof Error ? error.message : "未知错误";
      showStatus(key, `同步失败：${reason}。现有词库未更改`, "error");
    } finally {
      syncing.delete(key);
      source.syncButton.disabled = false;
      source.syncButton.classList.remove("syncing");
    }
  }

  function fill(config) {
    cfg = { ...DEFAULTS, ...config };
    el.enabled.checked = cfg.enabled !== false;
    el.modeDim.checked = cfg.mode !== "hide";
    el.modeHide.checked = cfg.mode === "hide";
    el.opacity.value = String(cfg.opacity);
    SOURCES.builtin.toggle.checked = cfg.useBuiltin !== false;
    SOURCES.community.toggle.checked = cfg.useCommunity !== false;
    el.highlightHit.checked = cfg.highlightHit !== false;
    el.matchNames.checked = cfg.matchNames !== false;
    el.ignoreSpaces.checked = cfg.ignoreSpaces !== false;
    el.caseSensitive.checked = cfg.caseSensitive === true;
    el.userKeywords.value = (cfg.userKeywords || []).join("\n");
    el.whitelist.value = (cfg.whitelist || []).join("\n");
    renderWhitelistCount();
    renderSource("builtin");
    renderSource("community");
    renderCommunityFreshness();
    renderEnabled();
    renderMode();
  }

  // ==================== 恢复默认（带确认） ====================

  function openConfirm() {
    el.confirmUserCount.textContent = String(parseKeywords(el.userKeywords.value).length);
    el.confirmWlCount.textContent = String(parseKeywords(el.whitelist.value).length);
    el.confirm.hidden = false;
    el.confirmCancel.focus();
  }

  function closeConfirm() {
    el.confirm.hidden = true;
    el.reset.focus();
  }

  /**
   * 恢复出厂设置：两份词库都回到上游原样（社区词库清空后立刻重新拉一次），
   * 但「我的关键词」和「白名单」原样保留 —— 那两份是用户自己的东西。
   */
  function doReset() {
    const keepUser = parseKeywords(el.userKeywords.value);
    const keepWhitelist = parseKeywords(el.whitelist.value);
    fill({
      ...DEFAULTS,
      builtinKeywords: null,
      userKeywords: keepUser,
      whitelist: keepWhitelist
    });
    save(el.saved);
    closeConfirm();
    syncSource("community", { auto: true });
  }

  // ==================== 当前标签页的过滤条数 ====================

  async function loadCount() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) return;
      const text = await chrome.action.getBadgeText({ tabId: tab.id });
      const n = parseInt(text, 10);
      el.count.textContent = `本页已过滤 ${Number.isFinite(n) ? n : 0} 条`;
    } catch {
      // 没有可访问的标签页，保持默认文案
    }
  }

  // ==================== 事件 ====================

  function bind() {
    el.enabled.addEventListener("change", () => {
      renderEnabled();
      save();
    });

    for (const radio of [el.modeDim, el.modeHide]) {
      radio.addEventListener("change", () => {
        renderMode();
        save();
      });
    }

    // 拖动过程中实时预览 + 实时写入，页面上的效果跟着一起变
    el.opacity.addEventListener("input", () => {
      el.opacityVal.textContent = el.opacity.value + "%";
      renderPreview();
      saveSoon();
    });

    // 这两个开关会改变归一化方式，白名单的比对结果跟着变
    for (const box of [el.ignoreSpaces, el.caseSensitive]) {
      box.addEventListener("change", () => {
        refreshRowStates();
        save();
      });
    }
    // 纯显示开关：不影响匹配，也不影响白名单比对
    el.highlightHit.addEventListener("change", () => save());
    el.matchNames.addEventListener("change", () => save());

    el.userKeywords.addEventListener("input", () => saveSoon(el.saved));
    el.userKeywords.addEventListener("blur", () => save(el.saved));

    el.whitelist.addEventListener("input", () => {
      renderWhitelistCount();
      refreshRowStates();
      saveSoon(el.whitelistSaved);
    });
    el.whitelist.addEventListener("blur", () => save(el.whitelistSaved));

    for (const key of Object.keys(SOURCES)) {
      const source = SOURCES[key];
      source.toggle.addEventListener("change", () => {
        source.block.classList.toggle("off", !source.toggle.checked);
        save();
      });
      source.syncButton.addEventListener("click", () => syncSource(key));
      // 展开时才建行；折叠后清空，省内存也避免下次展开看到旧状态
      source.details.addEventListener("toggle", () => {
        if (source.details.open) renderList(key);
        else source.list.replaceChildren();
      });
      source.filter.addEventListener("input", () => renderList(key));
      source.list.addEventListener("click", (e) => {
        const button = e.target.closest(".kw-btn");
        if (!button) return;
        const row = button.closest(".kw-row");
        if (row) toggleWhitelist(row.dataset.kw);
      });
    }

    el.reset.addEventListener("click", openConfirm);
    el.confirmCancel.addEventListener("click", closeConfirm);
    el.confirmOk.addEventListener("click", doReset);
    // 点遮罩关闭；Esc 也关闭
    el.confirm.addEventListener("click", (e) => {
      if (e.target === el.confirm) closeConfirm();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.confirm.hidden) closeConfirm();
    });
  }

  // ==================== 启动 ====================

  async function init() {
    try {
      builtinKeywords = await globalThis.XSF_loadBuiltinKeywords();
    } catch (error) {
      console.error("[XSF] 内置词库加载失败:", error);
      showStatus("builtin", "keywords.txt 加载失败，请重新打开设置", "error");
    }

    chrome.storage.local.get("config", (result) => {
      fill(result && result.config);
      bind();
      loadCount();

      // 社区词库不随扩展打包。一次都没拿到过就自动补一次；
      // 之后只提示「多久没同步」，不去动本地那份快照。
      if (!Array.isArray(cfg.communityKeywords)) {
        syncSource("community", { auto: true });
      }
    });
  }

  init();
})();
