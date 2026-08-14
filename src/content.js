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
  /** 命中的词就地包一层 <mark class="xsf-hl">。 */
  const HL_CLASS = "xsf-hl";
  const HL_SEL = "mark." + HL_CLASS;
  /** 命中范围盖到 emoji（<img alt>）时，图片本身打个 class。 */
  const HL_IMG_CLASS = "xsf-hl-img";
  /** 缓存签名里拼接各字段用的分隔符，正文里不可能出现。 */
  const SEP = "\u001f";
  const HIT_ATTR = "data-xsf-keyword";
  const HL_KW_ATTR = "data-xsf-kw";
  const MODE_ATTR = "data-xsf-mode";
  const INVISIBLE_ATTR = "data-xsf-invisible";
  const HL_ATTR = "data-xsf-hl";
  const OPACITY_VAR = "--xsf-opacity";

  /** 单个合并正则最多塞多少关键词。太大编译慢，太小片数多。 */
  const CHUNK_SIZE = 400;
  /** 一次 MutationObserver 回调里超过这个数量的记录，直接退化成全量扫描。 */
  const MUTATION_BURST = 800;
  /** 单个文本节点里最多高亮这么多处，防御超长正文。 */
  const MAX_MARKS_PER_NODE = 20;
  /** 鼠标离开高亮词后，留这么久让用户把鼠标移进卡片。 */
  const POP_GRACE_MS = 220;
  /** SPA 换页后 X 是异步渲染的，按这些延迟补扫几次。 */
  const RESCAN_DELAYS = [0, 250, 800, 1800, 3500];

  const DEFAULTS = globalThis.XSF_DEFAULTS;
  let builtinKeywords = [];

  /** 各类零宽 / 方向控制字符。正则匹配时保留真正的空白和换行。 */
  const INVISIBLE_RE = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]+/g;
  /** 单个字符是不是零宽/方向控制字符（上面那个带 g，不能拿来做单字符判断）。 */
  const INVISIBLE_ONE_RE =
    /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
  const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

  let cfg = { ...DEFAULTS };

  /** 命中词 -> 宽松正则的缓存；词库重编时一起清掉。 */
  const looseCache = new Map();

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

    // 宽松正则是按 ignoreSpaces / caseSensitive 拼出来的，这两个开关一变就得作废
    looseCache.clear();

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

  // ==================== 命中词的就地高亮 ====================

  /**
   * 把命中的那条词在原文里找出来包成 <mark>。
   *
   * 匹配是在归一化后的文本上做的（小写、去掉空白与零宽字符），而 DOM 里是原文，
   * 两边的下标对不上。所以这里不去做下标映射，而是反过来用关键词造一个「宽松正则」：
   * 每个字之间允许夹任意空白/零宽字符，直接拿它去原文里找 —— 「求主␣人」「同 城」
   * 这类拆字写法照样能定位到。
   */
  function looseRegex(hit) {
    const cached = looseCache.get(hit);
    if (cached !== undefined) return cached;

    let re = null;
    const asRegex = globalThis.XSF_asRegex(hit);
    if (asRegex) {
      // 命中的是 /正则/：直接拿它去原文里找，加上 g 以便找出所有出现的位置
      try {
        re = new RegExp(asRegex[1], asRegex[2].replace(/[gy]/gi, "") + "g");
      } catch {
        re = null;
      }
    } else {
      const joiner = cfg.ignoreSpaces ? globalThis.XSF_IGNORABLE_SRC : "";
      const body = Array.from(hit, (ch) => escapeRegExp(ch)).join(joiner);
      try {
        re = new RegExp(body, cfg.caseSensitive ? "g" : "gi");
      } catch {
        re = null;
      }
    }

    looseCache.set(hit, re);
    return re;
  }

  /**
   * 把一棵子树摊平成「和 readText 完全一致的字符串」+ 每段字符对应的 DOM 位置。
   *
   * 必须摊平了再找，不能逐个文本节点找：X 会把一条正文切成好几个 span，
   * emoji 是 <img alt="🍒">，命中的又可能是 /^…$/ 这种只在整段文本上成立的正则 ——
   * 逐节点找的话这些一个都定位不到。
   */
  function flatten(el) {
    const segments = [];
    let text = "";

    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );
    let node = walker.currentNode;

    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const piece = node.textContent || "";
        if (piece) {
          segments.push({ start: text.length, end: text.length + piece.length, node });
          text += piece;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (["br", "div", "p"].includes(tagName)) {
          // 合成的换行，没有对应的文本节点，只占位
          if (text && !text.endsWith("\n")) {
            segments.push({ start: text.length, end: text.length + 1 });
            text += "\n";
          }
        } else if (tagName === "img") {
          const alt = node.getAttribute("alt") || "";
          if (alt) {
            segments.push({ start: text.length, end: text.length + alt.length, img: node });
            text += alt;
          }
        }
      }
      node = walker.nextNode();
    }

    return { text, segments };
  }

  /** 在摊平后的文本里找出命中的位置，返回 [起, 止) 的列表。 */
  function findRanges(text, hit) {
    const re = looseRegex(hit);
    if (!re || !text) return [];

    const ranges = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }   // 零长匹配，别死循环
      ranges.push([m.index, m.index + m[0].length]);
      if (ranges.length >= MAX_MARKS_PER_NODE) break;
    }
    if (ranges.length || !globalThis.XSF_asRegex(hit)) return ranges;

    // 正则是在「去掉零宽字符」的文本上判定的，原文里可能夹着零宽字符导致对不上。
    // 那就在去掉零宽字符的版本上再找一次，再把下标映射回原文。
    let stripped = "";
    const map = [];
    for (let i = 0; i < text.length; i++) {
      if (INVISIBLE_ONE_RE.test(text[i])) continue;
      map.push(i);
      stripped += text[i];
    }
    if (!stripped || stripped.length === text.length) return ranges;

    re.lastIndex = 0;
    while ((m = re.exec(stripped))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const from = map[m.index];
      const to = map[m.index + m[0].length - 1] + 1;
      if (from !== undefined && to !== undefined) ranges.push([from, to]);
      if (ranges.length >= MAX_MARKS_PER_NODE) break;
    }
    return ranges;
  }

  /** 按命中区间把文本节点切开包 <mark>；命中范围里的 emoji 图片单独打个 class。 */
  function wrapRanges(segments, ranges, hit) {
    const jobs = new Map();
    const images = new Set();

    for (const [from, to] of ranges) {
      for (const seg of segments) {
        if (seg.end <= from || seg.start >= to) continue;
        if (seg.img) { images.add(seg.img); continue; }
        if (!seg.node) continue;                       // 合成的换行，跳过
        const s = Math.max(from, seg.start) - seg.start;
        const e = Math.min(to, seg.end) - seg.start;
        if (e <= s) continue;
        if (!jobs.has(seg.node)) jobs.set(seg.node, []);
        jobs.get(seg.node).push([s, e]);
      }
    }

    let count = 0;
    for (const [node, list] of jobs) {
      if (!node.parentNode) continue;
      if (node.parentElement && node.parentElement.closest(HL_SEL)) continue;
      list.sort((a, b) => a[0] - b[0]);

      let head = node;
      // 从后往前切，前面那些下标才不会失效
      for (let i = list.length - 1; i >= 0; i--) {
        const [s, e] = list[i];
        if (e > head.textContent.length) continue;
        head.splitText(e);                     // head = [0, e)
        const middle = head.splitText(s);      // middle = [s, e)
        const mark = document.createElement("mark");
        mark.className = HL_CLASS;
        mark.setAttribute(HL_KW_ATTR, hit);
        middle.parentNode.insertBefore(mark, middle);
        mark.appendChild(middle);
        count++;
      }
    }

    for (const img of images) {
      img.classList.add(HL_IMG_CLASS);
      img.setAttribute(HL_KW_ATTR, hit);
      count++;
    }
    return count;
  }

  /** 在一棵子树里高亮命中的词，返回加了几处。 */
  function highlightIn(root, hit) {
    if (!root) return 0;
    const { text, segments } = flatten(root);
    if (!text) return 0;
    const ranges = findRanges(text, hit);
    if (!ranges.length) return 0;
    return wrapRanges(segments, ranges, hit);
  }

  /** 把 <mark> 拆掉，文字还原；emoji 上的 class 也去掉。 */
  function unhighlight(root) {
    if (!root || !root.querySelectorAll) return;

    for (const img of root.querySelectorAll("img." + HL_IMG_CLASS)) {
      img.classList.remove(HL_IMG_CLASS);
      img.removeAttribute(HL_KW_ATTR);
    }

    for (const mark of root.querySelectorAll(HL_SEL)) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      // 把相邻的文本节点合回去，否则反复开关会把一段文字切成很多碎片
      parent.normalize();
    }
  }

  /** 只高亮正文、昵称和 @用户名 —— 也就是参与匹配的那几处。 */
  function applyHighlight(article, hit) {
    unhighlight(article);
    if (!hit || cfg.highlightHit === false) return;
    highlightIn(article.querySelector(TEXT_SEL), hit);
    highlightIn(article.querySelector(NAME_SEL), hit);
  }

  /** React 重渲染会把我们插的 <mark> 冲掉，正文没变时也得能补回来。 */
  function highlightMissing(article, hit) {
    return Boolean(hit) && cfg.highlightHit !== false && !article.querySelector(HL_SEL);
  }

  function clearAllMarks() {
    const marked = document.querySelectorAll("." + HIT_CLASS);
    for (const el of marked) {
      el.classList.remove(HIT_CLASS);
      el.removeAttribute(HIT_ATTR);
      unhighlight(el);
    }
    hidePop();
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
      root.removeAttribute(HL_ATTR);
      return;
    }
    root.setAttribute(MODE_ATTR, cfg.mode === "hide" ? "hide" : "dim");
    const level = Math.max(0, Math.min(100, Number(cfg.opacity) || 0));
    root.style.setProperty(OPACITY_VAR, String((100 - level) / 100));
    if (level >= 100) root.setAttribute(INVISIBLE_ATTR, "1");
    else root.removeAttribute(INVISIBLE_ATTR);
    // 这里只控制「悬停恢复原样」那条 CSS；高亮本身是插进 DOM 的 <mark>
    if (cfg.highlightHit !== false) root.setAttribute(HL_ATTR, "1");
    else root.removeAttribute(HL_ATTR);
  }

  // ==================== 判定 ====================

  function evaluate(article) {
    const text = readText(article.querySelector(TEXT_SEL));
    const name = cfg.matchNames ? readText(article.querySelector(NAME_SEL)) : "";
    const sig = [generation, text, name].join(SEP);

    const cached = state.get(article);
    if (cached && cached.sig === sig) {
      // 正文没变，但 React 可能把我们插的 <mark> 重渲染掉了，补回去
      if (highlightMissing(article, cached.hit)) applyHighlight(article, cached.hit);
      return;
    }

    let hit = null;
    if (keywordCount > 0 && !isMainTweet(article)) {
      hit = matchAny(text) || (name ? matchAny(name) : null);
    }

    state.set(article, { sig, hit });
    applyMark(article, hit);
    applyHighlight(article, hit);
  }

  function flush() {
    if (!active || !cfg.enabled) {
      pending.clear();
      return;
    }
    for (const article of pending) {
      if (!article.isConnected) continue;
      // 单条回复出问题不能带着整页一起停掉过滤
      try {
        evaluate(article);
      } catch (error) {
        console.error("[XSF] 处理单条回复失败:", error);
      }
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

  // ==================== 命中词上的悬浮卡片 ====================

  let pop = null;
  let popKeyword = "";
  let popHideTimer = 0;

  function buildPop() {
    const el = document.createElement("div");
    el.className = "xsf-pop";
    el.hidden = true;

    const title = document.createElement("div");
    title.className = "xsf-pop-title";
    title.textContent = "命中的规则";

    const kw = document.createElement("div");
    kw.className = "xsf-pop-kw";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xsf-pop-btn";

    const hint = document.createElement("div");
    hint.className = "xsf-pop-hint";
    hint.textContent = "加进白名单后这条规则不再生效，其它词照旧";

    el.append(title, kw, btn, hint);
    // 挂在 body 上而不是回复里 —— 回复整条是半透明的，卡片放进去就跟着淡掉了
    document.body.appendChild(el);

    btn.addEventListener("click", whitelistCurrent);
    el.addEventListener("mouseenter", () => clearTimeout(popHideTimer));
    el.addEventListener("mouseleave", hidePopSoon);

    pop = { el, kw, btn };
    return pop;
  }

  function ellipsize(text, max) {
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  function showPop(mark) {
    const keyword = mark.getAttribute(HL_KW_ATTR) || "";
    if (!keyword) return;
    const { el, kw, btn } = pop || buildPop();

    popKeyword = keyword;
    kw.textContent = keyword;
    btn.disabled = false;
    btn.textContent = `把「${ellipsize(keyword, 16)}」加入白名单`;
    btn.title = `把 ${keyword} 加入白名单`;

    // 先摆出来才量得到自身尺寸
    el.hidden = false;
    el.style.left = "0px";
    el.style.top = "0px";
    const anchorRect = mark.getBoundingClientRect();
    const popRect = el.getBoundingClientRect();

    const left = Math.min(
      Math.max(8, anchorRect.left + anchorRect.width / 2 - popRect.width / 2),
      window.innerWidth - popRect.width - 8
    );
    // 默认贴在词的上方，上面放不下就翻到下面
    const above = anchorRect.top - popRect.height - 8;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(above >= 8 ? above : anchorRect.bottom + 8)}px`;
  }

  function hidePop() {
    clearTimeout(popHideTimer);
    popHideTimer = 0;
    if (pop) pop.el.hidden = true;
    popKeyword = "";
  }

  function hidePopSoon() {
    clearTimeout(popHideTimer);
    popHideTimer = setTimeout(hidePop, POP_GRACE_MS);
  }

  /** 把当前这条词写进白名单。写完 storage.onChanged 会触发重建 + 重扫，页面自己就恢复了。 */
  function whitelistCurrent() {
    const keyword = popKeyword;
    if (!keyword || !pop) return;

    pop.btn.disabled = true;
    pop.btn.textContent = "正在加入…";

    chrome.storage.local.get("config", (result) => {
      const next = { ...DEFAULTS, ...(result && result.config) };
      const list = Array.isArray(next.whitelist) ? next.whitelist.slice() : [];
      // 判重用的是和匹配、和设置面板同一套归一化规则
      if (!globalThis.XSF_buildWhitelistIndex(list, next).has(keyword)) {
        list.push(keyword);
      }
      chrome.storage.local.set({ config: { ...next, whitelist: list } }, () => {
        if (pop) pop.btn.textContent = "已加入白名单";
        setTimeout(hidePop, 700);
      });
    });
  }

  function hookPop() {
    document.addEventListener("mouseover", (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const mark = target.closest(HL_SEL);
      if (!mark) return;
      clearTimeout(popHideTimer);
      showPop(mark);
    });

    document.addEventListener("mouseout", (e) => {
      const target = e.target;
      if (target instanceof Element && target.closest(HL_SEL)) hidePopSoon();
    });

    // 卡片是 fixed 定位的，页面一滚位置就错了，直接收掉
    window.addEventListener("scroll", hidePop, { passive: true, capture: true });
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
      } else if (prev.highlightHit !== cfg.highlightHit) {
        // 高亮是插在 DOM 里的 <mark>，开关它得重新过一遍页面 —— 但词库不用重编
        refresh();
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
    hookPop();

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
