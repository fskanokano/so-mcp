/**
 * You.com 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：GET https://api.ydc-index.io/search，请求头 X-API-Key（兼容 Authorization: Bearer）。
 * 职责：把 UnifiedSearch 输入映射为 You.com 查询参数（query/num_results/freshness/country/language），
 * 把网页与新闻一次同回的结果归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlYoucom 优先）。
const DEFAULT_SEARCH_URL = 'https://api.ydc-index.io/search';

/** 条数下限（上游 num_results 最小 1）。 */
const MIN_COUNT = 1;
/** 条数上限（网关统一最大 50）。 */
const MAX_COUNT = 50;
/** 缺省条数（非法输入回退）。 */
const DEFAULT_COUNT = 10;

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {number} [maxResults] 来源数量上限（统一档，钳制 1..50）
 * @property {string} [freshness] 新鲜度窗口（上游原生，如 day/week/month）
 * @property {string} [country] 国家码（上游原生）
 * @property {string} [language] 语言码（上游原生）
 * @property {string[]} [includeDomains] 域名白名单
 * @property {string[]} [excludeDomains] 域名黑名单
 * @property {any} [count] 原生条数别名
 * @property {any} [numResults] 原生条数别名
 * @property {any} [num_results] 原生条数别名
 * @property {any} [limit] 原生条数别名
 * @property {any} [timeRange] 原生新鲜度别名
 * @property {any} [time_range] 原生新鲜度别名
 * @property {any} [include_domains] 原生白名单别名
 * @property {any} [exclude_domains] 原生黑名单别名
 * @property {any} [summary] 原生摘要开关
 * @property {any} [includeSummary] 原生摘要别名
 * @property {any} [include_summary] 原生摘要别名
 * @property {any} [date_range] 原生日期范围
 * @property {any} [dateRange] 原生日期范围别名
 * @property {any} [fromDate] 统一起始日期
 * @property {any} [toDate] 统一结束日期
 * @property {any} [outputType] 原生输出形态
 * @property {any} [include_answer] 原生答案开关
 * @property {any} [includeAnswer] 原生答案开关别名
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'youcom'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string}>} results 结果列表
 * @property {string} [answer] 答案（上游合成时）
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
 * 从 deps 解析 You.com 密钥与搜索地址（扁平读取，兼容大写环境变量名，空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveYoucom(deps) {
  const apiKey =
    (deps &&
      (deps.youcomApiKey ||
        deps.youcomKey ||
        deps.YOUCOM_API_KEY ||
        deps.YOUCOM_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 YOUCOM_API_KEY 服务端环境变量');
  }
  const url =
    (deps &&
      (deps.searchUrlYoucom ||
        deps.youcomSearchUrl ||
        deps.SEARCH_URL_YOUCOM ||
        deps.searchurl_youcom)) ||
    DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 钳制请求条数到 1..50，非法回默认 10。
 * @param {unknown} value 统一 maxResults 或原生 num_results
 * @returns {number} 钳制后的条数
 */
function clampCount(value) {
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  const n = Math.trunc(/** @type {number} */ (value));
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, n));
}

/**
 * 域名数组归一为逗号分隔串。
 * @param {unknown} value 域名白/黑名单（数组或字符串）
 * @returns {string|undefined} 逗号分隔串，无效时回 undefined
 */
function joinDomains(value) {
  if (Array.isArray(value)) {
    const cleaned = value
      .filter((d) => typeof d === 'string' && d.trim())
      .map((d) => String(d).trim());
    return cleaned.length > 0 ? cleaned.join(',') : undefined;
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

/**
 * 提取一处来源的结果数组（兼容数组与 {results: []} 包裹形态）。
 * @param {unknown} value 上游来源节点
 * @returns {any[]} 结果数组，无效时回空数组
 */
function asResults(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(/** @type {any} */ (value).results)) {
    return /** @type {any} */ (value).results;
  }
  return [];
}

/**
 * You.com 搜索：GET /search，网页与新闻一次同回直接归一。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 youcomApiKey、searchUrlYoucom、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function youcomSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = (params && params.query) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveYoucom(deps);

  // 条数：统一 maxResults 与原生 num_results 互认，钳制 1..50。
  const anyParams = /** @type {any} */ (params);
  const rawCount =
    (params && (params.maxResults ?? anyParams.num_results ?? anyParams.numResults ?? anyParams.count ?? anyParams.limit)) ??
    DEFAULT_COUNT;
  const count = clampCount(rawCount);

  // 组装查询串：仅透传非空可选字段。
  const search = new URLSearchParams();
  search.set('query', query.trim());
  search.set('num_results', String(count));

  // 新鲜度窗口：统一 freshness 与 timeRange/time_range 互认。
  const freshness = (params && (params.freshness ?? anyParams.timeRange ?? anyParams.time_range)) || '';
  if (typeof freshness === 'string' && freshness.trim()) search.set('freshness', freshness.trim());

  // 国家与语言：透传上游原生字段。
  const country = (params && params.country) || '';
  const language = (params && params.language) || '';
  if (typeof country === 'string' && country.trim()) search.set('country', country.trim());
  if (typeof language === 'string' && language.trim()) search.set('language', language.trim());

  // 域名白/黑名单：统一数组与原生逗号串互认，直接透传。
  const includeDomains = joinDomains(params && (params.includeDomains ?? anyParams.include_domains));
  const excludeDomains = joinDomains(params && (params.excludeDomains ?? anyParams.exclude_domains));
  if (includeDomains) search.set('include_domains', includeDomains);
  if (excludeDomains) search.set('exclude_domains', excludeDomains);

  const endpoint = url + '?' + search.toString();

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        Authorization: 'Bearer ' + apiKey,
      },
    });
  } catch (cause) {
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'You.com 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'You.com 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402 || res.status === 403) {
    throw fail('INSUFFICIENT_CREDIT', 'You.com 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 限速超限：可重试，由调用方退避或换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'You.com 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 408;
    throw fail('UPSTREAM_ERROR', 'You.com 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();

  // 网页与新闻一次同回：兼容顶层数组与 hits/web/news 包裹形态，直接合并归一。
  const rawItems = [];
  if (Array.isArray(data && data.results)) {
    rawItems.push(.../** @type {any[]} */ (data.results));
  } else if (data && data.results && typeof data.results === 'object') {
    rawItems.push(...asResults(data.results.web), ...asResults(data.results.news));
  }
  const hits = data && typeof data === 'object' ? data.hits : undefined;
  if (hits && typeof hits === 'object') {
    rawItems.push(...asResults(hits.web), ...asResults(hits.news));
    if (Array.isArray(hits.results)) rawItems.push(...hits.results);
  }
  rawItems.push(...asResults(data && data.web), ...asResults(data && data.news));

  const results = rawItems
    .filter((/** @type {any} */ item) => item && (item.url || item.link))
    .map((/** @type {any} */ item) => {
      // 归一对象需动态追加 publishedDate/score，压为 any，避免缺失字段报错。
      const snippets = Array.isArray(item.snippets) ? item.snippets.join('\n') : undefined;
      const out = /** @type {any} */ ({
        title: String(item.title || item.url || item.link || ''),
        url: String(item.url || item.link || ''),
        content: String(
          snippets ?? item.snippet ?? item.content ?? item.description ?? item.text ?? '',
        ),
      });
      const published = item.page_age || item.publishedDate || item.published_date || item.date;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (Number.isFinite(item.score)) out.score = item.score;
      return out;
    })
    .slice(0, count);

  /** @type {UnifiedSearchResult} */
  const out = /** @type {UnifiedSearchResult} */ ({ provider: 'youcom', results, raw: data });
  // 答案写入 answer：仅非空字符串落盘。
  const answer = (data && data.answer) || undefined;
  if (typeof answer === 'string' && answer) out.answer = answer;
  // 用量透传：上游用量字段原样回传。
  const usage = (data && data.usage) || undefined;
  if (usage !== undefined) out.usage = usage;
  return out;
}
