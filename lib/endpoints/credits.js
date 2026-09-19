/**
 * 余额端点：`GET /credits`，按接入供应商动态并行查询剩余额度。
 * 名单来自环境变量存在性，有几家回几家；任一供应商失败都不阻塞其他家，分别记为可回传状态。
 */
import { CREDITS_TIMEOUT_MS, resolveCreditsProviders, resolveDeps } from '../config.js';
import { getCreditsProvider } from '../providers/index.js';
import { gate } from '../gate.js';
import { jsonResponse, misconfiguredResponse, upstreamTimeout } from '../http.js';

/** 余额接口仅支持 GET，OPTIONS 由准入层直接回预检。 */
const METHODS = ['GET', 'OPTIONS'];

/**
 * 把供应商异常归一化为可回传的状态对象。
 * 统一记 error，均保留 code/status 供排查。
 * @param {unknown} error 捕获到的异常或拒绝原因
 * @returns {any} 带 error 标记的状态对象
 */
function toStatus(error) {
  if (error && typeof error === 'object' && 'error' in error) {
    return error;
  }
  const code = (error != null && typeof error === 'object' && 'code' in error)
    ? String(/** @type {any} */ (error).code)
    : undefined;
  const status = (error != null && typeof error === 'object' && 'status' in error)
    ? /** @type {any} */ (error).status
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return { error: message, code: code ?? 'UPSTREAM_ERROR', ...(status !== undefined ? { status } : {}) };
}

/**
 * 处理余额查询：鉴权后按名单动态扇出，整体超时竞速。
 * 名单由已解析配置重组的环境值算出，新增钱包只需注册一行，无需改动本端点。
 * @param {Request} request 客户端请求
 * @param {any} [input] 依赖注入（环境变量与 fetch 实现）
 * @returns {Promise<Response>} 待发送的响应
 */
export async function handleCredits(request, input) {
  const url = new URL(request.url);
  const deps = resolveDeps(input);
  const gated = gate(request, url, deps.resolved, METHODS);
  if (gated.response) return gated.response;

  // 供应商只认扁平键（deps.tavilyApiKey 等）：把 resolved.config 拍平并透传 fetchImpl。
  const providerDeps = { ...deps, ...(deps.resolved?.config ?? {}), config: deps.resolved?.config };
  // 名单来自配置对应环境值拍平后重组：有键即接入，空串视为缺失（十六家任一非空即可启动）。
  const providers = resolveCreditsProviders({
    TINYFISH_API_KEY: providerDeps.tinyfishApiKey,
    TAVILY_API_KEY: providerDeps.tavilyApiKey,
    EXA_API_KEY: providerDeps.exaApiKey,
    LANGSEARCH_API_KEY: providerDeps.langsearchApiKey,
    YOUCOM_API_KEY: providerDeps.youcomApiKey,
    QUERIT_API_KEY: providerDeps.queritApiKey,
    HASDATA_API_KEY: providerDeps.hasdataApiKey,
    FIRECRAWL_API_KEY: providerDeps.firecrawlApiKey,
    SCRAPEDO_API_KEY: providerDeps.scrapedoApiKey,
    SCRAPERAPI_API_KEY: providerDeps.scraperapiApiKey,
    BRIGHTDATA_API_KEY: providerDeps.brightdataApiKey,
    BROWSERLESS_API_KEY: providerDeps.browserlessApiKey,
    JINA_API_KEY: providerDeps.jinaApiKey,
    SCRAPINGANT_API_KEY: providerDeps.scrapingantApiKey,
    APIFY_API_KEY: providerDeps.apifyApiKey,
    GNEWS_API_KEY: providerDeps.gnewsApiKey,
  });
  // 按名单必填：名单为空说明十六家上游密钥均缺失，直接回 500 代理未配置。
  if (providers.length === 0) return misconfiguredResponse(request, ['TINYFISH_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'LANGSEARCH_API_KEY', 'YOUCOM_API_KEY', 'QUERIT_API_KEY', 'HASDATA_API_KEY', 'FIRECRAWL_API_KEY', 'SCRAPEDO_API_KEY', 'SCRAPERAPI_API_KEY', 'BRIGHTDATA_API_KEY', 'BROWSERLESS_API_KEY', 'JINA_API_KEY', 'SCRAPINGANT_API_KEY', 'APIFY_API_KEY', 'GNEWS_API_KEY']);
  // 超时：优先用已解析配置里的 creditsTimeoutMs（其本身可被环境变量覆盖），再回退常量。
  const configured = /** @type {any} */ (deps.resolved.config)?.creditsTimeoutMs;
  const timeoutMs = Number.isFinite(Number(configured)) && Number(configured) > 0
    ? Number(configured)
    : CREDITS_TIMEOUT_MS;
  const work = (async () => {
    const entries = await Promise.all(providers.map(async (name) => {
      try {
        return /** @type {[string, unknown]} */ ([name, await getCreditsProvider(name)(providerDeps)]);
      } catch (error) {
        return /** @type {[string, unknown]} */ ([name, toStatus(error)]);
      }
    }));
    return jsonResponse(request, {
      success: true,
      data: Object.fromEntries(entries),
      checkedAt: new Date().toISOString(),
    });
  })();

  /** @type {any} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('credits_timeout')), timeoutMs);
  });
  try {
    return /** @type {Response} */ (await Promise.race([work, timeout]));
  } catch {
    return upstreamTimeout(request, `Credit check did not finish within ${timeoutMs}ms.`);
  } finally {
    clearTimeout(timer);
  }
}
