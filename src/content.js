/**
 * X Spam Filter —— content script
 *
 * 设计要点（也是和「轮询 + 逐词正则」类插件的主要区别）：
 *
 *  1. 不轮询。用 MutationObserver 监听新插入的 article，只处理新增/变化的节点，
 *     在 requestAnimationFrame 里批量处理，滚动加载再多回复也是增量成本。
 *  2. 所有关键词合并成少量「大正则」（分片，每片 ≤ 400 词），一次 exec 完成匹配，
 *     而不是每条回复循环几百个正则。词库涨到上万条，单条回复的匹配次数依然是常数级。
 *  3. 判定结果缓存在 WeakMap 里（键是 article 元素，随 DOM 回收自动释放，不会内存泄漏），
 *     用「正文+昵称」签名判断内容是否变过，没变就直接跳过。
 *  4. 视觉效果全部靠 <html> 上的 data-xsf-mode 属性 + 一个 CSS 变量驱动。
 *     改透明度 / 切模式时不需要遍历、不需要重新扫描，更不需要刷新页面。
 *  5. 全程不调用任何 X 的 API，不屏蔽账号，不写 cookie，不 location.reload()。
 */
(() => {
  "use strict";

  const ARTICLE_SEL = 'article[data-testid="tweet"]';
  const CELL_SEL = 'div[data-testid="cellInnerDiv"]';
  const TEXT_SEL = '[data-testid="tweetText"]';
  const NAME_SEL = '[data-testid="User-Name"]';

  const HIT_CLASS = "xsf-filtered";
  /** 缓存签名里拼接各字段用的分隔符，正文里不可能出现。 */
  const SEP = "\u001f";
  const HIT_ATTR = "data-xsf-keyword";
  const MODE_ATTR = "data-xsf-mode";
  const INVISIBLE_ATTR = "data-xsf-invisible";
  const OPACITY_VAR = "--xsf-opacity";

  /** 单个合并正则最多塞多少关键词。太大编译慢，太小片数多。 */
  const CHUNK_SIZE = 400;
  /** 一次 MutationObserver 回调里超过这个数量的记录，直接退化成全量扫描。 */
  const MUTATION_BURST = 800;
  /** SPA 换页后 X 是异步渲染的，按这些延迟补扫几次。 */
  const RESCAN_DELAYS = [0, 250, 800, 1800, 3500];

  const DEFAULTS = globalThis.XSF_DEFAULTS;
  let builtinKeywords = [];

  /** 各类零宽 / 方向控制字符。正则匹配时保留真正的空白和换行。 */
  const INVISIBLE_RE = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]+/g;
  const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

  let cfg = { ...DEFAULTS };

  /** 普通关键词合并成的大正则（分片）。 */
  let plainMatchers = [];
  /** 用户写的 /正则/。 */
  let customMatchers = [];
  let keywordCount = 0;

  /** 当前 URL 是不是推文详情页。只有详情页才过滤。 */
  let active = false;
  /** 配置变更时自增，让 WeakMap 里的旧判定结果失效。 */
  let generation = 0;

  const state = new WeakMap(); // article -> { sig, hit }
  const pending = new Set();
  let flushScheduled = false;
  let rafId = 0;
  let flushTimer = 0;
  let observer = null;
  let lastUrl = location.href;
  const rescanTimers = [];
  let badgeTimer = 0;
  let lastBadge = -1;

  // ==================== 关键词 ====================

  /** 归一化规则放在 shared.js，设置面板判断「是否已在白名单」时用的是同一套。 */
  function normalizePlain(str) {
    return globalThis.XSF_normalizeKeyword(str, cfg);
  }

  function escapeRegExp(str) {
    return str.replace(REGEX_ESCAPE_RE, "\\$&");
  }

  /** 内置词库：同步过就用那份快照，没同步过用出厂列表。 */
  function resolveBuiltin() {
    return Array.isArray(cfg.builtinKeywords) ? cfg.builtinKeywords : builtinKeywords;
  }

  /** 社区词库：没有出厂副本，没同步过就是空的。 */
  function resolveCommunity() {
    return Array.isArray(cfg.communityKeywords) ? cfg.communityKeywords : [];
  }

  /**
   * 把「内置词 + 社区词 + 用户词」编译成匹配器，白名单里的词直接跳过。
   * 三份列表里的重复词在下面统一去重，仅在配置变化时调用一次，不在扫描热路径上。
   */
  function buildMatchers() {
    const raw = [];
    if (cfg.useBuiltin) raw.push(...resolveBuiltin());
    if (cfg.useCommunity) raw.push(...resolveCommunity());
    if (Array.isArray(cfg.userKeywords)) raw.push(...cfg.userKeywords);

    // 两份词库是只读快照，误伤只能靠白名单减词，所以它对三份来源一律生效。
    const whitelist = globalThis.XSF_buildWhitelistIndex(cfg.whitelist, cfg);

    const plain = [];
    const seenPlain = new Set();
    const seenRegex = new Set();
    customMatchers = [];

    for (const item of raw) {
      const kw = String(item || "").trim();
      if (!kw || whitelist.has(kw)) continue;

      // /正则/flags：保留正则自己的大小写和空白语义，移除有状态的 g/y。
      const asRegex = globalThis.XSF_asRegex(kw);
      if (asRegex) {
        if (seenRegex.has(kw)) continue;
        try {
          const flags = asRegex[2].replace(/[gy]/gi, "");
          customMatchers.push({ source: kw, re: new RegExp(asRegex[1], flags) });
          seenRegex.add(kw);
        } catch {
          console.warn("[XSF] 忽略无效正则:", kw);
        }
        continue;
      }

      const n = normalizePlain(kw);
      if (!n || seenPlain.has(n)) continue;
      seenPlain.add(n);
      plain.push(n);
    }

    // 长词优先，命中时报告的是最具体的那个词
    plain.sort((a, b) => b.length - a.length);

    plainMatchers = [];
    for (let i = 0; i < plain.length; i += CHUNK_SIZE) {
      const pattern = plain.slice(i, i + CHUNK_SIZE).map(escapeRegExp).join("|");
      plainMatchers.push(new RegExp(pattern));
    }
    keywordCount = plain.length + customMatchers.length;
  }

  /** 返回命中的关键词字符串，没命中返回 null。 */
  function matchAny(text) {
    if (!text) return null;
    const plainText = normalizePlain(text);

    if (plainText) {
      for (const re of plainMatchers) {
        const match = re.exec(plainText);
        if (match) return match[0];
      }
    }

    const regexText = text.replace(INVISIBLE_RE, "");
    for (const c of customMatchers) {
      if (c.re.test(regexText)) return c.source;
    }
    return null;
  }

  // ==================== DOM 读取 ====================

  /** 按 DOM 顺序读取文本、换行和图片 alt，让多行正则与 emoji 规则可以准确匹配。 */
  function readText(el) {
    if (!el) return "";

    let text = "";
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );
    let node = walker.currentNode;

    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || "";
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (["br", "div", "p"].includes(tagName)) {
          if (text && !text.endsWith("\n")) text += "\n";
        } else if (tagName === "img") {
          text += node.getAttribute("alt") || "";
        }
      }
      node = walker.nextNode();
    }

    return text;
  }

  function currentStatusId() {
    const m = location.pathname.match(/^\/[^/]+\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function isStatusPage() {
    return currentStatusId() !== null;
  }

  /**
   * 主楼（用户点进来的那条推文）不参与过滤 —— 只过滤回复。
   * 主楼里的时间戳 / 互动数链接都指向当前 URL 的 status id；
   * 兜底再认一次「页面上第一条 article」。
   */
  function isMainTweet(article) {
    const id = currentStatusId();
    if (id) {
      const links = article.querySelectorAll('a[href*="/status/"]');
      for (const a of links) {
        const m = (a.getAttribute("href") || "").match(/\/status\/(\d+)/);
        if (m && m[1] === id) return true;
      }
    }
    return article === document.querySelector(ARTICLE_SEL);
  }

  // ==================== 标记与样式 ====================

  /** 整条回复的外层容器；X 的时间线每一行是一个 cellInnerDiv。 */
  function rowOf(article) {
    return article.closest(CELL_SEL) || article;
  }

  function applyMark(article, hit) {
    const row = rowOf(article);
    if (hit) {
      row.classList.add(HIT_CLASS);
      row.setAttribute(HIT_ATTR, hit);
    } else if (row.classList.contains(HIT_CLASS)) {
      row.classList.remove(HIT_CLASS);
      row.removeAttribute(HIT_ATTR);
    }
  }

  function clearAllMarks() {
    const marked = document.querySelectorAll("." + HIT_CLASS);
    for (const el of marked) {
      el.classList.remove(HIT_CLASS);
      el.removeAttribute(HIT_ATTR);
    }
  }

  /**
   * 效果开关：只动 <html> 上的一个属性和一个 CSS 变量。
   * 用户拖动透明度滑块时，页面里成百上千条已标记的回复会同时更新，零 DOM 遍历。
   */
  function applyStyleVars() {
    const root = document.documentElement;
    if (!cfg.enabled || !active) {
      root.removeAttribute(MODE_ATTR);
      root.removeAttribute(INVISIBLE_ATTR);
      return;
    }
    root.setAttribute(MODE_ATTR, cfg.mode === "hide" ? "hide" : "dim");
    const level = Math.max(0, Math.min(100, Number(cfg.opacity) || 0));
    root.style.setProperty(OPACITY_VAR, String((100 - level) / 100));
    if (level >= 100) root.setAttribute(INVISIBLE_ATTR, "1");
    else root.removeAttribute(INVISIBLE_ATTR);
  }

  // ==================== 判定 ====================

  function evaluate(article) {
    const text = readText(article.querySelector(TEXT_SEL));
    const name = cfg.matchNames ? readText(article.querySelector(NAME_SEL)) : "";
    const sig = [generation, text, name].join(SEP);

    const cached = state.get(article);
    if (cached && cached.sig === sig) return;

    let hit = null;
    if (keywordCount > 0 && !isMainTweet(article)) {
      hit = matchAny(text) || (name ? matchAny(name) : null);
    }

    state.set(article, { sig, hit });
    applyMark(article, hit);
  }

  function flush() {
    if (!active || !cfg.enabled) {
      pending.clear();
      return;
    }
    for (const article of pending) {
      if (article.isConnected) evaluate(article);
    }
    pending.clear();
    scheduleBadge();
  }

  function runFlush() {
    if (!flushScheduled) return;
    flushScheduled = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (flushTimer) clearTimeout(flushTimer);
    rafId = 0;
    flushTimer = 0;
    flush();
  }

  /**
   * 批处理：优先跟着渲染帧走（视觉上无闪烁），
   * 但后台标签页里 rAF 是暂停的，所以再挂一个定时器兜底，避免队列无限堆积。
   */
  function schedule() {
    if (flushScheduled) return;
    flushScheduled = true;
    rafId = requestAnimationFrame(runFlush);
    flushTimer = setTimeout(runFlush, 300);
  }

  function queueArticle(node) {
    if (node.nodeType !== 1) return;
    if (node.matches && node.matches(ARTICLE_SEL)) {
      pending.add(node);
      return;
    }
    if (!node.querySelectorAll) return;
    const found = node.querySelectorAll(ARTICLE_SEL);
    for (const a of found) pending.add(a);
  }

  function fullScan() {
    if (!active || !cfg.enabled) return;
    const articles = document.querySelectorAll(ARTICLE_SEL);
    for (const a of articles) pending.add(a);
    schedule();
  }

  // ==================== 增量监听（滚动加载新回复） ====================

  function onMutations(records) {
    if (!active || !cfg.enabled) return;

    // X 有时会一次性重排一大片 DOM，逐条 closest() 反而更贵 —— 直接全量扫。
    if (records.length > MUTATION_BURST) {
      fullScan();
      return;
    }

    for (const rec of records) {
      for (const node of rec.addedNodes) queueArticle(node);

      // 已存在的 article 内部被 React 改了内容（例如翻译、展开长文）
      const target = rec.target;
      if (target && target.nodeType === 1 && target.closest) {
        const article = target.closest(ARTICLE_SEL);
        if (article) pending.add(article);
      }
    }

    if (pending.size) schedule();
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    // 只观察 childList：我们自己只改 class/属性，不会触发回调，天然无反馈循环。
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  // ==================== 徽标计数 ====================

  function scheduleBadge() {
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = 0;
      const count = active && cfg.enabled
        ? document.querySelectorAll("." + HIT_CLASS).length
        : 0;
      if (count === lastBadge) return;
      lastBadge = count;
      try {
        chrome.runtime.sendMessage({ type: "XSF_COUNT", count });
      } catch {
        // service worker 正在重启 / 扩展被重载，忽略
      }
    }, 400);
  }

  // ==================== 生命周期 ====================

  function clearRescanTimers() {
    while (rescanTimers.length) clearTimeout(rescanTimers.pop());
  }

  function scheduleRescans() {
    clearRescanTimers();
    for (const delay of RESCAN_DELAYS) {
      rescanTimers.push(setTimeout(fullScan, delay));
    }
  }

  function start() {
    startObserving();
    applyStyleVars();
    scheduleRescans();
  }

  function stop() {
    clearRescanTimers();
    stopObserving();
    pending.clear();
    clearAllMarks();
    applyStyleVars();
    scheduleBadge();
  }

  function refresh({ rebuild = false } = {}) {
    if (rebuild) buildMatchers();
    generation++;
    active = isStatusPage();

    if (!cfg.enabled || !active) {
      stop();
      return;
    }
    clearAllMarks();
    start();
  }

  /**
   * SPA 换页。注意：绝不 location.reload() —— X 一旦刷新，浏览器后退按钮
   * 就回不到之前的时间线位置了。这里只是重新判定 + 重扫。
   */
  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    refresh();
  }

  function hookHistory() {
    const wrap = (name) => {
      const original = history[name];
      if (typeof original !== "function") return;
      history[name] = function (...args) {
        const result = original.apply(this, args);
        // pushState/replaceState 不触发 popstate，必须自己通知
        queueMicrotask(onUrlChange);
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", onUrlChange);
    // 兜底：X 偶尔会绕过上面两个入口，1.5s 一次的字符串比较开销可以忽略
    setInterval(onUrlChange, 1500);
  }

  // ==================== 配置 ====================

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get("config", (result) => {
        cfg = { ...DEFAULTS, ...(result && result.config) };
        resolve();
      });
    });
  }

  /** 影响「命中与否」的设置；其余（mode / opacity）纯粹是显示效果。 */
  const MATCH_KEYS = [
    "enabled", "useBuiltin", "useCommunity", "matchNames", "ignoreSpaces", "caseSensitive"
  ];
  const MATCH_LIST_KEYS = [
    "userKeywords", "builtinKeywords", "communityKeywords", "whitelist"
  ];

  /** null（沿用出厂词库）和数组要能区分开，所以给 null 一个专属标记。 */
  function listSignature(value) {
    return Array.isArray(value) ? value.join("\n") : "factory" + SEP;
  }

  function matchingChanged(prev, next) {
    for (const key of MATCH_KEYS) {
      if (prev[key] !== next[key]) return true;
    }
    for (const key of MATCH_LIST_KEYS) {
      if (listSignature(prev[key]) !== listSignature(next[key])) return true;
    }
    return false;
  }

  function watchConfig() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.config) return;
      const prev = cfg;
      cfg = { ...DEFAULTS, ...(changes.config.newValue || {}) };

      if (matchingChanged(prev, cfg)) {
        refresh({ rebuild: true });
      } else {
        // 只是换了显示方式 / 拖了透明度滑块 —— 改一个属性就够了，不重新扫描
        applyStyleVars();
      }
    });
  }

  // ==================== 启动 ====================

  async function init() {
    try {
      builtinKeywords = await globalThis.XSF_loadBuiltinKeywords();
    } catch (error) {
      console.error("[XSF] 内置词库加载失败:", error);
    }
    await loadConfig();
    buildMatchers();
    watchConfig();
    hookHistory();

    active = isStatusPage();
    if (cfg.enabled && active) start();
    else applyStyleVars();

    // 标签页从后台切回来时，rAF 期间攒下的节点会被一次性处理；
    // 这里再补一次全量扫描，防止隐藏期间的 DOM 变化被漏掉。
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fullScan();
    });
  }

  init();
})();
