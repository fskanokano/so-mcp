/**
 * LangSearch 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：POST https://api.langsearch.com/v1/web-search，请求头 Authorization: Bearer。
 * 职责：把 UnifiedSearch 输入映射为 LangSearch 请求体（query/count/freshness/summary），把结果归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlLangsearch 优先）。
const DEFAULT_SEARCH_URL = 'https://api.langsearch.com/v1/web-search';

/** 条数下限（上游 count 最小 1）。 */
const MIN_COUNT = 1;
/** 条数上限（上游 count 最大 20）。 */
const MAX_COUNT = 20;
/** 缺省条数（非法输入回退）。 */
const DEFAULT_COUNT = 10;

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {number} [maxResults] 来源数量上限（钳制 1..20）
 * @property {string} [freshness] 新鲜度窗口（上游原生）
 * @property {string} [fromDate] 起始日期（折 freshness 或 date_range）
 * @property {string} [toDate] 结束日期（折 freshness 或 date_range）
 * @property {string[]} [includeDomains] 域名白名单（折查询语法）
 * @property {string[]} [excludeDomains] 域名黑名单（折查询语法）
 * @property {any} [count] 原生条数别名
 * @property {any} [numResults] 原生条数别名
 * @property {any} [num_results] 原生条数别名
 * @property {any} [limit] 原生条数别名
 * @property {any} [timeRange] 原生新鲜度别名
 * @property {any} [time_range] 原生新鲜度别名
 * @property {any} [country] 原生国家别名
 * @property {any} [language] 原生语言别名
 * @property {any} [include_domains] 原生白名单别名
 * @property {any} [exclude_domains] 原生黑名单别名
 * @property {any} [summary] 原生摘要开关
 * @property {any} [includeSummary] 原生摘要别名
 * @property {any} [include_summary] 原生摘要别名
 * @property {any} [date_range] 原生日期范围
 * @property {any} [dateRange] 原生日期范围别名
 * @property {any} [outputType] 原生输出形态
 * @property {any} [include_answer] 原生答案开关
 * @property {any} [includeAnswer] 原生答案开关别名
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {string} provider 供应商名（恒为 langsearch）
 * @property {Array<{title: string, url: string, content: string}>} results 归一结果
 * @property {string} [answer] 答案（上游合成时）
 * @property {any} [raw] 上游原始响应
 * @property {any} [usage] 计费用量
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
 * 从 deps 解析 LangSearch 密钥与搜索地址（扁平读取，兼容大写环境变量名，空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveLangsearch(deps) {
  const apiKey =
    (deps &&
      (deps.langsearchApiKey ||
        deps.langsearchKey ||
        deps.LANGSEARCH_API_KEY ||
        deps.LANGSEARCH_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 LANGSEARCH_API_KEY 服务端环境变量');
  }
  const url =
    (deps &&
      (deps.searchUrlLangsearch ||
        deps.langsearchSearchUrl ||
        deps.SEARCH_URL_LANGSEARCH ||
        deps.searchurl_langsearch)) ||
    DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 钳制请求条数到 1..20，非法回默认 10。
 * @param {unknown} value 统一 maxResults 或原生 count
 * @returns {number} 钳制后的条数
 */
function clampCount(value) {
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  const n = Math.trunc(/** @type {number} */ (value));
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, n));
}

/**
 * 解析摘要开关：原生 summary 优先，sourcedAnswer 默认开启，其余默认开启以保证正文回量。
 * @param {any} params 统一搜索输入
 * @returns {boolean} 上游 summary
 */
function resolveSummary(params) {
  const anyParams = /** @type {any} */ (params);
  const native = params && (anyParams.summary ?? anyParams.includeSummary ?? anyParams.include_summary);
  if (typeof native === 'boolean') return native;
  if (typeof native === 'string' && native.trim()) {
    const text = native.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  if (params && anyParams.outputType === 'sourcedAnswer') return true;
  const answerFlag = params && (anyParams.include_answer ?? anyParams.includeAnswer);
  if (typeof answerFlag === 'boolean') return answerFlag;
  return true;
}

/**
 * 解析新鲜度窗口：统一 freshness 与 timeRange/time_range 互认，原生非空直传。
 * @param {any} params 统一搜索输入
 * @returns {string|undefined} 上游 freshness，无命中时回 undefined
 */
function resolveFreshness(params) {
  const anyParams = /** @type {any} */ (params);
  const native = params && (params.freshness ?? anyParams.timeRange ?? anyParams.time_range);
  if (typeof native === 'string' && native.trim()) return native.trim();
  return undefined;
}

/**
 * 解析日期范围：原生 date_range 优先；统一 fromDate/toDate 双界齐备时拼 YYYY-MM-DDtoYYYY-MM-DD。
 * @param {any} params 统一搜索输入（含原生 date_range/dateRange）
 * @returns {string|undefined} 上游 date_range，条件不足时回 undefined
 */
function resolveDateRange(params) {
  const anyParams = /** @type {any} */ (params);
  const native = params && (anyParams.date_range ?? anyParams.dateRange);
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
 * 清洗域名条目：去协议头与路径，只留裸域。
 * @param {unknown} value 待清洗值
 * @returns {string} 裸域，非法时为空串
 */
function cleanDomain(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/^https?:\/\//i, '');
  const host = text.split('/')[0].trim().toLowerCase();
  if (!host || host.includes(' ') || !host.includes('.')) return '';
  return host;
}

/**
 * 域名白/黑名单折成查询语法拼到 query 上。
 * 白名单用 (site:a OR site:b)，黑名单用 -site:c -site:d；两者并存时白名单优先。
 * @param {string} query 原查询
 * @param {unknown} include 白名单（数组或逗号串）
 * @param {unknown} exclude 黑名单（数组或逗号串）
 * @returns {string} 拼装后的查询
 */
function applyDomains(query, include, exclude) {
  const toList = (/** @type {unknown} */ value) => {
    if (Array.isArray(value)) return value.map(cleanDomain).filter(Boolean);
    if (typeof value === 'string' && value.trim()) {
      return value.split(',').map(cleanDomain).filter(Boolean);
    }
    return [];
  };
  const inc = toList(include);
  const exc = toList(exclude);
  let out = query;
  if (inc.length > 0) {
    out += ` (${inc.map((d) => `site:${d}`).join(' OR ')})`;
  } else if (exc.length > 0) {
    out += ` ${exc.map((d) => `-site:${d}`).join(' ')}`;
  }
  return out;
}

/**
 * 从上游响应收集可映射条目：results 优先，data 包裹与 web 形态兼容补量。
 * @param {any} data 上游 JSON
 * @returns {any[]} 原始条目数组
 */
function collectItems(data) {
  if (Array.isArray(data && data.results)) return data.results;
  if (Array.isArray(data && data.data)) return data.data;
  if (data && data.data && Array.isArray(data.data.results)) return data.data.results;
  if (Array.isArray(data && data.web)) return data.web;
  return [];
}

/**
 * 从单条结果拼装正文：highlights 数组拼接优先，其次 content/snippet/summary/text。
 * @param {any} item 上游单条结果
 * @returns {string} 归一正文
 */
function pickContent(item) {
  if (Array.isArray(item.highlights) && item.highlights.length > 0) {
    return item.highlights.map((/** @type {any} */ h) => String(h)).join('\n');
  }
  if (typeof item.content === 'string' && item.content) return item.content;
  if (typeof item.snippet === 'string' && item.snippet) return item.snippet;
  if (typeof item.summary === 'string' && item.summary) return item.summary;
  if (typeof item.text === 'string' && item.text) return item.text;
  if (typeof item.description === 'string' && item.description) return item.description;
  return '';
}

/**
 * LangSearch 搜索：POST /v1/web-search，请求体含 query/count/freshness/summary。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 langsearchApiKey、searchUrlLangsearch、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function langsearchSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = (params && params.query) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveLangsearch(deps);
  // 条数：统一 maxResults 与原生 count/numResults/limit 互认，钳制 1..20。
  const anyParams = /** @type {any} */ (params);
  const rawCount =
    (params &&
      (params.maxResults ??
        anyParams.count ??
        anyParams.numResults ??
        anyParams.num_results ??
        anyParams.limit)) ??
    DEFAULT_COUNT;
  const count = clampCount(rawCount);

  // 日期：原生 freshness 优先直传；fromDate/toDate 双界齐备时折 date_range。
  const freshness = resolveFreshness(params);
  const dateRange = resolveDateRange(params);

  // 查询拼装：域名名单折成 site 语法（上游无稳定域名参数时仍可生效）。
  const finalQuery = applyDomains(
    query.trim(),
    params && (params.includeDomains ?? anyParams.include_domains),
    params && (params.excludeDomains ?? anyParams.exclude_domains),
  );

  // 上游请求体字段动态（可选字段按需透传），整体压为 any，避免隐式 any 报错。
  const body = /** @type {any} */ ({
    query: finalQuery,
    count,
    summary: resolveSummary(params),
  });
  if (freshness) body.freshness = freshness;
  if (dateRange) body.date_range = dateRange;

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
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'LangSearch 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'LangSearch 密钥无效', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402 || res.status === 403) {
    throw fail('INSUFFICIENT_CREDIT', 'LangSearch 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 限流：可重试，由调用方退避或换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'LangSearch 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status === 408 || res.status >= 500;
    throw fail('UPSTREAM_ERROR', 'LangSearch 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  const items = collectItems(data);
  // 包体 error 非空且无可用条目：视为失败；包内超时/拦截/不可达恒可重试。
  if (items.length === 0 && data && typeof data.error === 'string' && data.error) {
    throw fail('UPSTREAM_ERROR', 'LangSearch 搜索未返回可用结果：' + data.error, {
      status: res.status,
      retryable: true,
    });
  }

  const results = items
    .filter((/** @type {any} */ item) => item && (item.url || item.link))
    .map((/** @type {any} */ item) => {
      // 归一对象需动态追加 publishedDate/score，压为 any，避免缺失字段报错。
      const out = /** @type {any} */ ({
        title: String(item.title || item.name || item.url || item.link || ''),
        url: String(item.url || item.link || ''),
        content: String(pickContent(item) || ''),
      });
      const published =
        item.publishedDate || item.published_date || item.date || item.page_time;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (Number.isFinite(item.score)) out.score = item.score;
      return out;
    });

  /** @type {UnifiedSearchResult} */
  const out = /** @type {UnifiedSearchResult} */ ({
    provider: 'langsearch',
    results,
    raw: data,
    usage: {
      endpoint: 'web-search',
      creditsEstimated: count,
      requested: count,
      returned: results.length,
    },
  });
  // 答案写入 answer：仅非空字符串落盘。
  const answer = data && (data.answer || data.summary);
  if (typeof answer === 'string' && answer) out.answer = answer;
  // 用量透传：上游用量字段原样回传。
  const upstreamUsage = data && data.usage;
  if (upstreamUsage !== undefined) out.usage.usage = upstreamUsage;
  return out;
}
