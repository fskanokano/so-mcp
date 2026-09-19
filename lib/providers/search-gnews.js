/**
 * GNews 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：GET https://gnews.io/api/v4/search，密钥走 query 参数 apikey。
 * 职责：把 UnifiedSearch 输入映射为 GNews 查询参数（q/max/lang/country/from/to/sortby），
 * 把 articles 一次同回的结果归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlGnews 优先）。
const DEFAULT_SEARCH_URL = 'https://gnews.io/api/v4/search';

/** 条数下限（网关统一最小 1）。 */
const MIN_COUNT = 1;
/** 条数上限（网关统一最大 50）。 */
const MAX_COUNT = 50;
/** 缺省条数（非法输入回退）。 */
const DEFAULT_COUNT = 10;

/** 缺省语言（上游 lang）。 */
const DEFAULT_LANG = 'en';
/** 缺省国家（上游 country）。 */
const DEFAULT_COUNTRY = 'us';
/** 缺省排序（上游 sortby）。 */
const DEFAULT_SORTBY = 'publishedAt';

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本（别名 q）
 * @property {number} [maxResults] 来源数量上限（别名 max，钳制 1..50）
 * @property {string} [lang] 语言码（别名 language，缺省 en）
 * @property {string} [country] 国家码（缺省 us）
 * @property {string} [fromDate] 起始日期（别名 from，映射上游 from）
 * @property {string} [toDate] 结束日期（别名 to，映射上游 to）
 * @property {string} [sortby] 排序（别名 sortBy，缺省 publishedAt）
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'gnews'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string, publishedDate?: string, score?: number}>} results 结果列表
 * @property {unknown} [raw] 上游原始响应
 * @property {unknown} [usage] 计费用量
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
 * 从 deps 解析 GNews 密钥与搜索地址（扁平读取，兼容大写环境变量名，空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveGnews(deps) {
  const apiKey =
    (deps &&
      (deps.gnewsApiKey ||
        deps.gnewsKey ||
        deps.GNEWS_API_KEY ||
        deps.GNEWS_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 GNEWS_API_KEY 服务端环境变量');
  }
  const url =
    (deps &&
      (deps.searchUrlGnews ||
        deps.gnewsSearchUrl ||
        deps.SEARCH_URL_GNEWS ||
        deps.searchurl_gnews)) ||
    DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 钳制请求条数到 1..50，非法回默认 10。
 * @param {unknown} value 统一 maxResults 或原生 max
 * @returns {number} 钳制后的条数
 */
function clampCount(value) {
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  const n = Math.trunc(/** @type {number} */ (value));
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, n));
}

/**
 * 取非空字符串（去首尾空格），无效回 fallback。
 * @param {unknown} value 待取值
 * @param {string|undefined} fallback 无效时的回退
 * @returns {string|undefined} 清洗后的字符串
 */
function pickText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text || fallback;
}

/**
 * GNews 搜索：GET /api/v4/search，articles 一次同回直接归一。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 gnewsApiKey、searchUrlGnews、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function gnewsSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const anyParams = /** @type {any} */ (params);
  const query = (params && (params.query ?? anyParams.q)) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveGnews(deps);

  // 条数：统一 maxResults 与原生 max 互认，钳制 1..50，缺省 10。
  const rawCount =
    (params && (params.maxResults ?? anyParams.max ?? anyParams.count ?? anyParams.limit ?? anyParams.numResults ?? anyParams.num_results)) ??
    DEFAULT_COUNT;
  const count = clampCount(rawCount);

  // 语言与国家：统一 lang/language 与 country 互认，缺省 en/us。
  const lang = pickText(params && (params.lang ?? anyParams.language), DEFAULT_LANG);
  const country = pickText(params && params.country, DEFAULT_COUNTRY);

  // 日期界限：统一 fromDate/toDate 映射上游 from/to，兼容 from/to 原生写法。
  const from = pickText(
    params && (params.fromDate ?? anyParams.from ?? anyParams.startDate ?? anyParams.start_date),
    undefined,
  );
  const to = pickText(
    params && (params.toDate ?? anyParams.to ?? anyParams.endDate ?? anyParams.end_date),
    undefined,
  );

  // 排序：透传非空值，缺省 publishedAt。
  const sortby = pickText(params && (params.sortby ?? anyParams.sortBy), DEFAULT_SORTBY);

  // 组装查询串：密钥走 query 参数 apikey。
  const search = new URLSearchParams();
  search.set('q', query.trim());
  search.set('apikey', apiKey);
  search.set('max', String(count));
  if (lang) search.set('lang', lang);
  if (country) search.set('country', country);
  if (sortby) search.set('sortby', sortby);
  if (from) search.set('from', from);
  if (to) search.set('to', to);

  const endpoint = url + '?' + search.toString();

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(endpoint, { method: 'GET' });
  } catch (cause) {
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'GNews 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'GNews 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402 || res.status === 403) {
    throw fail('INSUFFICIENT_CREDIT', 'GNews 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 限速超限：可重试，由调用方退避或换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'GNews 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 408;
    throw fail('UPSTREAM_ERROR', 'GNews 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();

  // 上游一次同回 articles 数组；兼容 results/items 包裹形态。
  const rawItems = Array.isArray(data && data.articles)
    ? /** @type {any[]} */ (data.articles)
    : Array.isArray(data && data.results)
      ? /** @type {any[]} */ (data.results)
      : Array.isArray(data && data.items)
        ? /** @type {any[]} */ (data.items)
        : [];

  const results = rawItems
    .filter((/** @type {any} */ item) => item && (item.url || item.link))
    .map((/** @type {any} */ item) => {
      // 归一对象需动态追加 publishedDate/score，压为 any，避免缺失字段报错。
      const out = /** @type {any} */ ({
        title: String(item.title || item.url || item.link || ''),
        url: String(item.url || item.link || ''),
        content: String(item.content ?? item.description ?? item.text ?? item.snippet ?? ''),
      });
      const published = item.publishedAt || item.publishedDate || item.published_date || item.date;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (Number.isFinite(item.score)) out.score = item.score;
      return out;
    })
    .slice(0, count);

  /** @type {UnifiedSearchResult} */
  const out = /** @type {UnifiedSearchResult} */ ({ provider: 'gnews', results, raw: data });
  // 用量透传：上游用量字段原样回传。
  const usage = (data && data.usage) || undefined;
  if (usage !== undefined) out.usage = usage;
  return out;
}
