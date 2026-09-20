/**
 * Jina 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：GET https://s.jina.ai/，请求头 Authorization: Bearer。
 * 职责：把 UnifiedSearch 输入映射为 Jina 查询参数（q/count），把结果归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlJina 优先）。
const DEFAULT_SEARCH_URL = 'https://s.jina.ai/';

/** 条数下限（上游 count 最小 1）。 */
const MIN_COUNT = 1;
/** 条数上限（上游 count 最大 20）。 */
const MAX_COUNT = 20;
/** 缺省条数（非法输入回退）。 */
const DEFAULT_COUNT = 10;

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} [query] 查询文本（与 q 互认）
 * @property {string} [q] 查询文本别名（Jina 原生名）
 * @property {number} [maxResults] 来源数量上限（与 count 互认，钳制 1..20）
 * @property {number} [count] 条数别名（Jina 原生名）
 * @property {string} [fromDate] 起始日期（本适配忽略，仅兼容网关透传）
 * @property {string} [toDate] 结束日期（本适配忽略，仅兼容网关透传）
 * @property {string[]} [includeDomains] 域名白名单（折 site 语法拼到 q）
 * @property {string[]} [excludeDomains] 域名黑名单（折 site 语法拼到 q）
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'jina'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string, publishedDate?: string, score?: number}>} results 结果列表
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
 * 从 deps 解析 Jina 密钥与搜索地址（扁平读取，空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveJina(deps) {
  // 扁平读取，兼容大写环境变量名，空串视为缺失。
  const apiKey = (deps && (deps.jinaApiKey || deps.JINA_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 JINA_API_KEY 服务端环境变量');
  }
  const url = (deps && (deps.searchUrlJina || deps.jinaSearchUrl)) || DEFAULT_SEARCH_URL;
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
 * 域名白/黑名单折成 site 查询语法拼到 q 上。
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
 * 从上游响应收集可映射条目：results 优先，data/items/web 形态兼容补量。
 * @param {any} data 上游 JSON
 * @returns {any[]} 原始条目数组
 */
function collectItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data)) return data.data;
  if (data.data && Array.isArray(data.data.results)) return data.data.results;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.web)) return data.web;
  return [];
}

/**
 * 从单条结果拼装正文：highlights 数组拼接优先，其次 content/snippet/text/summary。
 * @param {any} item 上游单条结果
 * @returns {string} 归一正文
 */
function pickContent(item) {
  if (Array.isArray(item.highlights) && item.highlights.length > 0) {
    return item.highlights.map((/** @type {any} */ h) => String(h || '')).filter(Boolean).join('\n');
  }
  if (typeof item.content === 'string' && item.content) return item.content;
  if (typeof item.snippet === 'string' && item.snippet) return item.snippet;
  if (typeof item.text === 'string' && item.text) return item.text;
  if (typeof item.summary === 'string' && item.summary) return item.summary;
  if (typeof item.description === 'string' && item.description) return item.description;
  return '';
}

/**
 * Jina 搜索：GET /?q=&count=，域名名单折 site 语法。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 jinaApiKey、searchUrlJina、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function jinaSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const anyParams = /** @type {any} */ (params);
  const query = (params && (params.query ?? anyParams.q)) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveJina(deps);

  // 条数：统一 maxResults 与原生 count 互认，钳制 1..20，缺省 10。
  const rawCount = (params && (params.maxResults ?? anyParams.count)) ?? DEFAULT_COUNT;
  const count = clampCount(rawCount);

  // 查询拼装：域名名单折成 site 语法（上游无原生域名参数时仍可生效）。
  const finalQuery = applyDomains(
    query.trim(),
    params && (params.includeDomains ?? anyParams.include_domains),
    params && (params.excludeDomains ?? anyParams.exclude_domains),
  );

  // 组装 GET 查询串：q 为拼装后查询，count 为钳制后条数。
  const search = new URLSearchParams();
  search.set('q', finalQuery);
  search.set('count', String(count));
  const endpoint = url + '?' + search.toString();

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        Accept: 'application/json',
      },
    });
  } catch (cause) {
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'Jina 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Jina 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Jina 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 限流：可重试，由调用方退避或换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'Jina 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status === 408 || res.status >= 500;
    throw fail('UPSTREAM_ERROR', 'Jina 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  let data;
  if (typeof res.text === 'function') {
    const rawText = await res.text();
    if (!rawText || !rawText.trim()) {
      data = {};
    } else {
      const trimmed = rawText.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = {};
        }
      } else {
        data = { results: [] };
      }
    }
  } else if (typeof res.json === 'function') {
    try {
      data = await res.json();
    } catch {
      data = {};
    }
  } else {
    data = {};
  }
  const items = collectItems(data);

  const results = items
    .filter((/** @type {any} */ item) => item && (item.url || item.link))
    .map((/** @type {any} */ item) => {
      // 归一对象需动态追加 publishedDate/score，压为 any，避免缺失字段报错。
      const out = /** @type {any} */ ({
        title: String(item.title || item.url || item.link || ''),
        url: String(item.url || item.link || ''),
        content: String(pickContent(item) || ''),
      });
      const published = item.publishedDate || item.published_date || item.date || item.page_time;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (Number.isFinite(item.score)) out.score = item.score;
      return out;
    })
    .slice(0, count);

  /** @type {UnifiedSearchResult} */
  const out = /** @type {UnifiedSearchResult} */ ({ provider: 'jina', results, raw: data });
  // 用量透传：上游用量字段原样回传。
  const usage = (data && typeof data === 'object' && data.usage) || undefined;
  if (usage !== undefined) out.usage = usage;
  return out;
}
