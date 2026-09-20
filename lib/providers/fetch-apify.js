/**
 * Apify 抓取供应商（三段式 run + poll + dataset items，限并发扇出适配批量）。
 *
 * 上游：POST {base}/acts/{actor}/runs?token=... 启动抓取，
 * 轮询 GET {base}/actor-runs/{runId}?token=... 至 SUCCEEDED（约 30 秒上限），
 * 再读 GET {base}/datasets/{datasetId}/items?token=... 取正文归一。
 * 地址覆盖：deps.fetchUrlApify（大小写兼容 apifyFetchUrl）优先，
 * 缺省 https://api.apify.com/v2。
 * 演员：deps.apifyActorId 优先，缺省 apify/website-content-crawler；
 * token 只进查询串，不进日志不进请求体。
 * 请求体：单 URL 单 run（startUrls 单条 + maxCrawlPages 1），format 只决定
 * 本地取字段优先级，不上调上游档位；maxTotalChargeUsd 本地熔断预检并透传 runs 查询串。
 *
 * 熔断与失败计费：
 * - maxTotalChargeUsd：服务端预算上限，本地先按单条预估上界预检，超限不发网直接记
 *   errors（status 402，retryable false）；跑出的 totalChargeUsd 累加进 usage.totalChargeUsd。
 * - 401 密钥无效不可重试；402/403 余额不足或超限不可重试；
 *   429/408/5xx 可重试；其余非 2xx 默认不可重试。
 * - 包内失败（run FAILED 文本或 dataset 空项含 timeout/bot_blocked/target_unreachable
 *   语义）恒可重试，由调用方回退结算。
 *
 * 零运行时依赖，原生 ESM，仅用全局 fetch；不打日志，不打印密钥。
 */

// 默认抓取基址（deps.fetchUrlApify 大小写兼容优先）。
const DEFAULT_BASE_URL = 'https://api.apify.com/v2';

// 默认演员（deps.apifyActorId 优先）。
const DEFAULT_ACTOR_ID = 'apify/website-content-crawler';

// 网关单批上限（与 tools.js 校验对齐，超出直接 INVALID_PARAMS）。
const MAX_URLS = 10;

// 默认扇出并发（三段式 run+poll 偏重，取 2，可由 deps.apifyConcurrency 覆盖钳制 1..5）。
const DEFAULT_CONCURRENCY = 2;

// 轮询上限约 30 秒，间隔 1 秒。
const POLL_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

// 单条预估费用上界美元（用于 maxTotalChargeUsd 本地熔断预检，宁可早熔断也不超支）。
const ESTIMATED_USD_PER_URL = 0.01;

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
 * 从 deps 解析 Apify 密钥、演员与抓取基址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥、演员与端点地址）
 * @returns {{apiKey: string, actorId: string, baseUrl: string}} 密钥、演员与基址
 */
function resolveApify(deps) {
  const apiKey =
    pickKey(deps, ['apifyApiKey', 'apifyKey', 'APIFY_API_KEY', 'apifyToken', 'APIFY_TOKEN']) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 APIFY_API_KEY 服务端环境变量');
  }
  const actorRaw =
    pickKey(deps, ['apifyActorId', 'apifyActor', 'APIFY_ACTOR_ID', 'actorId']) || DEFAULT_ACTOR_ID;
  const actorId = String(actorRaw).trim() || DEFAULT_ACTOR_ID;
  const baseRaw =
    pickKey(deps, ['fetchUrlApify', 'apifyFetchUrl', 'APIFY_FETCH_URL']) || DEFAULT_BASE_URL;
  const baseUrl = String(baseRaw).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return { apiKey: String(apiKey), actorId, baseUrl };
}
/**
 * 解析 actor 在 runs 路径中的形态（Apify 用 ~ 分隔，兼容斜杠写法）。
 * @param {string} actorId 演员标识
 * @returns {string} 路径片段
 */
function actorPath(actorId) {
  return String(actorId).trim().split('/').join('~');
}

/**
 * 解析费用熔断上限（美元，正数才生效）。
 * @param {any} params 统一抓取输入
 * @param {any} deps 依赖
 * @returns {number|undefined} 熔断上限
 */
function resolveMaxCharge(params, deps) {
  const fromParams = params ? (params.maxTotalChargeUsd ?? params.maxChargeUsd ?? params.maxCost) : undefined;
  const fromSnake = params ? (params.max_total_charge_usd ?? params.max_cost) : undefined;
  const raw = fromParams ?? fromSnake ?? pickKey(deps, ['apifyMaxTotalChargeUsd', 'maxTotalChargeUsd']);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
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
 * 从抓取正文中提取标题（HTML 取 title，markdown 取首个井号标题，缺失为空串）。
 * @param {string} text 响应正文
 * @returns {string} 标题
 */
function extractTitle(text) {
  if (typeof text !== 'string' || !text) return '';
  const lower = text.toLowerCase();
  const open = lower.indexOf('<title');
  if (open !== -1) {
    const start = text.indexOf('>', open);
    const end = lower.indexOf('</title', start);
    if (start !== -1 && end !== -1 && end > start) {
      const raw = text.slice(start + 1, end).split(/\s+/).join(' ').trim();
      if (raw) return raw.slice(0, 200);
    }
  }
  const parts = text.split('\n');
  for (const line of parts) {
    const t = line.trim();
    if (t.charAt(0) === '#') {
      const h = t.replace(/^#+\s*/, '').trim();
      if (h) return h.slice(0, 200);
    }
  }
  return '';
}

/**
 * 判定包内失败文本是否命中恒可重试语义（timeout/bot_blocked/target_unreachable）。
 * @param {string} text 包内错误文本
 * @returns {string} 归一错误码
 */
function innerCode(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.indexOf('timeout') !== -1 || lower.indexOf('timed out') !== -1) return 'UPSTREAM_TIMEOUT';
  if (lower.indexOf('bot') !== -1 || lower.indexOf('block') !== -1) return 'bot_blocked';
  if (lower.indexOf('unreachable') !== -1) return 'target_unreachable';
  return 'UPSTREAM_ERROR';
}

/**
 * 按 HTTP 状态构造上游错误（401 不可重试；402/403 不可重试；429/408/5xx 可重试）。
 * @param {string} label 阶段名（run/poll/items）
 * @param {string} target 目标 URL
 * @param {number} status HTTP 状态码
 * @returns {Error & {code: string, status?: number, retryable?: boolean}} 结构化错误
 */
function httpError(label, target, status) {
  if (status === 401) {
    return fail('CREDENTIAL_MISSING', 'Apify ' + label + '密钥无效或无权限：' + target, { status: status, retryable: false });
  }
  if (status === 402 || status === 403) {
    return fail('INSUFFICIENT_CREDIT', 'Apify ' + label + '余额不足或请求超限：' + target, { status: status, retryable: false });
  }
  if (status === 429) {
    return fail('UPSTREAM_RATE_LIMITED', 'Apify ' + label + '限流：' + target, { status: status, retryable: true });
  }
  if (status === 408 || status >= 500) {
    return fail('UPSTREAM_ERROR', 'Apify ' + label + '抓取异常：' + target + ' HTTP ' + status, { status: status, retryable: true });
  }
  return fail('UPSTREAM_ERROR', 'Apify ' + label + '抓取异常：' + target + ' HTTP ' + status, { status: status, retryable: false });
}

/**
 * 从 dataset 单项拼装正文（html 档优先 html 字段，其余 markdown 优先）。
 * @param {any} item dataset 单项
 * @param {string} format 正文形态
 * @returns {string} 归一正文
 */
function pickItemContent(item, format) {
  if (!item || typeof item !== 'object') return '';
  if (format === 'html') {
    const v = item.html ?? item.rawHtml ?? item.markdown ?? item.text ?? item.content ?? '';
    return typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v));
  }
  const v = item.markdown ?? item.text ?? item.content ?? item.html ?? item.rawHtml ?? '';
  return typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v));
}
/**
 * 启动单条 run（第一段）。
 * @param {string} target 目标 URL
 * @param {string} baseUrl 抓取基址
 * @param {string} actorId 演员标识
 * @param {string} apiKey 密钥（只进查询串）
 * @param {number|undefined} maxCharge 熔断上限美元
 * @param {(url: string, init?: any) => Promise<Response>} fetchImpl 抓取实现
 * @returns {Promise<{runId: string, datasetHint?: string}>} 运行标识与数据集提示
 */
async function startRun(target, baseUrl, actorId, apiKey, maxCharge, fetchImpl) {
  let runsUrl = baseUrl + '/acts/' + actorPath(actorId) + '/runs?token=' + encodeURIComponent(apiKey);
  if (maxCharge !== undefined) runsUrl += '&maxTotalChargeUsd=' + encodeURIComponent(String(maxCharge));
  const body = { startUrls: [{ url: String(target) }], maxCrawlPages: 1 };
  let res;
  try {
    res = await fetchImpl(runsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw fail('UPSTREAM_UNAVAILABLE', 'Apify 启动抓取失败：' + String(target), { retryable: true });
  }
  if (!res.ok) throw httpError('run', String(target), res.status);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw fail('UPSTREAM_ERROR', 'Apify 启动回包非 JSON：' + String(target), { retryable: true });
  }
  const inner = data && typeof data === 'object' && data.data !== undefined ? data.data : data;
  const runId = inner ? (inner.id ?? inner.runId) : undefined;
  if (typeof runId !== 'string' || !runId) {
    throw fail('UPSTREAM_ERROR', 'Apify 启动回包缺 runId：' + String(target), { retryable: true });
  }
  const hint = inner ? (inner.defaultDatasetId ?? inner.datasetId) : undefined;
  const out = /** @type {any} */ ({ runId: runId });
  if (typeof hint === 'string' && hint) out.datasetHint = hint;
  return out;
}

/**
 * 轮询 run 至终态（第二段，上限约 30 秒）。
 * @param {string} runId 运行标识
 * @param {string|undefined} datasetHint 启动回包带的数据集提示
 * @param {string} target 目标 URL
 * @param {string} baseUrl 抓取基址
 * @param {string} apiKey 密钥
 * @param {number} deadlineMs 轮询截止时间戳
 * @param {(url: string, init?: any) => Promise<Response>} fetchImpl 抓取实现
 * @returns {Promise<{datasetId: string, charge?: number}>} 数据集标识与扣费美元
 */
async function pollRun(runId, datasetHint, target, baseUrl, apiKey, deadlineMs, fetchImpl) {
  const runUrl = baseUrl + '/actor-runs/' + encodeURIComponent(runId) + '?token=' + encodeURIComponent(apiKey);
  for (;;) {
    let res;
    try {
      res = await fetchImpl(runUrl, { method: 'GET' });
    } catch (e) {
      throw fail('UPSTREAM_UNAVAILABLE', 'Apify 轮询失败：' + String(target), { retryable: true });
    }
    if (!res.ok) throw httpError('poll', String(target), res.status);
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw fail('UPSTREAM_ERROR', 'Apify 轮询回包非 JSON：' + String(target), { retryable: true });
    }
    const inner = body && typeof body === 'object' && body.data !== undefined ? body.data : body;
    const status = String((inner && (inner.status ?? inner.runStatus)) || '').toUpperCase();
    const datasetId = (inner && (inner.defaultDatasetId ?? inner.datasetId)) || datasetHint || undefined;
    const stats = (inner && inner.stats) || {};
    const chargeRaw = stats.totalChargeUsd ?? (inner ? (inner.totalChargeUsd ?? inner.usageTotalUsd) : undefined);
    const chargeNum = chargeRaw === undefined || chargeRaw === null ? NaN : Number(chargeRaw);
    const charge = Number.isFinite(chargeNum) ? chargeNum : undefined;
    if (status === 'SUCCEEDED') {
      if (typeof datasetId !== 'string' || !datasetId) {
        throw fail('UPSTREAM_ERROR', 'Apify 成功回包缺 datasetId：' + String(target), { retryable: true });
      }
      const done = /** @type {any} */ ({ datasetId: datasetId });
      if (charge !== undefined) done.charge = charge;
      return done;
    }
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT' || status === 'TIMEOUT') {
      const text = String((inner && (inner.statusMessage ?? inner.error ?? inner.message)) || 'run_failed');
      const lower = text.toLowerCase();
      if (lower.indexOf('credit') !== -1 || lower.indexOf('quota') !== -1 || lower.indexOf('402') !== -1 || lower.indexOf('403') !== -1) {
        throw fail('INSUFFICIENT_CREDIT', 'Apify 抓取余额不足：' + String(target), { retryable: false });
      }
      if (lower.indexOf('401') !== -1 || lower.indexOf('unauthorized') !== -1) {
        throw fail('CREDENTIAL_MISSING', 'Apify 抓取密钥无效：' + String(target), { status: 401, retryable: false });
      }
      if (status === 'TIMED-OUT' || status === 'TIMEOUT') {
        throw fail('UPSTREAM_TIMEOUT', 'Apify 抓取超时：' + String(target) + ' ' + text, { retryable: true });
      }
      throw fail(innerCode(text), 'Apify 抓取失败：' + String(target) + ' ' + text, { retryable: true });
    }
    if (Date.now() >= deadlineMs) {
      throw fail('UPSTREAM_TIMEOUT', 'Apify 轮询超时：' + String(target), { retryable: true });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
/**
 * 拉取 dataset items 并归一（第三段）。
 * @param {string} datasetId 数据集标识
 * @param {string} target 目标 URL
 * @param {string} baseUrl 抓取基址
 * @param {string} apiKey 密钥
 * @param {string} format 正文形态
 * @param {(url: string, init?: any) => Promise<Response>} fetchImpl 抓取实现
 * @returns {Promise<any>} 归一成功项
 */
async function fetchItems(datasetId, target, baseUrl, apiKey, format, fetchImpl) {
  const itemsUrl = baseUrl + '/datasets/' + encodeURIComponent(datasetId) + '/items?token=' + encodeURIComponent(apiKey) + '&limit=5&clean=true&format=json';
  let res;
  try {
    res = await fetchImpl(itemsUrl, { method: 'GET' });
  } catch (e) {
    throw fail('UPSTREAM_UNAVAILABLE', 'Apify 取数失败：' + String(target), { retryable: true });
  }
  if (!res.ok) throw httpError('items', String(target), res.status);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw fail('UPSTREAM_ERROR', 'Apify 取数回包非 JSON：' + String(target), { retryable: true });
  }
  const list = Array.isArray(body) ? body : (Array.isArray(body && body.data) ? body.data : (Array.isArray(body && body.items) ? body.items : []));
  if (list.length === 0) {
    throw fail('EMPTY_RESULT', 'Apify 取数为空：' + String(target), { retryable: true });
  }
  const item = list[0];
  const content = truncateUtf8(pickItemContent(item, format), MAX_BYTES);
  if (!content) {
    const text = String((item && (item.error ?? item.message)) || 'empty_result');
    throw fail(innerCode(text), 'Apify 抓取失败：' + String(target) + ' ' + text, { retryable: true });
  }
  const source = String((item && (item.url ?? item.finalUrl ?? item.sourceUrl)) || target);
  const out = /** @type {any} */ ({ url: String(target), finalUrl: source, title: String((item && (item.title ?? item.metadataTitle)) || extractTitle(content)), content: content });
  const published = item ? (item.publishedDate ?? item.datePublished ?? item.date) : undefined;
  if (typeof published === 'string' && published) out.publishedDate = published;
  return out;
}

/**
 * 抓取单条 URL（内部扇出单元：run + poll + items 三段）。
 * @param {string} target 目标 URL
 * @param {string} apiKey 密钥
 * @param {string} actorId 演员标识
 * @param {string} baseUrl 抓取基址
 * @param {{format: string, maxCharge?: number, perUrlTimeoutMs?: number}} options 单条选项
 * @param {(url: string, init?: any) => Promise<Response>} fetchImpl 抓取实现
 * @returns {Promise<{item: any, charge?: number}>} 归一成功项与费用
 */
async function fetchSingle(target, apiKey, actorId, baseUrl, options, fetchImpl) {
  if (options.maxCharge !== undefined && ESTIMATED_USD_PER_URL > options.maxCharge) {
    throw fail('MAX_COST_EXCEEDED', 'Apify 熔断：预估 ' + ESTIMATED_USD_PER_URL + ' 美元超 maxTotalChargeUsd ' + options.maxCharge, { status: 402, retryable: false });
  }
  const started = await startRun(target, baseUrl, actorId, apiKey, options.maxCharge, fetchImpl);
  let deadlineMs = Date.now() + POLL_TIMEOUT_MS;
  if (options.perUrlTimeoutMs !== undefined && Number.isFinite(options.perUrlTimeoutMs) && options.perUrlTimeoutMs > 0) {
    deadlineMs = Math.min(deadlineMs, Date.now() + Math.floor(options.perUrlTimeoutMs));
  }
  const polled = await pollRun(started.runId, started.datasetHint, target, baseUrl, apiKey, deadlineMs, fetchImpl);
  const item = await fetchItems(polled.datasetId, target, baseUrl, apiKey, options.format, fetchImpl);
  const done = /** @type {any} */ ({ item: item });
  if (polled.charge !== undefined) done.charge = polled.charge;
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
        settled[index] = { ok: false, error: error };
      }
    }
  }
  await Promise.all(Array.from({ length: count }, run));
  return settled;
}
/**
 * Apify 批量抓取（单 URL 单 run 三段式，限并发 2 扇出再合并，逐 URL 结算）。
 * @param {{urls: string[], format?: string, actorId?: string, actor?: string, maxTotalChargeUsd?: number, maxCost?: number, perUrlTimeoutMs?: number}} params 统一抓取输入
 * @param {any} deps 依赖（含 apifyApiKey、fetchUrlApify、apifyActorId、apifyConcurrency）
 * @returns {Promise<{results: Array<any>, errors: Array<any>, usage?: any}>} 归一后的成功与失败列表
 */
export async function apifyFetch(params, deps) {
  const fetchImpl = deps && deps.fetchImpl ? deps.fetchImpl : globalThis.fetch;
  const urls = params ? params.urls : undefined;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_URLS) {
    throw fail('INVALID_PARAMS', 'urls 必须为 1..10 个 URL 的数组');
  }
  for (const u of urls) {
    if (typeof u !== 'string' || (u.indexOf('http://') !== 0 && u.indexOf('https://') !== 0)) {
      throw fail('INVALID_PARAMS', 'urls 仅支持 http/https 字符串：' + String(u));
    }
  }
  const resolved = resolveApify(deps);
  const apiKey = resolved.apiKey;
  const baseUrl = resolved.baseUrl;
  let paramActor = '';
  if (params && typeof (params.actorId ?? params.actor) === 'string') paramActor = String(params.actorId ?? params.actor).trim();
  const actorId = paramActor || resolved.actorId;
  const format = params && params.format === 'html' ? 'html' : 'markdown';
  const maxCharge = resolveMaxCharge(params, deps);
  /** @type {number|undefined} */
  let perUrlTimeoutMs;
  if (params && params.perUrlTimeoutMs !== undefined) {
    const n = Number(params.perUrlTimeoutMs);
    if (Number.isFinite(n) && n > 0) perUrlTimeoutMs = Math.floor(n);
  }
  const rawLimit = Number(pickKey(deps, ['apifyConcurrency']));
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(5, Math.floor(rawLimit))) : DEFAULT_CONCURRENCY;
  const targets = urls.map((u) => String(u));
  const settled = await mapLimit(targets, limit, (target) => fetchSingle(target, apiKey, actorId, baseUrl, { format: format, maxCharge: maxCharge, perUrlTimeoutMs: perUrlTimeoutMs }, fetchImpl));
  const results = /** @type {any[]} */ ([]);
  const errors = /** @type {any[]} */ ([]);
  let totalChargeUsd = 0;
  let hasCharge = false;
  for (let i = 0; i < settled.length; i += 1) {
    const entry = settled[i];
    if (entry.ok) {
      results.push(entry.value.item);
      if (typeof entry.value.charge === 'number') { totalChargeUsd += entry.value.charge; hasCharge = true; }
    } else {
      const caught = entry.error;
      const item = /** @type {any} */ ({ url: targets[i], error: String((caught && caught.code) || 'target_unreachable'), retryable: caught && caught.retryable !== undefined ? !!caught.retryable : true });
      if (caught && caught.status !== undefined) item.status = caught.status;
      errors.push(item);
    }
  }
  const out = /** @type {any} */ ({ results: results, errors: errors });
  if (hasCharge) out.usage = { provider: 'apify', totalChargeUsd: totalChargeUsd };
  return out;
}
