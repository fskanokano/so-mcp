/**
 * Querit 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：POST https://api.querit.ai/v1/search，Bearer 鉴权。
 * 免费版硬约束（本适配按免费版实现，缺一不可）：
 * - 语言：默认 english，非英文直接抛 UNSUPPORTED_LANGUAGE；
 * - 条数：count 钳制 1..10（统一 maxResults 与原生 count 互认）；
 * - 域名：白名单 include_domains 与黑名单 exclude_domains 各至多 1 个，
 *   超限抛 QUOTA_EXCEEDED；
 * - 限速：每秒 1 次，模块级串行链保证同一进程内请求串行且间隔不小于 1 秒；
 * - 内容：默认不请求正文，只回 url/title/snippet/page_age/page_time，
 *   富格式（图片/正文抓取、include_content）免费版不可用，调用方显式要求亦直接降级为片段。
 * 职责：把 UnifiedSearch 输入映射为 Querit 参数，把结果归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlQuerit 优先）。
const DEFAULT_SEARCH_URL = 'https://api.querit.ai/v1/search';

/** 免费版单次条数上限。 */
const FREE_MAX_COUNT = 10;

/** 免费版白/黑名单各至多站点数（单站点）。 */
const FREE_MAX_DOMAINS = 1;

/** 免费版限速间隔（毫秒）：每秒 1 次。 */
const RATE_LIMIT_INTERVAL_MS = 1000;

/** 免费版唯一可用语言。 */
const FREE_LANGUAGE = 'english';

// 限速串行链：同一进程内请求排队串行，前一起始至少间隔 1 秒后一起始。
/** @type {Promise<void>} */
let throttleTail = Promise.resolve();
/** @type {number} */
let nextStartAt = 0;

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {'flash'|'fast'|'standard'|'deep'} [depth] 检索深度（Querit 无档位，仅透传忽略）
 * @property {'searchResults'|'sourcedAnswer'|'structured'} [outputType] 输出形态（富格式不可用，降级为片段）
 * @property {string} [fromDate] 起始日期（YYYY-MM-DD，双界齐备时拼 date_range）
 * @property {string} [toDate] 结束日期（YYYY-MM-DD，双界齐备时拼 date_range）
 * @property {number} [maxResults] 来源数量上限（钳制 1..10）
 * @property {string[]} [includeDomains] 域名白名单（至多 1 个）
 * @property {string[]} [excludeDomains] 域名黑名单（至多 1 个）
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'querit'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string}>} results 结果列表
 * @property {unknown} [raw] 上游原始响应
 * @property {unknown} [usage] 计费用量（上游透传）
 */

/**
 * 构造携带结构化字段的错误。
 * @param {string} code 错误码
 * @param {string} message 错误信息
 * @param {{status?: number, retryable?: boolean}} [extra] 附加字段
 * @returns {Error & {code: string, status?: number, retryable?: boolean}} 结构化错误
 */
function fail(code, message, extra) {
  const err = /** @type {Error & {code: string, status?: number, retryable?: boolean}} */ (
    new Error(message)
  );
  err.code = code;
  if (extra && extra.status !== undefined) err.status = extra.status;
  if (extra && extra.retryable !== undefined) err.retryable = extra.retryable;
  return err;
}

/**
 * 从 deps 解析 Querit 密钥与搜索地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveQuerit(deps) {
  // 扁平读取，兼容大小写环境变量名，空串视为缺失。
  const apiKey =
    (deps && (deps.queritApiKey || deps.queritKey || deps.QUERIT_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 QUERIT_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.searchUrlQuerit || deps.queritSearchUrl)) || DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 解析语言：缺省 english；显式非英文直接抛 UNSUPPORTED_LANGUAGE。
 * @param {any} params 统一搜索输入（含原生 language/languages）
 * @returns {string[]} 上游 languages（恒为英文单项）
 */
function resolveLanguage(params) {
  const raw = params && (params.languages ?? params.language);
  if (raw === undefined) return [FREE_LANGUAGE];
  const list = Array.isArray(raw) ? raw : [raw];
  const cleaned = list
    .filter((l) => typeof l === 'string' && l.trim())
    .map((l) => l.trim().toLowerCase());
  if (cleaned.length === 0) return [FREE_LANGUAGE];
  const ok = cleaned.every((l) => l === 'english' || l === 'en');
  if (!ok) {
    throw fail('UNSUPPORTED_LANGUAGE', 'Querit 免费版仅支持英文检索（english）', {
      retryable: false,
    });
  }
  return [FREE_LANGUAGE];
}

/**
 * 钳制 count 到 1..10，非法回默认 10。
 * @param {unknown} value 统一 maxResults 或原生 count
 * @returns {number} 钳制后的条数
 */
function clampCount(value) {
  if (!Number.isFinite(value)) return FREE_MAX_COUNT;
  const n = Math.trunc(/** @type {number} */ (value));
  return Math.max(1, Math.min(FREE_MAX_COUNT, n));
}

/**
 * 归一域名列表并执行免费版单站点约束：超限抛 QUOTA_EXCEEDED。
 * @param {unknown} value 数组或逗号串
 * @param {string} kind 白名单/黑名单标识（报错用）
 * @returns {string[]|undefined} 字符串数组，无效时回 undefined
 */
function normalizeSingleDomain(value, kind) {
  /** @type {string[]} */
  let cleaned = [];
  if (Array.isArray(value)) {
    cleaned = value.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim());
  } else if (typeof value === 'string' && value.trim()) {
    // 逗号串拆分为多项，超 1 项即触发配额拦截。
    cleaned = value.split(',').map((d) => d.trim()).filter(Boolean);
  } else {
    return undefined;
  }
  if (cleaned.length === 0) return undefined;
  if (cleaned.length > FREE_MAX_DOMAINS) {
    throw fail('QUOTA_EXCEEDED', 'Querit 免费版' + kind + '至多 1 个站点', {
      retryable: false,
    });
  }
  return cleaned;
}

/**
 * 解析日期范围：原生 date_range 优先；统一 fromDate/toDate 双界齐备时拼 YYYY-MM-DDtoYYYY-MM-DD。
 * @param {any} params 统一搜索输入（含原生 date_range/dateRange）
 * @returns {string|undefined} 上游 date_range，条件不足时回 undefined
 */
function resolveDateRange(params) {
  const native = params && (params.date_range ?? params.dateRange);
  if (typeof native === 'string' && native.trim()) return native.trim();
  const from = params && params.fromDate;
  const to = params && params.toDate;
  // 单界无法拼出上游区间格式，直接丢弃，避免上游 400。
  if (typeof from === 'string' && from.trim() && typeof to === 'string' && to.trim()) {
    return from.trim() + 'to' + to.trim();
  }
  return undefined;
}

/**
 * 获取限速槽位：排队串行，并与上一请求起始拉开至少间隔毫秒。
 * @param {number} minIntervalMs 最小起始间隔（毫秒）
 * @returns {Promise<() => void>} 释放函数，请求完成后调用以放行下一请求
 */
async function acquireSlot(minIntervalMs) {
  const prev = throttleTail;
  /** @type {() => void} */
  let release = () => {};
  throttleTail = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  const gap = nextStartAt - Date.now();
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  nextStartAt = Date.now() + minIntervalMs;
  return release;
}

/**
 * Querit 搜索。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 queritApiKey、searchUrlQuerit、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function queritSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = (params && params.query) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveQuerit(deps);

  // 免费版硬约束：语言、条数、域名数在此一次收敛，违例直接抛。
  const languages = resolveLanguage(params);
  const rawCount = (params && (params.maxResults ?? params.count)) ?? FREE_MAX_COUNT;
  const count = clampCount(rawCount);
  const includeDomains = normalizeSingleDomain(
    params && (params.includeDomains ?? params.include_domains),
    '域名白名单',
  );
  const excludeDomains = normalizeSingleDomain(
    params && (params.excludeDomains ?? params.exclude_domains),
    '域名黑名单',
  );
  const dateRange = resolveDateRange(params);

  // 上游请求体字段动态（可选字段按需透传），整体压为 any，避免隐式 any 报错。
  const body = /** @type {any} */ ({
    query: query.trim(),
    count,
    languages,
  });
  if (includeDomains) body.include_domains = includeDomains;
  if (excludeDomains) body.exclude_domains = excludeDomains;
  if (dateRange) body.date_range = dateRange;
  // 富格式正文（include_content / format / 图片抓取）免费版不可用：
  // 恒不请求，调用方显式要求亦直接降级为片段，只回 url/title/snippet。

  // 限速间隔：默认 1 秒串行；仅单测允许经 deps.queritMinIntervalMs 覆盖。
  const minInterval =
    deps && Number.isFinite(deps.queritMinIntervalMs) && deps.queritMinIntervalMs >= 0
      ? Math.trunc(deps.queritMinIntervalMs)
      : RATE_LIMIT_INTERVAL_MS;
  const release = await acquireSlot(minInterval);

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    release();
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'Querit 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  } finally {
    // 串行链：请求完成才放行下一个，保证 1 QPS 且不并发。
    if (res) release();
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Querit 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Querit 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 免费版 1 QPS 超限：可重试，由调用方退避或换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'Querit 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status === 408 || res.status >= 500;
    throw fail('UPSTREAM_ERROR', 'Querit 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  const nested = data && typeof data === 'object' ? data.results : undefined;
  const items = Array.isArray(data && data.results)
    ? data.results
    : Array.isArray(nested && nested.result)
      ? nested.result
      : Array.isArray(data && data.data)
        ? data.data
        : [];

  const results = items
    .filter((/** @type {any} */ item) => item && item.url)
    .map((/** @type {any} */ item) => {
      // 默认片段形态：content 取 snippet；publishedDate 取 page_time；压 any 容纳动态字段。
      const out = /** @type {any} */ ({
        title: String(item.title || item.url || ''),
        url: String(item.url || ''),
        content: String(item.snippet || item.text || item.content || ''),
      });
      const published = item.page_time || item.publishedDate || item.published_date;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (Number.isFinite(item.score)) out.score = item.score;
      return out;
    });

  /** @type {UnifiedSearchResult} */
  const out = /** @type {UnifiedSearchResult} */ ({ provider: 'querit', results, raw: data });
  // 用量透传：上游用量字段原样回传。
  const usage = (data && data.usage) || undefined;
  if (usage !== undefined) out.usage = usage;
  return out;
}
