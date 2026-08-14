/**
 * 共享常量 —— 同时被 content script / service worker / popup 引用。
 *
 * 三处运行环境不同（隔离世界 / worker / 扩展页面），所以统一挂到 globalThis，
 * 而不是依赖脚本间的词法作用域共享。
 */

/** 默认配置。storage.local 里以单个 key "config" 存整份配置。 */
globalThis.XSF_DEFAULTS = {
  enabled: true,
  /** "dim" = 整条回复变透明；"hide" = 整条回复消失。二选一。 */
  mode: "dim",
  /** 用户感知的「透明度」：0 = 和原来一样，100 = 完全看不见。 */
  opacity: 85,
  /** 是否启用内置词库。 */
  useBuiltin: true,
  /**
   * 内置词库的本地副本。null = 用出厂列表（这样以后升级插件能拿到新词）；
   * 手动同步过就存成数组。「恢复默认设置」会把它重新置为 null。
   */
  builtinKeywords: null,
  /** 是否启用社区词库（上游 x-comment-blocker 维护的那份）。 */
  useCommunity: true,
  /**
   * 社区词库的本地快照。它不随扩展打包，只能联网取，
   * 所以 null = 还没同步过（安装时和打开设置时会自动补一次）。
   */
  communityKeywords: null,
  /** 社区词库上次同步成功的时间戳（ms）。0 = 从未成功同步。 */
  communitySyncedAt: 0,
  /** 用户自定义关键词（每行一个；用 /.../ 包裹表示正则）。 */
  userKeywords: [],
  /**
   * 白名单：列在这里的规则一律不参与匹配。
   * 两份词库都是只读的（同步会覆盖），所以「误伤」只能靠这里减词，
   * 而不是去改词库本身。「恢复默认设置」不会动它。
   */
  whitelist: [],
  /**
   * 「变透明」模式下，把命中的那条词在原文里红色高亮（正文、昵称、@用户名都标），
   * 鼠标移上去还能一键把它加进白名单。排查误伤全靠它。
   */
  highlightHit: true,
  /** 除正文外，是否也匹配昵称与 @用户名。 */
  matchNames: true,
  /** 匹配前去掉空白与零宽字符，破解「同 城 约」这类拆字规避。 */
  ignoreSpaces: true,
  /** 区分大小写（仅影响英文关键词）。 */
  caseSensitive: false
};

/**
 * 同一批字符的「正则源码」形态。content script 用它拼宽松正则
 * （关键词的字与字之间允许夹这些字符），所以必须和下面那个正则保持一致。
 */
globalThis.XSF_IGNORABLE_SRC =
  "[\\s\\u00ad\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]*";

/** 各类零宽 / 方向控制字符，外加真正的空白。 */
globalThis.XSF_SPACE_AND_INVISIBLE_RE =
  /[\s\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]+/g;

/** `/正则/flags` 写法？命中时返回 match 数组（[1] = 正则体，[2] = flags）。 */
globalThis.XSF_asRegex = function (keyword) {
  return String(keyword || "").match(/^\/(.+)\/([a-zA-Z]*)$/);
};

/**
 * 普通关键词与正文的归一化。
 *
 * content script 拿它判定命中，设置面板拿它判断某条词是否已在白名单里 ——
 * 必须是同一套规则，否则面板上显示「已白名单」而实际还在拦，用户会疯。
 */
globalThis.XSF_normalizeKeyword = function (text, config) {
  let t = String(text || "");
  if (!config || !config.caseSensitive) t = t.toLowerCase();
  if (!config || config.ignoreSpaces !== false) {
    t = t.replace(globalThis.XSF_SPACE_AND_INVISIBLE_RE, "");
  }
  return t;
};

/** 两条规则是不是同一条（正则比原文，普通词比归一化结果）。 */
globalThis.XSF_sameKeyword = function (a, b, config) {
  const aRegex = globalThis.XSF_asRegex(a);
  const bRegex = globalThis.XSF_asRegex(b);
  if (aRegex || bRegex) return String(a).trim() === String(b).trim();
  return globalThis.XSF_normalizeKeyword(a, config) ===
    globalThis.XSF_normalizeKeyword(b, config);
};

/**
 * 把白名单拆成两个查找集合：普通词按归一化后的形式存，正则按原文存。
 * 词库有七百多条，逐条 includes() 太慢，所以先建 Set。
 */
globalThis.XSF_buildWhitelistIndex = function (whitelist, config) {
  const plain = new Set();
  const regex = new Set();

  for (const item of whitelist || []) {
    const keyword = String(item || "").trim();
    if (!keyword) continue;
    if (globalThis.XSF_asRegex(keyword)) {
      regex.add(keyword);
      continue;
    }
    const normalized = globalThis.XSF_normalizeKeyword(keyword, config);
    if (normalized) plain.add(normalized);
  }

  return {
    size: plain.size + regex.size,
    has(keyword) {
      const kw = String(keyword || "").trim();
      if (!kw) return false;
      return globalThis.XSF_asRegex(kw)
        ? regex.has(kw)
        : plain.has(globalThis.XSF_normalizeKeyword(kw, config));
    }
  };
};

/** 把每行一个的词库文本转成去重后的规则列表。 */
globalThis.XSF_parseKeywordText = function (text) {
  const keywords = [];
  const seen = new Set();

  for (const line of String(text || "").split(/\r?\n/)) {
    const keyword = line.trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }

  return keywords;
};

/** 从扩展包根目录的 keywords.txt 读取出厂词库。 */
let builtinKeywordsPromise = null;
globalThis.XSF_loadBuiltinKeywords = function () {
  builtinKeywordsPromise ||= fetch(chrome.runtime.getURL("keywords.txt"), {
    cache: "no-store"
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`无法读取 keywords.txt: HTTP ${response.status}`);
    }
    return response.text();
  }).then(globalThis.XSF_parseKeywordText);

  return builtinKeywordsPromise;
};

/**
 * 两份可同步的远端词库。
 *
 *  - builtin：本扩展自己维护的那份，扩展包里已经带了一份出厂副本；
 *  - community：上游开源项目 x-comment-blocker 的词库，只能联网取。
 *
 * 两份都按「只读快照」对待：各自单独开关、单独同步，匹配时合并去重。
 * 想去掉其中某条词，用白名单，不要改快照 —— 下次同步会覆盖掉。
 */
globalThis.XSF_KEYWORD_SOURCES = {
  builtin: {
    label: "内置词库",
    url: "https://raw.githubusercontent.com/ZPVIP/x-spam-filter/main/keywords.txt"
  },
  community: {
    label: "社区词库",
    url: "https://raw.githubusercontent.com/amahteru/x-comment-blocker/refs/heads/main/keywords.txt"
  }
};

/** 下载并校验某个远端词库。失败时抛错，由调用方保留原有本地词库。 */
globalThis.XSF_fetchKeywordSource = async function (key) {
  const source = globalThis.XSF_KEYWORD_SOURCES[key];
  if (!source) throw new Error(`未知词库来源: ${key}`);

  const response = await fetch(source.url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`${source.label}请求失败: HTTP ${response.status}`);
  }

  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) {
    throw new Error(`${source.label}超过 2 MB，已拒绝导入`);
  }
  if (/^\s*<(?:!doctype|html)\b/i.test(text)) {
    throw new Error("远端地址返回了 HTML，而不是 keywords.txt");
  }

  const keywords = globalThis.XSF_parseKeywordText(text);
  if (keywords.length === 0) {
    throw new Error(`${source.label}为空`);
  }

  return keywords;
};
