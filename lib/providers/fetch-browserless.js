/**
 * Browserless 抓取供应商（单请求单 URL，限并发扇出适配批量）。
 *
 * 上游：POST https://production-sfo.browserless.io/scrape?token=KEY（token 走 query 鉴权）。
 * 请求体含 url / elements（默认 [{ selector: 'body' }] 全文选择器）。
 * 成功体解析 data/results 数组（兼容 smart-scrape 变体），取 text/markdown/html
 * 字段拼装正文；非 JSON 成功体回落原文。
 *
 * 失败规则：
 * - 401 密钥无效不可重试；402/403 余额不足或超限不可重试；
 *   429/408/5xx 可重试；其余非 2xx 默认不可重试。
 * - 包内失败（200 正文为错误 JSON，含 timeout/bot_blocked/target_unreachable
 *   语义）恒可重试，由调用方回退结算。
 *
 * 零运行时依赖，原生 ESM，仅用全局 fetch；不打日志，不打印密钥。
 */

// 默认抓取端点（deps.fetchUrlBrowserless 优先，token 统一拼 query）。
const DEFAULT_FETCH_URL = 'https://production-sfo.browserless.io/scrape';

// 网关单批上限（与 tools.js 校验对齐，超出直接 INVALID_PARAMS）。
const MAX_URLS = 10;

// 默认扇出并发（取 2 限流，可由 deps.browserlessConcurrency 覆盖钳制 1..5）。
const DEFAULT_CONCURRENCY = 2;

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
 * 从 deps 解析 Browserless 密钥与抓取地址（空串视为缺失，扁平键）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveBrowserless(deps) {
  const apiKey =
    (deps &&
      (deps.browserlessApiKey ?? deps.browserlessKey ?? deps.BROWSERLESS_API_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 BROWSERLESS_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlBrowserless || deps.browserlessFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey: String(apiKey), url: String(url) };
}

/**
 * 拼接 token 查询串（端点已带 token 时直接复用，避免重复追加）。
 * @param {string} endpoint 抓取端点（可被 deps.fetchUrlBrowserless 覆盖）
 * @param {string} apiKey Browserless 密钥
 * @returns {string} 携带 token 的请求地址
 */
function withToken(endpoint, apiKey) {
  if (endpoint.includes('token=')) return endpoint;
  const separator = endpoint.includes('?') ? '&' : '?';
  return endpoint + separator + 'token=' + encodeURIComponent(apiKey);
}

/**
 * 组装上游请求体：url 必含，elements 默认 body 全文选择器。
 * @param {string} target 目标 URL
 * @param {any} elements 调用方透传的选择器数组（可选）
 * @returns {any} 上游 JSON 请求体
 */
function buildBody(target, elements) {
  const list =
    Array.isArray(elements) && elements.length > 0
      ? elements
      : [{ selector: 'body' }];
  return { url: String(target), elements: list };
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
 * 判定包内失败文本是否命中恒可重试语义（timeout/bot_blocked/target_unreachable）。
 * @param {string} text 包内错误文本
 * @returns {string} 归一错误码
 */
function innerCode(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'UPSTREAM_TIMEOUT';
  if (lower.includes('bot') || lower.includes('block')) return 'bot_blocked';
  if (lower.includes('unreachable')) return 'target_unreachable';
  return 'UPSTREAM_ERROR';
}

/**
 * 从结果条目提取正文字段（text/markdown 优先，其次 html/content/result/body）。
 * @param {any} item 单条结果（字符串或对象）
 * @returns {string} 条目正文（无值为空串）
 */
function textFromItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const v =
    item.text ?? item.markdown ?? item.html ?? item.content ?? item.result ?? item.body ?? '';
  return typeof v === 'string' ? v : v !== '' && v !== undefined ? String(v) : '';
}

/**
 * 从上游 JSON 成功体拼装正文（data/results 数组兼容 smart-scrape 变体）。
 * @param {any} data 上游 JSON 正文
 * @returns {string} 归一正文（无可用字段返回空串由调用方回落原文）
 */
function pickJsonContent(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    const parts = data.map(textFromItem).filter((s) => typeof s === 'string' && s);
    return parts.join('\n\n');
  }
  if (!data || typeof data !== 'object') return '';
  const groups = [];
  if (data.data !== undefined) groups.push(data.data);
  if (data.results !== undefined) groups.push(data.results);
  const parts = [];
  for (const group of groups) {
    if (typeof group === 'string' && group) {
      parts.push(group);
    } else if (Array.isArray(group)) {
      for (const item of group) {
        // 元素组形如 { selector, results: [{ text, html }] } 时展开内层。
        if (item && typeof item === 'object' && Array.isArray(item.results)) {
          for (const inner of item.results) {
            const text = textFromItem(inner);
            if (text) parts.push(text);
          }
        } else {
          const text = textFromItem(item);
          if (text) parts.push(text);
        }
      }
    } else if (group && typeof group === 'object') {
      const text = textFromItem(group);
      if (text) parts.push(text);
    }
  }
  // 顶层直挂字段（smart-scrape 变体可能直接回 text/html）。
  const top = textFromItem(data);
  if (top && !parts.includes(top)) parts.push(top);
  return parts.join('\n\n');
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {string} apiKey Browserless 密钥
 * @param {string} endpoint 抓取端点
 * @param {{elements?: any, perUrlTimeoutMs?: number}} options 单条选项
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<{url: string, finalUrl: string, title: string, content: string}>} 归一成功项
 */
async function fetchSingle(target, apiKey, endpoint, options, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  const requestUrl = withToken(endpoint, apiKey);
  const body = buildBody(target, options.elements);
  const timeoutMs = Number(options.perUrlTimeoutMs);
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.floor(timeoutMs))
      : undefined;

  /** @type {Response} */
  let res;
  try {
    res = await impl(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'Browserless 抓取请求失败：' + String(target), {
      retryable: true,
    });
  }

  // 401 密钥无效不可重试；402/403 余额不足或超限不可重试。
  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'Browserless 密钥无效或无权限', {
      status: 401,
      retryable: false,
    });
  }
  if (res.status === 402 || res.status === 403) {
    throw fail('INSUFFICIENT_CREDIT', 'Browserless 余额不足或请求超限', {
      status: res.status,
      retryable: false,
    });
  }
  // 429 限流、408 超时、5xx 服务端异常可重试。
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'Browserless 限流（429）：' + String(target), {
      status: 429,
      retryable: true,
    });
  }
  if (res.status === 408 || res.status >= 500) {
    throw fail('UPSTREAM_ERROR', 'Browserless 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: true,
    });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Browserless 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: false,
    });
  }

  const rawText = String(await res.text());
  // 包内失败：200 正文为错误 JSON（含 timeout/bot_blocked/target_unreachable 语义）恒可重试。
  let data;
  try {
    const trimmed = rawText.trim();
    data =
      trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(trimmed) : undefined;
  } catch {
    data = undefined;
  }
  if (data !== undefined) {
    const content = pickJsonContent(data);
    if (content) {
      const body = truncateUtf8(content, MAX_BYTES);
      const obj = /** @type {any} */ (Array.isArray(data) ? {} : data);
      const finalUrl = String(obj.finalUrl ?? obj.url ?? target);
      return { url: String(target), finalUrl, title: extractTitle(body), content: body };
    }
    // 有 JSON 却无正文：按包内失败结算（恒可重试）。
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const innerError = /** @type {any} */ (data).error ?? /** @type {any} */ (data).message;
      if (innerError !== undefined) {
        const text = String(
          typeof innerError === 'string' ? innerError : innerError?.message ?? 'fetch_failed',
        );
        throw fail(innerCode(text), 'Browserless 抓取失败：' + String(target) + ' ' + text, {
          retryable: true,
        });
      }
    }
  }

  // 原文成功体（纯文本/HTML 直接回正文）。
  const content = truncateUtf8(rawText, MAX_BYTES);
  return {
    url: String(target),
    finalUrl: String(target),
    title: extractTitle(content),
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
 * Browserless 批量抓取（单请求单 URL，限并发 2 扇出再合并，逐 URL 结算）。
 * @param {{urls: string[], elements?: any, perUrlTimeoutMs?: number}} params
 *   统一抓输入（urls 1..10；elements 上游选择器数组缺省 body 全文；perUrlTimeoutMs 单条超时毫秒）
 * @param {any} deps 依赖（含 browserlessApiKey/BROWSERLESS_API_KEY、fetchUrlBrowserless、browserlessConcurrency）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>}>}
 *   归一后的成功与失败列表
 */
export async function browserlessFetch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const urls = params && params.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_URLS) {
    throw fail('INVALID_PARAMS', 'urls 必须为 1..10 个 URL 的数组');
  }
  for (const u of urls) {
    if (typeof u !== 'string' || !(u.startsWith('http://') || u.startsWith('https://'))) {
      throw fail('INVALID_PARAMS', 'urls 仅支持 http/https 字符串：' + String(u));
    }
  }

  // 缺键直接抛码，不触碰网络。
  const { apiKey, url } = resolveBrowserless(deps);
  // 并发默认 2，可由 deps.browserlessConcurrency 覆盖（仍钳制防打爆）。
  const rawLimit = Number(deps && deps.browserlessConcurrency);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(5, Math.floor(rawLimit)))
    : DEFAULT_CONCURRENCY;

  const targets = urls.map((u) => String(u));
  const settled = await mapLimit(targets, limit, (target) =>
    fetchSingle(
      target,
      apiKey,
      url,
      { elements: params.elements, perUrlTimeoutMs: params.perUrlTimeoutMs },
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
