/**
 * ScrapingAnt 抓取供应商（单请求单 URL，限并发扇出适配批量）。
 *
 * 上游：GET https://api.scrapingant.com/v2/general?url=...&browser=false，请求头 x-api-key 鉴权。
 * 参数：browser 默认 false 普通页面；调用方传 render=true 或 browser=true 时转 true 启用渲染。
 * 并发：免费档按 5 并发扇出（可用 deps.scrapingantConcurrency 覆盖，钳制在 1..5）。
 * 输出：响应体按 UTF-8 字节上限 4MB 截断（与网关 MAX_REQUEST_BYTES 对齐）。
 * 零运行时依赖，原生 ESM，仅用全局 fetch；不打日志，不打印密钥。
 */

// 默认抓取端点（deps.fetchUrlScrapingant 优先）。
const DEFAULT_FETCH_URL = 'https://api.scrapingant.com/v2/general';

// 默认扇出并发（可用 deps.scrapingantConcurrency 覆盖，上限钳制在 1..5）。
const DEFAULT_CONCURRENCY = 5;

// 响应体上限 4MB（与网关 MAX_REQUEST_BYTES 对齐）。
const MAX_BYTES = 4 * 1024 * 1024;

// UTF-8 编解码器（字节级截断用，避免多字节字符被拦腰截断）。
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
 * 解析布尔开关（true/'true'/1 为开，其余为关）。
 * @param {any} value 原始值
 * @returns {boolean} 是否开启
 */
function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * 从 deps 解析 ScrapingAnt 密钥与抓取地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveScrapingant(deps) {
  const apiKey =
    (deps &&
      (deps.scrapingantApiKey ||
        deps.scrapingantKey ||
        deps.SCRAPINGANT_API_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 SCRAPINGANT_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlScrapingant || deps.scrapingantFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 解析渲染开关：显式 browser 优先，其次统一 render，回落 deps 全局开关，默认最低成本。
 * @param {any} params 统一抓取输入（可附带 browser/render 显式开关）
 * @param {any} deps 依赖（可附带 scrapingantBrowser/scrapingantRender 全局开关）
 * @returns {boolean} 是否启用渲染
 */
function resolveBrowser(params, deps) {
  const explicit =
    (params && params.browser) ??
    (params && params.render) ??
    (deps && (deps.scrapingantBrowser ?? deps.scrapingantRender)) ??
    false;
  return toBool(explicit);
}

/**
 * 兼容 Headers 实例与普通对象读取响应头。
 * @param {any} res 抓取响应
 * @param {string} name 头名
 * @returns {string} 头值（缺失为空串）
 */
function headerValue(res, name) {
  try {
    const headers = res && res.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      return String(headers.get(name) || headers.get(name.toLowerCase()) || '');
    }
    const lower = String(name).toLowerCase();
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === lower) return String(headers[key]);
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * 按字节上限截断字符串（UTF-8 安全）。
 * @param {string} text 原文
 * @param {number} limit 字节上限
 * @returns {string} 截断后文本
 */
function truncateUtf8(text, limit) {
  const bytes = textEncoder.encode(text);
  if (bytes.length <= limit) return text;
  return textDecoder.decode(bytes.slice(0, limit));
}

/**
 * 从 HTML 文本中提取标题（取 <title>，缺失为空串）。
 * @param {string} text 响应正文
 * @returns {string} 标题
 */
function extractTitle(text) {
  if (typeof text !== 'string' || !text) return '';
  const matched = /<title[^>]*>([\s\S]{1,500})<\/title>/i.exec(text);
  if (!matched) return '';
  return String(matched[1]).replace(/\s+/g, ' ').trim();
}

/**
 * 读取成功响应正文（优先 text，兼容仅实现 json 的桩）。
 * @param {any} res 上游响应
 * @returns {Promise<string>} 正文字符串
 */
async function readBodyText(res) {
  if (res && typeof res.text === 'function') return String((await res.text()) || '');
  if (res && typeof res.json === 'function') {
    const data = await res.json();
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
      const candidate =
        data.content ?? data.html ?? data.text ?? data.markdown ?? data.data ?? '';
      if (typeof candidate === 'string' && candidate) return candidate;
      return JSON.stringify(data);
    }
    return String(data || '');
  }
  return '';
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {string} apiKey ScrapingAnt 密钥
 * @param {string} endpoint 抓取端点
 * @param {{browser: boolean, perUrlTimeoutMs?: number}} options 单条选项
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<{url: string, finalUrl: string, title: string, content: string}>} 归一成功项
 */
async function fetchSingle(target, apiKey, endpoint, options, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  // 组装上游查询串：目标地址 + 渲染开关；密钥只进请求头，不进日志与地址。
  const query = new URLSearchParams();
  query.set('url', String(target));
  query.set('browser', options.browser ? 'true' : 'false');
  const timeoutMs = Number(options.perUrlTimeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    query.set('timeout', String(Math.max(1000, Math.min(120000, Math.floor(timeoutMs)))));
  }
  const separator = endpoint.includes('?') ? '&' : '?';
  const requestUrl = endpoint + separator + query.toString();
  // perUrlTimeoutMs 同时作为客户端中止时限，超时错误可重试。
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.floor(timeoutMs))
      : undefined;
  const init = { method: 'GET', headers: { Accept: '*/*', 'x-api-key': apiKey } };
  if (signal !== undefined) /** @type {any} */ (init).signal = signal;

  /** @type {Response} */
  let res;
  try {
    res = await impl(requestUrl, init);
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'ScrapingAnt 抓取请求失败：' + String(target), {
      retryable: true,
    });
  }

  // 最终地址：上游回传的落地页优先，否则回落目标地址。
  const finalUrl =
    headerValue(res, 'x-final-url') ||
    headerValue(res, 'scrapingant-final-url') ||
    String(target);

  if (res.ok) {
    const text = await readBodyText(res);
    const content = truncateUtf8(String(text || ''), MAX_BYTES);
    return { url: String(target), finalUrl, title: extractTitle(content), content };
  }

  // 401 密钥无效不可重试，402 余额不足不可重试，403 无权限/额度耗尽不可重试。
  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'ScrapingAnt 密钥无效或无权限', {
      status: 401,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'ScrapingAnt 余额不足', {
      status: 402,
      retryable: false,
    });
  }
  if (res.status === 403) {
    throw fail('UPSTREAM_FORBIDDEN', 'ScrapingAnt 拒绝访问（403）：' + String(target), {
      status: 403,
      retryable: false,
    });
  }
  // 目标不存在不可重试，避免回退重复扣费。
  if (res.status === 404 || res.status === 410) {
    throw fail('page_not_found', 'ScrapingAnt 目标不存在：' + String(target) + ' HTTP ' + res.status, {
      status: res.status,
      retryable: false,
    });
  }
  // 非法请求不可重试。
  if (res.status === 400 || res.status === 422) {
    throw fail('target_http_error', 'ScrapingAnt 目标异常：' + String(target) + ' HTTP ' + res.status, {
      status: res.status,
      retryable: false,
    });
  }
  // 429 限流、408 超时、5xx 服务端异常可重试。
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'ScrapingAnt 限流（429）：' + String(target), {
      status: 429,
      retryable: true,
    });
  }
  if (res.status === 408 || res.status >= 500) {
    throw fail('UPSTREAM_ERROR', 'ScrapingAnt 抓取异常：' + String(target) + ' HTTP ' + res.status, {
      status: res.status,
      retryable: true,
    });
  }
  throw fail('UPSTREAM_ERROR', 'ScrapingAnt 抓取异常：' + String(target) + ' HTTP ' + res.status, {
    status: res.status,
    retryable: false,
  });
}

/**
 * 限并发扇出（保持输入顺序结算）。
 * @param {Array<string>} items 目标列表
 * @param {number} limit 并发上限
 * @param {(target: string, index: number) => Promise<any>} worker 单条工作函数
 * @returns {Promise<Array<{ok: boolean, value?: any, error?: any}>>} 按输入顺序的结算数组
 */
async function mapLimit(items, limit, worker) {
  const settled = new Array(items.length);
  let next = 0;
  const count = Math.max(1, Math.min(limit, items.length));
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        settled[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        settled[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: count }, run));
  return settled;
}

/**
 * ScrapingAnt 批量抓取（单请求单 URL，限并发扇出再合并）。
 * @param {{urls: string[], format?: 'markdown'|'html', browser?: boolean|string, render?: boolean|string, perUrlTimeoutMs?: number}} params
 *   统一抓取输入（urls 1..10；browser 默认 false，render=true 时转 true；format 兼容透传不影响取数）
 * @param {any} deps 依赖（含 scrapingantApiKey、fetchUrlScrapingant、scrapingantConcurrency）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>}>}
 *   归一后的成功与失败列表
 */
export async function scrapingantFetch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const urls = params && params.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 10) {
    throw fail('INVALID_PARAMS', 'urls 必须为 1..10 个 URL 的数组');
  }
  for (const u of urls) {
    if (typeof u !== 'string' || !(u.startsWith('http://') || u.startsWith('https://'))) {
      throw fail('INVALID_PARAMS', 'urls 仅支持 http/https 字符串：' + String(u));
    }
  }

  const { apiKey, url } = resolveScrapingant(deps);
  // 并发钳制在 5 以内，可由 deps.scrapingantConcurrency 覆盖（仍钳制防打爆）。
  const rawLimit = Number(deps && deps.scrapingantConcurrency);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(5, Math.floor(rawLimit)))
    : DEFAULT_CONCURRENCY;
  // 普通页面默认不渲染，显式 browser/render 开启时转 true。
  const browser = resolveBrowser(params, deps);
  const perUrlTimeoutMs = params.perUrlTimeoutMs;

  const targets = urls.map((u) => String(u));
  const settled = await mapLimit(targets, limit, (target) =>
    fetchSingle(target, apiKey, url, { browser, perUrlTimeoutMs }, fetchImpl),
  );

  // 成功与失败列表元素形状不同，压为 any[]，避免联合赋值报错。
  const results = /** @type {any[]} */ ([]);
  const errors = /** @type {any[]} */ ([]);
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.ok) {
      results.push(item.value);
    } else {
      // 捕获异常为未知形状，转 any 后再取 code/status/retryable；包内三码恒可重试，未知异常默认可重试以便走回退。
      const caught = /** @type {any} */ (item.error);
      const code = String((caught && caught.code) || 'target_unreachable');
      let retryable;
      if (caught && caught.retryable !== undefined) {
        retryable = !!caught.retryable;
      } else if (code === 'timeout' || code === 'bot_blocked' || code === 'target_unreachable') {
        retryable = true;
      } else {
        retryable = true;
      }
      // 错误条目需动态追加 status，压为 any，避免缺失字段报错。
      const entry = /** @type {any} */ ({ url: targets[i], error: code, retryable });
      if (caught && caught.status !== undefined) entry.status = caught.status;
      errors.push(entry);
    }
  }
  return { results, errors };
}
