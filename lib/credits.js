/**
 * 余额查询层：十六家供应商剩余额度查询。
 *
 * 密钥只读服务端环境变量（经 deps 传入），永不回传客户端、不打日志。
 * 失败统一抛 {code, status} 结构化错误，由网关映射为上游不可用/超时。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 *
 * 成功返回统一含 provider/remaining/balance/limit/usage/raw，缺失填 null，不编造；
 * balance 与 remaining 同值，兼容旧断言；raw 原样透出上游响应；单位与口径进 unit/note。
 *
 * 各家口径与鉴权（以官方文档为准）：
 * - tinyfish：GET https://agent.tinyfish.ai/v1/wallet，头 X-API-Key；
 *   200 体 available_balance（字符串）即剩余额度（允许负透支），currency/asOf 原样，
 *   limit/usage 置 null，pendingTopUp/autoReload/rates 原样透传；
 *   404 说明 legacy 信用账户无钱包，文档见 https://docs.tinyfish.ai/api-reference/wallet/get-wallet。
 * - tavily：GET https://api.tavily.com/usage，头 Authorization: Bearer；
 *   limit 取 account.plan_limit ?? key.limit，usage 取 account.plan_usage ?? key.usage，
 *   remaining = max(0, limit - usage)，口径单位 credits。
 * - hasdata：GET https://api.hasdata.com/user/me/usage，头 x-api-key；
 *   limit 取 totalCredits，remaining 取 availableCredits，usage 为差值，口径单位 credits；
 *   403 实为点数用尽，按 CREDENTIAL_MISSING 抛并在 message 注明。
 * - firecrawl：GET https://api.firecrawl.dev/v2/team/credit-usage，头 Authorization: Bearer；
 *   camel 与 snake 双形态兼容，remaining 原样透出（含负），usage 仅双数字时为差值，口径单位 credits。
 * - scrapedo：主 GET https://api.scrape.do/info?token=…，头 Accept: application/json；
 *   主 429/5xx 降级 GET https://q.scrape.do/api/v1/me（头 X-Token），取
 *   AvaliableCredits（兼容 AvailableCredits 拼写）；401 兼表无点数，错误上透 raw 原文。
 * - scraperapi：GET https://api.scraperapi.com/account?api_key=…，无请求头；
 *   请求数口径（requestLimit/requestCount），加权请求可能低估实际消耗，见 note。
 * - exa：无公开余额接口，占位回 null，不触网、不读 key；
 *   剩余额度仅 dashboard 可见（https://exa.ai/docs/reference/billing），
 *   程序化仅 Team Management 单 key 用量查询且需 service key
 *   （https://exa.ai/docs/reference/team-management/get-api-key-usage），普通 key 不调用。
 * - querit：无公开余额接口，占位回 null，不触网、不读 key；
 *   API 仅 POST /v1/search 与 /v1/contents，用量请登录 Dashboard 查看
 *   （https://www.querit.ai/en/dashboard/home）。
 * - langsearch：无公开余额接口，占位回 null，不触网、不读 key；
 *   搜索上游为 POST https://api.langsearch.com/v1/web-search，用量随搜索响应透出，
 *   剩余额度请登录控制台查看。
 * - youcom：无公开余额接口，占位回 null，不触网、不读 key；
 *   搜索上游为 GET https://api.ydc-index.io/search，用量随搜索响应透出，
 *   剩余额度请登录控制台查看。
 * - brightdata：无公开余额接口，占位回 null，不触网、不读 key；
 *   抓取上游为 POST https://api.brightdata.com/request，用量按请求结算，
 *   剩余额度请登录控制台查看。
 */

// 默认余额端点（deps 上对应覆盖键优先）。
// 钱包与智能体同宿主（agent.tinyfish.ai），与抓取宿主分离（抓取与搜索为独立产品宿主）。
const DEFAULT_TINYFISH_WALLET_URL = 'https://agent.tinyfish.ai/v1/wallet';
const DEFAULT_TAVILY_USAGE_URL = 'https://api.tavily.com/usage';
const DEFAULT_HASDATA_USAGE_URL = 'https://api.hasdata.com/user/me/usage';
const DEFAULT_FIRECRAWL_CREDIT_USAGE_URL = 'https://api.firecrawl.dev/v2/team/credit-usage';
const DEFAULT_SCRAPEDO_INFO_URL = 'https://api.scrape.do/info';
const DEFAULT_SCRAPEDO_ME_URL = 'https://q.scrape.do/api/v1/me';
const DEFAULT_SCRAPERAPI_ACCOUNT_URL = 'https://api.scraperapi.com/account';

// 余额查询独立超时（毫秒），避免 Hobby 函数被上游拖住。
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 构造携带结构化字段的错误。
 * @param {string} code 错误码
 * @param {string} message 错误信息
 * @param {{status?: number}} [extra] 附加字段
 * @returns {Error & {code: string, status?: number}} 结构化错误
 */
function fail(code, message, extra) {
  const err = /** @type {Error & {code: string, status?: number}} */ (
    new Error(message)
  );
  err.code = code;
  if (extra && extra.status !== undefined) err.status = extra.status;
  return err;
}

/**
 * 解析超时毫秒数。
 * @param {any} deps 依赖
 * @returns {number} 超时毫秒数
 */
function resolveTimeoutMs(deps) {
  const raw =
    (deps && (deps.creditsTimeoutMs || deps.CREDITS_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(ms);
}

/**
 * 带独立超时的 GET 请求。
 * @param {string} url 请求地址
 * @param {Record<string, string>} headers 请求头
 * @param {number} timeoutMs 超时毫秒数
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<Response>} 上游响应
 */
async function getWithTimeout(url, headers, timeoutMs, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  /** @type {AbortController|undefined} */
  let controller;
  /** @type {any} */
  let signal;
  try {
    // Node 22 原生支持超时信号；不支持时降级为普通请求。
    signal = AbortSignal.timeout(timeoutMs);
  } catch (_ignored) {
    controller = new AbortController();
    signal = controller.signal;
    // 降级分支内控制器必已赋值，转 any 后调用，避免闭包 possibly-undefined 报错（运行时逻辑不变）。
    setTimeout(() => /** @type {any} */ (controller).abort(), timeoutMs).unref?.();
  }
  try {
    return await impl(url, { method: 'GET', headers, signal });
  } catch (cause) {
    // 上游异常形状动态，转 any 后再取 name，避免隐式 any 报错。
    const causeAny = /** @type {any} */ (cause);
    const aborted =
      (cause && (causeAny.name === 'TimeoutError' || causeAny.name === 'AbortError')) || false;
    if (aborted) {
      throw fail('UPSTREAM_TIMEOUT', '余额查询超时：' + url, { status: 504 });
    }
    throw fail('UPSTREAM_UNAVAILABLE', '余额查询请求失败：' + url, { status: 502 });
  }
}

/**
 * 数值归一：有限数字回 Number 本体，否则回 null（缺失不编造）。
 * @param {unknown} value 上游原始值
 * @returns {number|null} 有限数字或 null
 */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 尽力读取上游错误响应原文（读不到回 null，不抛错）。
 * @param {Response} res 上游响应
 * @returns {Promise<unknown>} 响应原文或 null
 */
async function readRaw(res) {
  try {
    return await res.json();
  } catch (_ignored) {
    return null;
  }
}

/**
 * 查询 Tinyfish 钱包剩余额度。
 * @param {any} deps 依赖（含 tinyfishApiKey、tinyfishWalletUrl、creditsTimeoutMs）
 * @returns {Promise<any>} 统一余额对象
 */
export async function getTinyfishWallet(deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps && (deps.tinyfishApiKey || deps.tinyfishKey || deps.TINYFISH_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 TINYFISH_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.tinyfishWalletUrl || deps.creditsUrlTinyfish)) ||
    DEFAULT_TINYFISH_WALLET_URL;
  const res = await getWithTimeout(
    url,
    { 'X-API-Key': apiKey },
    resolveTimeoutMs(deps),
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Tinyfish 密钥无效或无权限', {
      status: res.status,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Tinyfish 余额不足', { status: 402 });
  }
  if (res.status === 404) {
    // legacy 信用账户无钱包：转占位，不抛错、不阻塞扇出。
    return {
      provider: 'tinyfish',
      balance: null,
      remaining: null,
      limit: null,
      usage: null,
      note: 'legacy 信用账户无钱包，见 https://docs.tinyfish.ai/api-reference/wallet/get-wallet',
      raw: null,
    };
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Tinyfish 钱包查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  // 上游钱包响应形状动态，压为 any 后再取值，避免隐式 any 报错。
  const data = /** @type {any} */ (await res.json());
  const remaining = numOrNull(data?.available_balance);
  const currency = data?.currency ?? null;
  return {
    provider: 'tinyfish',
    balance: remaining,
    remaining,
    limit: null,
    usage: null,
    currency,
    asOf: data?.as_of ?? null,
    pendingTopUp: data?.pending_top_up ?? null,
    autoReload: data?.auto_reload ?? null,
    rates: data?.rates ?? null,
    unit: currency,
    raw: data,
  };
}

/**
 * 查询 Tavily 剩余额度。
 * @param {any} deps 依赖（含 tavilyApiKey、tavilyUsageUrl、creditsTimeoutMs）
 * @returns {Promise<any>} 统一余额对象
 */
export async function getTavilyBalance(deps) {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps && (deps.tavilyApiKey || deps.tavilyKey || deps.TAVILY_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 TAVILY_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.tavilyUsageUrl || deps.creditsUrlTavily)) || DEFAULT_TAVILY_USAGE_URL;
  const res = await getWithTimeout(
    url,
    { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
    resolveTimeoutMs(deps),
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Tavily 密钥无效或无权限', {
      status: res.status,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Tavily 余额不足', { status: 402 });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Tavily 用量查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  const data = /** @type {any} */ (await res.json());
  const key = data?.key ?? null;
  const account = data?.account ?? null;
  const limit = account?.plan_limit ?? key?.limit ?? null;
  const usage = account?.plan_usage ?? key?.usage ?? null;
  if (limit == null && usage == null) {
    throw fail('UPSTREAM_ERROR', 'Tavily 用量返回缺失 limit 与 usage', { status: 502 });
  }
  const limitNum = limit != null ? Number(limit) : NaN;
  const usageNum = usage != null ? Number(usage) : NaN;
  const remaining =
    Number.isFinite(limitNum) && Number.isFinite(usageNum)
      ? Math.max(0, limitNum - usageNum)
      : null;
  return {
    provider: 'tavily',
    balance: remaining,
    remaining,
    limit,
    usage,
    unit: 'credits',
    plan: account?.current_plan ?? null,
    raw: data,
  };
}

/**
 * 查询 HasData 剩余额度。
 * @param {any} deps 依赖（含 hasdataApiKey、creditsUrlHasdata、creditsTimeoutMs）
 * @returns {Promise<any>} 统一余额对象
 */
export async function getHasdataBalance(deps) {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps &&
      (deps.hasdataApiKey ||
        deps.hasdataKey ||
        deps.HASDATA_API_KEY ||
        deps.HASDATA_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 HASDATA_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.creditsUrlHasdata || deps.hasdataUsageUrl)) ||
    DEFAULT_HASDATA_USAGE_URL;
  const res = await getWithTimeout(
    url,
    { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    resolveTimeoutMs(deps),
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    // 403 实为点数用尽，归一为 CREDENTIAL_MISSING 并在 message 注明。
    throw fail('CREDENTIAL_MISSING', 'HasData 密钥无效或点数已用尽（403 即无可用点数）', {
      status: res.status,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'HasData 余额不足', { status: 402 });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'HasData 用量查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  const data = /** @type {any} */ (await res.json());
  if (!data || data.status !== 'ok') {
    throw fail('UPSTREAM_ERROR', 'HasData 用量返回异常', { status: 502 });
  }
  const inner = /** @type {any} */ (data.data ?? {});
  const limit = numOrNull(inner.totalCredits);
  const remaining = numOrNull(inner.availableCredits);
  const usage = limit != null && remaining != null ? limit - remaining : null;
  return {
    provider: 'hasdata',
    balance: remaining,
    remaining,
    limit,
    usage,
    unit: 'credits',
    concurrency: {
      used: inner.concurrentRequests ?? null,
      available: inner.availableConcurrency ?? null,
    },
    raw: data,
  };
}

/**
 * 查询 Firecrawl 剩余额度。
 * @param {any} deps 依赖（含 firecrawlApiKey、firecrawlCreditUsageUrl、creditsTimeoutMs）
 * @returns {Promise<any>} 统一余额对象
 */
export async function getFirecrawlBalance(deps) {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps && (deps.firecrawlApiKey || deps.firecrawlKey || deps.FIRECRAWL_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 FIRECRAWL_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.firecrawlCreditUsageUrl || deps.creditsUrlFirecrawl)) ||
    DEFAULT_FIRECRAWL_CREDIT_USAGE_URL;
  const res = await getWithTimeout(
    url,
    { Authorization: 'Bearer ' + apiKey },
    resolveTimeoutMs(deps),
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Firecrawl 密钥无效或无权限', {
      status: res.status,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Firecrawl 余额不足', { status: 402 });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Firecrawl 额度查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  const data = /** @type {any} */ (await res.json());
  if (data && data.success === false) {
    throw fail('UPSTREAM_ERROR', 'Firecrawl 额度返回失败', { status: 502 });
  }
  const inner = /** @type {any} */ (data?.data ?? {});
  // camel 与 snake 双形态兼容；remaining 原样透出（含负），不做钳制。
  const remaining = inner.remainingCredits ?? inner.remaining_credits ?? null;
  const limit = inner.planCredits ?? inner.plan_credits ?? null;
  const start = inner.billingPeriodStart ?? inner.billing_period_start ?? null;
  const end = inner.billingPeriodEnd ?? inner.billing_period_end ?? null;
  const remainingNum = remaining != null ? Number(remaining) : NaN;
  const limitNum = limit != null ? Number(limit) : NaN;
  const usage =
    Number.isFinite(remainingNum) && Number.isFinite(limitNum)
      ? limitNum - remainingNum
      : null;
  return {
    provider: 'firecrawl',
    balance: remaining,
    remaining,
    limit,
    usage,
    unit: 'credits',
    billingPeriod: { start: start ?? null, end: end ?? null },
    raw: data,
  };
}

/**
 * 查询 Scrape.do 剩余额度（主 info 接口，429/5xx 降级 me 接口）。
 * @param {any} deps 依赖（含 scrapedoApiKey、scrapedoInfoUrl、scrapedoMeUrl、creditsTimeoutMs）
 * @returns {Promise<any>} 统一余额对象
 */
export async function getScrapedoBalance(deps) {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps &&
      (deps.scrapedoApiKey ||
        deps.scrapedoKey ||
        deps.scrapeDoApiKey ||
        deps.SCRAPEDO_API_KEY ||
        deps.SCRAPE_DO_API_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 SCRAPEDO_API_KEY 服务端环境变量');
  }
  const timeoutMs = resolveTimeoutMs(deps);
  const infoBase =
    (deps && (deps.scrapedoInfoUrl || deps.creditsUrlScrapedo)) ||
    DEFAULT_SCRAPEDO_INFO_URL;
  const infoUrl = infoBase.includes('token=')
    ? infoBase
    : infoBase + (infoBase.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(apiKey);
  const res = await getWithTimeout(
    infoUrl,
    { Accept: 'application/json' },
    timeoutMs,
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    // 401 兼表无点数：错误上透 raw 原文。
    const raw = await readRaw(res);
    const err = fail('CREDENTIAL_MISSING', 'Scrape.do 密钥无效或点数已用尽', {
      status: res.status,
    });
    /** @type {any} */ (err).raw = raw;
    throw err;
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Scrape.do 余额不足', { status: 402 });
  }
  if (res.status === 429 || res.status >= 500) {
    // 降级：主接口限流或网关异常时查当前身份剩余额度。
    const meUrl = (deps && deps.scrapedoMeUrl) || DEFAULT_SCRAPEDO_ME_URL;
    const meRes = await getWithTimeout(meUrl, { 'X-Token': apiKey }, timeoutMs, fetchImpl);
    if (meRes.status === 401 || meRes.status === 403) {
      const raw = await readRaw(meRes);
      const err = fail('CREDENTIAL_MISSING', 'Scrape.do 密钥无效或点数已用尽', {
        status: meRes.status,
      });
      /** @type {any} */ (err).raw = raw;
      throw err;
    }
    if (!meRes.ok) {
      throw fail('UPSTREAM_ERROR', 'Scrape.do 余额查询异常：HTTP ' + meRes.status, {
        status: meRes.status,
      });
    }
    const me = /** @type {any} */ (await meRes.json());
    // 上游字段存在 AvaliableCredits 拼写，兼容 AvailableCredits。
    const remaining = numOrNull(me?.AvaliableCredits ?? me?.AvailableCredits);
    return {
      provider: 'scrapedo',
      balance: remaining,
      remaining,
      limit: null,
      usage: null,
      unit: 'credits',
      raw: me,
    };
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Scrape.do 余额查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  const data = /** @type {any} */ (await res.json());
  const limit = numOrNull(data?.MaxMonthlyRequest);
  const remaining = numOrNull(data?.RemainingMonthlyRequest);
  const usage = limit != null && remaining != null ? limit - remaining : null;
  return {
    provider: 'scrapedo',
    balance: remaining,
    remaining,
    limit,
    usage,
    unit: 'credits',
    isActive: data?.IsActive ?? null,
    raw: data,
  };
}

/**
 * 查询 ScraperAPI 剩余额度。
 * @param {any} deps 依赖（含 scraperapiApiKey、scraperapiAccountUrl、creditsTimeoutMs）
 * @returns {Promise<any>} 统一余额对象
 */
export async function getScraperapiBalance(deps) {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps &&
      (deps.scraperapiApiKey ||
        deps.scraperApiKey ||
        deps.scraperapiKey ||
        deps.SCRAPERAPI_API_KEY ||
        deps.SCRAPER_API_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 SCRAPERAPI_API_KEY 服务端环境变量');
  }
  const base = (deps && deps.scraperapiAccountUrl) || DEFAULT_SCRAPERAPI_ACCOUNT_URL;
  const url = base.includes('api_key=')
    ? base
    : base + (base.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(apiKey);
  const res = await getWithTimeout(url, {}, resolveTimeoutMs(deps), fetchImpl);
  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'ScraperAPI 密钥无效或无权限', {
      status: res.status,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'ScraperAPI 余额不足', { status: 402 });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'ScraperAPI 账户查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  const data = /** @type {any} */ (await res.json());
  const limit = numOrNull(data?.requestLimit);
  const usage = numOrNull(data?.requestCount);
  const remaining = limit != null && usage != null ? Math.max(0, limit - usage) : null;
  return {
    provider: 'scraperapi',
    balance: remaining,
    remaining,
    limit,
    usage,
    unit: 'credits',
    concurrency: {
      inFlight: numOrNull(data?.concurrentRequests),
      limit: numOrNull(data?.concurrencyLimit),
      burst: numOrNull(data?.burst),
    },
    failedRequestCount: numOrNull(data?.failedRequestCount),
    subscriptionDate: data?.subscriptionDate ?? null,
    note: 'ScraperAPI 按请求数口径统计，加权请求可能低估实际消耗',
    raw: data,
  };
}
/**
 * 无公开余额接口供应商的占位查询：直接回 null 余额，不抛错、不触网、不阻塞扇出。
 * @param {string} name 供应商名
 * @returns {() => Promise<{provider: string, balance: null, note: string}>} 占位余额函数
 */
function noPublicBalance(name) {
  return async () => ({ provider: name, balance: null, note: '该供应商无公开余额接口' });
}

/**
 * 查询 Exa 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getExaBalance(_deps) {
  return {
    provider: 'exa',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'Exa 无公开余额接口：剩余额度仅 dashboard 可见（https://exa.ai/docs/reference/billing）；程序化仅 Team Management 单 key 用量查询需 service key（https://exa.ai/docs/reference/team-management/get-api-key-usage），普通 key 不调用',
    raw: null,
  };
}

/**
 * 查询 Querit 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getQueritBalance(_deps) {
  return {
    provider: 'querit',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'Querit 无公开余额接口：API 仅 POST /v1/search 与 /v1/contents，用量请登录 Dashboard 查看 https://www.querit.ai/en/dashboard/home',
    raw: null,
  };
}

/**
 * 查询 LangSearch 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getLangsearchBalance(_deps) {
  return {
    provider: 'langsearch',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'LangSearch 无公开余额接口：搜索上游为 POST https://api.langsearch.com/v1/web-search，用量随搜索响应透出，剩余额度请登录控制台查看',
    raw: null,
  };
}

/**
 * 查询 You.com 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getYoucomBalance(_deps) {
  return {
    provider: 'youcom',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'You.com 无公开余额接口：搜索上游为 GET https://api.ydc-index.io/search，用量随搜索响应透出，剩余额度请登录控制台查看',
    raw: null,
  };
}

/**
 * 查询 BrightData 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getBrightdataBalance(_deps) {
  return {
    provider: 'brightdata',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'BrightData 无公开余额接口：抓取上游为 POST https://api.brightdata.com/request，用量按请求结算，剩余额度请登录控制台查看',
    raw: null,
  };
}

/**
 * 查询 Browserless 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getBrowserlessBalance(_deps) {
  return {
    provider: 'browserless',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'Browserless 无公开余额接口：剩余额度请登录控制台查看',
    raw: null,
  };
}

/**
 * 查询 Jina 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getJinaBalance(_deps) {
  return {
    provider: 'jina',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'Jina 无公开余额接口：剩余额度请登录控制台查看',
    raw: null,
  };
}

/**
 * 查询 ScrapingAnt 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getScrapingantBalance(_deps) {
  return {
    provider: 'scrapingant',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'ScrapingAnt 无公开余额接口：剩余额度请登录控制台查看',
    raw: null,
  };
}

/**
 * 查询 Apify 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getApifyBalance(_deps) {
  return {
    provider: 'apify',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'Apify 无公开余额接口：剩余额度请登录控制台查看',
    raw: null,
  };
}

/**
 * 查询 GNews 余额（占位：无公开余额接口，不触网、不读 key）。
 * @param {any} [_deps] 占位参数（忽略，不触网、不读 key）
 * @returns {Promise<any>} 占位余额
 */
export async function getGnewsBalance(_deps) {
  return {
    provider: 'gnews',
    balance: null,
    remaining: null,
    limit: null,
    usage: null,
    note: 'GNews 无公开余额接口：剩余额度请登录控制台查看',
    raw: null,
  };
}
