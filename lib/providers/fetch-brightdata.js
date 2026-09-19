/**
 * BrightData 攻坚抓取供应商（单请求单 URL，限并发扇出适配批量）。
 *
 * 上游：POST https://api.brightdata.com/request，请求头 Authorization: Bearer。
 * 请求体含 url / format=markdown，zone 可选（deps.brightdataZone 优先，有值才带）。
 * 档位策略：简单页默认不升档（不主动加解锁参数），难页由调用方显式透传
 * unlocker/render 等参数进请求体，避免简单页被动加价。
 *
 * 失败规则：
 * - 401 密钥无效不可重试；402/403 余额不足或超限不可重试；
 *   429/408/5xx 可重试；其余非 2xx 默认不可重试。
 * - 包内失败（200 正文为错误 JSON，含 timeout/bot_blocked/target_unreachable
 *   语义）恒可重试，由调用方回退结算。
 * - 成功透实际扣费：优先读响应头扣费字段，其次读 JSON 正文点数字段，
 *   累加进 usage.billedCredits（无值时不附 usage）。
 *
 * 零运行时依赖，原生 ESM，仅用全局 fetch；不打日志，不打印密钥。
 */

// 默认抓取端点（deps.fetchUrlBrightdata 大小写兼容优先）。
const DEFAULT_FETCH_URL = 'https://api.brightdata.com/request';

// 网关单批上限（与 tools.js 校验对齐，超出直接 INVALID_PARAMS）。
const MAX_URLS = 10;

// 默认扇出并发（攻坚接口易限流，取 3，可由 deps.brightdataConcurrency 覆盖钳制 1..5）。
const DEFAULT_CONCURRENCY = 3;

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
 * 大小写兼容地从 deps 取值（地址覆盖键兼容大小写）。
 * @param {any} deps 依赖对象
 * @param {string[]} names 候选键（统一转小写比对）
 * @returns {any} 首个命中的值（全 miss 返回 undefined）
 */
function pickKey(deps, names) {
  if (!deps || typeof deps !== 'object') return undefined;
  const wanted = new Set(names.map((n) => String(n).toLowerCase()));
  for (const key of Object.keys(deps)) {
    if (wanted.has(String(key).toLowerCase())) {
      const value = deps[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

/**
 * 从 deps 解析 BrightData 密钥与抓取地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveBrightdata(deps) {
  const apiKey =
    pickKey(deps, ['brightdataApiKey', 'brightdataKey', 'BRIGHTDATA_API_KEY']) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 BRIGHTDATA_API_KEY 服务端环境变量');
  }
  const url =
    pickKey(deps, ['fetchUrlBrightdata', 'brightdataFetchUrl']) || DEFAULT_FETCH_URL;
  return { apiKey: String(apiKey), url: String(url) };
}

/**
 * 解析可用区：deps.brightdataZone 优先，其次 params.zone。
 * @param {any} params 统一抓取输入
 * @param {any} deps 依赖
 * @returns {string} 可用区标识（缺失为空串）
 */
function resolveZone(params, deps) {
  const fromDeps = pickKey(deps, ['brightdataZone', 'BRIGHTDATA_ZONE', 'zone']);
  if (typeof fromDeps === 'string' && fromDeps) return fromDeps;
  const fromParams = params && (params.zone ?? params.brightdataZone);
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  return '';
}

/**
 * 解析难页解锁参数：显式透传优先，简单页默认不升档。
 * @param {any} params 统一抓取输入（unlocker/unblocker/render/country 可透传）
 * @param {any} deps 依赖（brightdataUnlocker 全局开关）
 * @returns {{unlocker: any, render: boolean, country?: string}} 生效的解锁参数
 */
function resolveUnlocker(params, deps) {
  const unlocker =
    (params && (params.unlocker ?? params.unblocker)) ??
    pickKey(deps, ['brightdataUnlocker', 'BRIGHTDATA_UNLOCKER']);
  const renderRaw =
    (params && params.render) ?? pickKey(deps, ['brightdataRender', 'BRIGHTDATA_RENDER']);
  const render = renderRaw === true || renderRaw === 'true';
  const countryRaw =
    (params && (params.country ?? params.countryCode ?? params.country_code)) ??
    pickKey(deps, ['brightdataCountry', 'BRIGHTDATA_COUNTRY']);
  const out = /** @type {any} */ ({ unlocker, render });
  if (typeof countryRaw === 'string' && countryRaw.trim()) {
    out.country = countryRaw.trim().toLowerCase();
  }
  return out;
}

/**
 * 组装上游请求体：url/format 必含，zone 仅非空时携带，解锁参数按需透传。
 * @param {string} zone 可用区标识（可选，空串不携带）
 * @param {string} target 目标 URL
 * @param {string} format 正文形态（markdown/html/text）
 * @param {{unlocker: any, render: boolean, country?: string}} unlocker 解锁参数
 * @returns {any} 上游 JSON 请求体
 */
function buildBody(zone, target, unlocker, format) {
  const body = /** @type {any} */ ({ url: String(target), format });
  // 可用区可选：仅非空时携带，缺失时只发 url/format 与解锁参数。
  if (typeof zone === 'string' && zone) body.zone = zone;
  // 解锁器对象整体透传（如 { render, country } 由调用方按难页定制）。
  if (unlocker.unlocker !== undefined && unlocker.unlocker !== false && unlocker.unlocker !== null) {
    if (typeof unlocker.unlocker === 'object') Object.assign(body, unlocker.unlocker);
    else if (unlocker.unlocker === true || unlocker.unlocker === 'true') body.unlocker = true;
    else body.unlocker = unlocker.unlocker;
  }
  // 渲染与地理定向便捷开关（显式传入才带上，简单页不升档）。
  if (unlocker.render) body.render = true;
  if (unlocker.country) body.country = unlocker.country;
  return body;
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
 * 从响应头读取实际扣费（多候选头名，首个有限数值胜出）。
 * @param {any} res 抓取响应
 * @returns {number|undefined} 实际扣费（无值返回 undefined）
 */
function billedFromHeaders(res) {
  const candidates = [
    'x-bd-credits',
    'x-brightdata-credits',
    'x-brightdata-cost',
    'brightdata-request-cost',
    'brightdata-credit-cost',
  ];
  for (const name of candidates) {
    const n = Number(headerValue(res, name));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 从 JSON 正文读取实际扣费（多候选字段，首个有限数值胜出）。
 * @param {any} data 上游 JSON 正文
 * @returns {number|undefined} 实际扣费（无值返回 undefined）
 */
function billedFromBody(data) {
  if (!data || typeof data !== 'object') return undefined;
  const candidates = [
    data.credits_used,
    data.creditsUsed,
    data.billed_credits,
    data.billedCredits,
    data.cost,
    data.credits,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
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
 * 从上游 JSON 成功体拼装正文（markdown > text > content/html > result）。
 * @param {any} data 上游 JSON 正文
 * @returns {string} 归一正文（非 JSON 成功体返回空串由调用方回落原文）
 */
function pickJsonContent(data) {
  if (!data || typeof data !== 'object') return '';
  const v =
    data.markdown ?? data.text ?? data.content ?? data.html ?? data.result ?? data.body ?? '';
  return typeof v === 'string' ? v : v !== '' && v !== undefined ? String(v) : '';
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {string} apiKey BrightData 密钥
 * @param {string} endpoint 抓取端点
 * @param {string} zone 可用区标识
 * @param {{format: string, perUrlTimeoutMs?: number, unlocker: any, render: boolean, country?: string}} options 单条选项
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<{url: string, finalUrl: string, title: string, content: string, billed?: number}>} 归一成功项
 */
async function fetchSingle(target, apiKey, endpoint, zone, options, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  const body = buildBody(zone, target, options, options.format);
  const timeoutMs = Number(options.perUrlTimeoutMs);
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.floor(timeoutMs))
      : undefined;

  /** @type {Response} */
  let res;
  try {
    res = await impl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'BrightData 抓取请求失败：' + String(target), {
      retryable: true,
    });
  }

  // 401 密钥无效不可重试；402/403 余额不足或超限不可重试。
  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'BrightData 密钥无效或无权限', {
      status: 401,
      retryable: false,
    });
  }
  if (res.status === 402 || res.status === 403) {
    throw fail('INSUFFICIENT_CREDIT', 'BrightData 余额不足或请求超限', {
      status: res.status,
      retryable: false,
    });
  }
  // 429 限流、408 超时、5xx 服务端异常可重试。
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'BrightData 限流（429）：' + String(target), {
      status: 429,
      retryable: true,
    });
  }
  if (res.status === 408 || res.status >= 500) {
    throw fail('UPSTREAM_ERROR', 'BrightData 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: true,
    });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'BrightData 抓取异常：' + target + ' HTTP ' + res.status, {
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
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const innerError = /** @type {any} */ (data).error ?? /** @type {any} */ (data).message;
    const innerStatus = String(
      /** @type {any} */ (data).status ?? /** @type {any} */ (data).success ?? 'ok',
    ).toLowerCase();
    const failed =
      innerError !== undefined ||
      innerStatus === 'error' ||
      innerStatus === 'fail' ||
      innerStatus === 'failed' ||
      innerStatus === 'false';
    const content = pickJsonContent(data);
    if (failed && !content) {
      const text = String(
        (typeof innerError === 'string' ? innerError : innerError?.message) ??
          /** @type {any} */ (data).message ??
          'fetch_failed',
      );
      throw fail(innerCode(text), 'BrightData 抓取失败：' + String(target) + ' ' + text, {
        retryable: true,
      });
    }
    if (content) {
      const billed = billedFromHeaders(res) ?? billedFromBody(data);
      const done = /** @type {any} */ ({
        url: String(target),
        finalUrl: String(
          /** @type {any} */ (data).finalUrl ?? /** @type {any} */ (data).url ?? target,
        ),
        title: extractTitle(content),
        content: truncateUtf8(content, MAX_BYTES),
      });
      if (billed !== undefined) done.billed = billed;
      return done;
    }
  }

  // 原文成功体（markdown/HTML 直接回正文）。
  const content = truncateUtf8(rawText, MAX_BYTES);
  const billed = billedFromHeaders(res);
  const done = /** @type {any} */ ({
    url: String(target),
    finalUrl: String(target),
    title: extractTitle(content),
    content,
  });
  if (billed !== undefined) done.billed = billed;
  return done;
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
 * BrightData 批量抓取（单请求单 URL，限并发 3 扇出再合并，逐 URL 结算）。
 * @param {{urls: string[], format?: 'markdown'|'html'|'text', zone?: string, brightdataZone?: string, unlocker?: any, unblocker?: any, render?: boolean, country?: string, countryCode?: string, country_code?: string, perUrlTimeoutMs?: number}} params
 *   统一抓输入（urls 1..10；format 正文形态缺省 markdown；zone 可用区；
 *   unlocker/unblocker/render/country 仅难页透传；perUrlTimeoutMs 单条超时毫秒）
 * @param {any} deps 依赖（含 brightdataApiKey、fetchUrlBrightdata 大小写兼容、brightdataZone、brightdataConcurrency）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>, usage?: any}>}
 *   归一后的成功与失败列表（usage 仅实际扣费可观测时附带 billedCredits）
 */
export async function brightdataFetch(params, deps) {
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
  const { apiKey, url } = resolveBrightdata(deps);
  const zone = resolveZone(params, deps);
  const format =
    params.format === 'html' ? 'html' : params.format === 'text' ? 'text' : 'markdown';
  const unlocker = resolveUnlocker(params, deps);
  // 并发默认 3，付费提额可由 deps.brightdataConcurrency 覆盖（仍钳制防打爆）。
  const rawLimit = Number(pickKey(deps, ['brightdataConcurrency', 'BRIGHTDATA_CONCURRENCY']));
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(5, Math.floor(rawLimit)))
    : DEFAULT_CONCURRENCY;

  const targets = urls.map((u) => String(u));
  const settled = await mapLimit(targets, limit, (target) =>
    fetchSingle(
      target,
      apiKey,
      url,
      zone,
      { format, perUrlTimeoutMs: params.perUrlTimeoutMs, ...unlocker },
      fetchImpl,
    ),
  );

  // 成功与失败列表元素形状不同，压为 any[]，避免联合赋值报错。
  const results = /** @type {any[]} */ ([]);
  const errors = /** @type {any[]} */ ([]);
  let billedCredits = 0;
  let hasBilled = false;
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.ok) {
      const value = /** @type {any} */ (item.value);
      const out = /** @type {any} */ ({
        url: value.url,
        finalUrl: value.finalUrl,
        title: value.title,
        content: value.content,
      });
      results.push(out);
      if (typeof value.billed === 'number') {
        billedCredits += value.billed;
        hasBilled = true;
      }
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
  const out = /** @type {any} */ ({ results, errors });
  // 成功透实际扣费：仅响应携带扣费值时附 usage。
  if (hasBilled) out.usage = { provider: 'brightdata', billedCredits };
  return out;
}
