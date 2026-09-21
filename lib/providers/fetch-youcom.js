/**
 * You.com 抓取供应商（单请求单 URL，限并发扇出适配批量，统一抓取形状适配层）。
 *
 * 上游：默认 GET https://api.ydc-index.io/contents（查询串 url + format），
 * 或 POST https://api.you.com/v1/contents（JSON 体 urls + format）；
 * 鉴权请求头 X-API-Key。
 * 语义：单地址单请求，网关 1..10 条限并发 5 扇出合并保序。
 * 零运行时依赖，原生 ESM，仅用全局 fetch；不打日志，不打印密钥。
 */

// 默认抓取端点（deps.fetchUrlYoucom 优先，兼容大小写）。
const DEFAULT_FETCH_URL = 'https://ydc-index.io/v1/contents';

// 新版端点标识：命中则用 POST JSON 体，否则用 GET 查询串。
const POST_ENDPOINT_MARK = '/v1/contents';

// 默认扇出并发（可用 deps.youcomConcurrency 覆盖，钳制在 1..5）。
const DEFAULT_CONCURRENCY = 5;

// 响应体上限 4MB（与网关 MAX_REQUEST_BYTES 对齐）。
const MAX_BYTES = 4 * 1024 * 1024;

// UTF-8 编解码器（字节级截断用，避免多字节字符被拦腰截断）。
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * 恒可重试的包内错误枚举。
 * @type {Set<string>}
 */
const ALWAYS_RETRYABLE = new Set([
  'timeout',
  'bot_blocked',
  'target_unreachable',
]);

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
 * 大小写兼容读取 deps 字段：先精确命中，再按小写扫描。
 * @param {any} deps 依赖对象
 * @param {string[]} wants 候选键（任意大小写）
 * @returns {string} 首个非空字符串，未命中为空串
 */
function pickField(deps, wants) {
  if (!deps || typeof deps !== 'object') return '';
  for (const w of wants) {
    const v = deps[w];
    if (typeof v === 'string' && v) return v;
  }
  /** @type {Record<string, any>} */
  const lower = {};
  for (const k of Object.keys(deps)) lower[String(k).toLowerCase()] = deps[k];
  for (const w of wants) {
    const v = lower[String(w).toLowerCase()];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * 从 deps 解析 You.com 密钥与抓取地址（空串视为缺失，地址键兼容大小写）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveYoucom(deps) {
  const apiKey = pickField(deps, ['youcomApiKey', 'youcomKey', 'YOUCOM_API_KEY', 'YOUCOM_KEY']);
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 YOUCOM_API_KEY 服务端环境变量');
  }
  const url =
    pickField(deps, [
      'fetchUrlYoucom',
      'youcomFetchUrl',
      'FETCH_URL_YOUCOM',
      'fetchurl_youcom',
    ]) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 判定包内单条错误是否可重试。
 * @param {string} error 错误枚举或错误文本
 * @param {number|undefined} status 伴随 HTTP 状态码
 * @returns {boolean} 是否可重试
 */
function isRetryable(error, status) {
  const text = String(error || '').toLowerCase();
  for (const name of ALWAYS_RETRYABLE) {
    if (text.includes(name)) return true;
  }
  if (ALWAYS_RETRYABLE.has(String(error || ''))) return true;
  if (typeof status === 'number' && (status === 408 || status === 429 || status >= 500)) return true;
  return false;
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
 * 从抓取正文中提取标题（HTML 取 <title>，markdown 取首个 # 标题，缺失为空串）。
 * @param {string} text 响应正文
 * @returns {string} 标题
 */
function extractTitle(text) {
  if (typeof text !== 'string' || !text) return '';
  const htmlTitle = /<title[^>]*>([\s\S]{1,500})<\/title>/i.exec(text);
  if (htmlTitle) return String(htmlTitle[1]).replace(/\s+/g, ' ').trim();
  const mdTitle = /^#{1,6}\s+(.+)$/m.exec(text);
  if (mdTitle) return String(mdTitle[1]).replace(/\s+/g, ' ').trim().slice(0, 200);
  return '';
}

/**
 * 从上游单条对象拼装正文：markdown > text > content > html。
 * @param {any} item 上游单条对象
 * @returns {string} 归一正文
 */
function pickContent(item) {
  if (!item || typeof item !== 'object') return '';
  const v =
    item.markdown ?? item.text ?? item.content ?? item.html ?? item.rawHtml ?? '';
  return typeof v === 'string' ? v : String(v || '');
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {string} apiKey You.com 密钥
 * @param {string} endpoint 抓取端点
 * @param {{format: string, perUrlTimeoutMs?: number}} options 单条选项
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<{url: string, finalUrl: string, title: string, content: string}>} 归一成功项
 */
async function fetchSingle(target, apiKey, endpoint, options, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  const format = options.format === 'html' ? 'html' : 'markdown';
  const timeoutMs = Number(options.perUrlTimeoutMs);
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  /** @type {any} */
  let signal;
  try {
    signal = hasTimeout ? AbortSignal.timeout(Math.floor(timeoutMs)) : undefined;
  } catch {
    signal = undefined;
  }
  const headers = {
    'X-API-Key': apiKey,
  };

  const usePost = String(endpoint || '').includes(POST_ENDPOINT_MARK);
  /** @type {string} */
  let requestUrl;
  /** @type {any} */
  let init;
  if (usePost) {
    // 新版端点：POST JSON 体一次一条，字段名按官方文档用 urls + formats。
    requestUrl = String(endpoint);
    init = {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [String(target)], formats: [format, 'metadata'] }),
    };
  } else {
    // 默认端点：GET 查询串一次一条。
    const search = new URLSearchParams();
    search.set('url', String(target));
    search.set('urls', String(target));
    search.set('format', format);
    if (hasTimeout) search.set('timeout', String(Math.floor(timeoutMs)));
    const separator = String(endpoint).includes('?') ? '&' : '?';
    requestUrl = String(endpoint) + separator + search.toString();
    init = { method: 'GET', headers };
  }
  if (signal !== undefined) init.signal = signal;

  /** @type {Response} */
  let res;
  try {
    res = await impl(requestUrl, init);
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'You.com 抓取请求失败：' + String(target), {
      retryable: true,
    });
  }

  // 401 密钥无效不可重试；402 余额不足不可重试；403 读体嗅探区分密钥与余额。
  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'You.com 密钥无效或无权限', {
      status: 401,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'You.com 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 403) {
    let bodyText = '';
    try {
      bodyText = typeof res.text === 'function' ? await res.text() : '';
    } catch {
      bodyText = '';
    }
    const lower = String(bodyText || '').toLowerCase();
    const isCredential =
      lower.includes('invalid') ||
      lower.includes('key') ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden') ||
      lower.includes('permission') ||
      lower.includes('access denied');
    if (isCredential) {
      throw fail('CREDENTIAL_MISSING', 'You.com 密钥无效或无权限', {
        status: 403,
        retryable: false,
      });
    }
    // 仅含余额语义才判余额不足；读体失败或无特征时沿用旧语义回余额不足。
    const isBilling =
      lower.includes('credit') ||
      lower.includes('quota') ||
      lower.includes('billing') ||
      lower.includes('payment') ||
      lower.includes('insufficient') ||
      lower.includes('fund');
    if (isBilling || !lower) {
      throw fail('INSUFFICIENT_CREDIT', 'You.com 余额不足', {
        status: 403,
        retryable: false,
      });
    }
    throw fail('INSUFFICIENT_CREDIT', 'You.com 余额不足', {
      status: 403,
      retryable: false,
    });
  }
  // 429/408/5xx 可重试。
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'You.com 限流（429）：' + String(target), {
      status: 429,
      retryable: true,
    });
  }
  if (res.status === 408 || res.status >= 500) {
    throw fail('UPSTREAM_ERROR', 'You.com 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: true,
    });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'You.com 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: false,
    });
  }

  // 上游响应形状动态，优先 JSON，失败回落纯文本；压为 any 后再取值。
  /** @type {any} */
  let data;
  try {
    data = await res.json();
  } catch {
    const text = await res.text();
    const content = truncateUtf8(String(text || ''), MAX_BYTES);
    return {
      url: String(target),
      finalUrl: String(target),
      title: extractTitle(content),
      content,
    };
  }
  if (typeof data === 'string') {
    const content = truncateUtf8(data, MAX_BYTES);
    return {
      url: String(target),
      finalUrl: String(target),
      title: extractTitle(content),
      content,
    };
  }
  const container = data && typeof data === 'object' ? data : {};
  // 官方文档顶层即数组：单条即数组首项，先收敛为容器再走统一解析。
  const topItem = Array.isArray(data) ? (data[0] ?? {}) : null;
  if (topItem && typeof topItem === 'object' && (topItem.url || topItem.title || topItem.html || topItem.markdown)) {
    const content = truncateUtf8(pickContent(topItem), MAX_BYTES);
    return {
      url: String(target),
      finalUrl: String(topItem.finalUrl || topItem.final_url || topItem.url || target),
      title: String(topItem.title || '') || extractTitle(content),
      content,
    };
  }
  // 包内错误：{error} 非空且无内容载荷时按单条失败结算。
  const rawList = Array.isArray(container.contents)
    ? container.contents
    : Array.isArray(container.results)
      ? container.results
      : Array.isArray(container.documents)
        ? container.documents
        : Array.isArray(container)
          ? container
          : null;
  /** @type {any} */
  let item;
  if (rawList) {
    item = rawList.find(
      (/** @type {any} */ entry) =>
        entry && (!entry.url || String(entry.url) === String(target)),
    ) ?? rawList[0];
  } else {
    item = container.content || container.markdown || container.text || container.html
      ? container
      : container.result ?? container.data ?? container.page ?? undefined;
  }
  if (!item || typeof item !== 'object') {
    const code = String((container && container.error) || 'target_unreachable');
    throw fail(code, 'You.com 抓取失败：' + String(target), {
      retryable: isRetryable(code, undefined),
    });
  }
  const itemError = item.error || item.status;
  const hasPayload =
    item.markdown ?? item.text ?? item.content ?? item.html ?? item.rawHtml ?? '';
  if (itemError && (typeof hasPayload !== 'string' || !hasPayload)) {
    const code = String(typeof itemError === 'string' ? itemError : 'target_unreachable');
    const status = typeof item.status === 'number' ? item.status : undefined;
    throw fail(code, 'You.com 抓取失败：' + String(target), {
      retryable: isRetryable(code, status),
      ...(status !== undefined ? { status } : {}),
    });
  }
  const content = truncateUtf8(pickContent(item), MAX_BYTES);
  return {
    url: String(target),
    finalUrl: String(item.finalUrl || item.final_url || item.url || target),
    title: String(item.title || '') || extractTitle(content),
    content,
  };
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
 * You.com 批量抓取（单请求单 URL，限并发扇出再合并，逐 URL 结算）。
 * @param {{urls: string[], format?: 'markdown'|'html', perUrlTimeoutMs?: number}} params
 *   统一抓输入（urls 1..10；format 映射 markdown/html；perUrlTimeoutMs 单条超时毫秒）
 * @param {any} deps 依赖（含 youcomApiKey、fetchUrlYoucom、fetchImpl）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>}>}
 *   归一后的成功与失败列表
 */
export async function youcomFetch(params, deps) {
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

  const format = params.format === 'html' ? 'html' : 'markdown';
  const { apiKey, url } = resolveYoucom(deps);
  const rawLimit = Number(deps && deps.youcomConcurrency);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(5, Math.floor(rawLimit)))
    : DEFAULT_CONCURRENCY;

  const targets = urls.map((u) => String(u));
  const settled = await mapLimit(targets, limit, (target) =>
    fetchSingle(
      target,
      apiKey,
      url,
      { format, perUrlTimeoutMs: params.perUrlTimeoutMs },
      fetchImpl,
    ),
  );

  // 成功与失败列表元素形状不同，压为 any[]，避免联合赋值报错。
  const results = /** @type {any[]} */ ([]);
  const errors = /** @type {any[]} */ ([]);
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.ok) {
      results.push(item.value);
    } else {
      // 捕获异常为未知形状，转 any 后再取 code/status/retryable；未知异常默认可重试以便走回退。
      const caught = /** @type {any} */ (item.error);
      // 错误条目需动态追加 status，压为 any，避免缺失字段报错。
      const entry = /** @type {any} */ ({
        url: targets[i],
        error: String((caught && caught.code) || 'target_unreachable'),
        retryable: caught && caught.retryable !== undefined ? !!caught.retryable : true,
      });
      if (caught && caught.status !== undefined) entry.status = caught.status;
      errors.push(entry);
    }
  }
  return { results, errors };
}
