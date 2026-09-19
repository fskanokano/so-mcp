/**
 * scripts/smoke.js
 * 本地冒烟：零依赖、不联网，全部用桩 fetchImpl 代替上游。
 * 覆盖 initialize 回服务名 / tools.list 回三工具名 / so_search 映射正确 /
 * so_fetch 回退链正确 / 搜索扇出去重正确 / 验证引用装配正确 /
 * handleCredits 动态键双家 OK 且无汇总字段 /
 * 空名单回代理未配置 / 单家只回单键 / 十六家扇出十六键齐全。
 * 任一步失败即非零退出；全部通过打印中文通过行。
 */

import { handleMcpRequest } from '../lib/mcp.js';
import { handleCredits } from '../lib/endpoints/credits.js';

/** 冒烟用的代理凭证（只活在本地进程）。 */
const PROXY_KEY = 'smoke-proxy-key';

/** 桩搜索结果：覆盖 url/content 与 link/snippet 两种上游字段形态。 */
const STUB_SEARCH_RESULTS = [
  { title: '冒烟标题一', url: 'https://smoke.local/a', content: '冒烟正文一' },
  { title: '冒烟标题二', link: 'https://smoke.local/b', snippet: '冒烟正文二' },
];

/** 回退链冒烟的目标地址（主供应商可重试失败，回退成功）。 */
const FALLBACK_URL = 'https://smoke.local/fallback';
/** Tinyfish 钱包地址（与实现默认值对齐，钱包与智能体同宿主，与抓取宿主分离）。 */
const TINYFISH_WALLET_URL = 'https://agent.tinyfish.ai/v1/wallet';

/**
 * 构造桩 Response（只实现调用方用到的 ok/status/json）。
 * @param {unknown} data 响应 JSON 负载
 * @param {number} [status] HTTP 状态码
 * @returns {{ok: boolean, status: number, json: () => Promise<unknown>}} 桩响应
 */
function stubResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/**
 * 桩抓取实现：按地址路由到固定负载，未知地址直接抛错（暴露意外联网）。
 * @param {string} url 请求地址
 * @param {any} [init] 请求选项（含 body 供抓取路由用）
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<unknown>}>} 桩响应
 */
async function stubFetch(url, init = {}) {
  const text = String(url);
  if (text === TINYFISH_WALLET_URL || text.includes('agent.tinyfish.ai/v1/wallet')) {
    return stubResponse({ wallet: { credits: 5678 } });
  }
  if (text.includes('api.search.tinyfish.ai')) {
    return stubResponse({
      results: [
        { title: '冒烟 tinyfish', url: 'https://smoke.local/tinyfish', snippet: '正文' },
      ],
    });
  }
  if (text.includes('api.tavily.com/search')) {
    return stubResponse({ results: STUB_SEARCH_RESULTS });
  }
  if (text.includes('api.langsearch.com/v1/web-search')) {
    return stubResponse({
      results: [
        { title: '冒烟郎搜一', url: 'https://smoke.local/langsearch-1', content: '冒烟郎搜正文一' },
        { title: '冒烟郎搜二', url: 'https://smoke.local/langsearch-2', content: '冒烟郎搜正文二' },
      ],
    });
  }
  if (text.includes('api.ydc-index.io/search')) {
    return stubResponse({
      results: [
        { title: '冒烟优搜一', url: 'https://smoke.local/youcom-1', snippet: '冒烟优搜正文一' },
        { title: '冒烟优搜二', url: 'https://smoke.local/youcom-2', snippet: '冒烟优搜正文二' },
      ],
    });
  }
  if (text.includes('api.ydc-index.io/contents')) {
    return stubResponse({
      contents: [{ url: FALLBACK_URL, title: '冒烟优抓', markdown: '冒烟优抓正文' }],
    });
  }
  if (text.includes('gnews.io/api/v4/search')) {
    return stubResponse({
      articles: [
        { title: '冒烟 G 新闻一', url: 'https://smoke.local/gnews-1', description: '冒烟 G 新闻正文一' },
        { title: '冒烟 G 新闻二', url: 'https://smoke.local/gnews-2', description: '冒烟 G 新闻正文二' },
      ],
    });
  }
  if (text.includes('s.jina.ai')) {
    return stubResponse({
      results: [
        { title: '冒烟 Jina 一', url: 'https://smoke.local/jina-1', content: '冒烟 Jina 正文一' },
        { title: '冒烟 Jina 二', url: 'https://smoke.local/jina-2', content: '冒烟 Jina 正文二' },
      ],
    });
  }
  if (text.includes('api.brightdata.com/request')) {
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      headers: { get: () => '' },
      text: async () => '# 冒烟亮数\n冒烟亮数正文',
    });
  }
  if (text.includes('api.tavily.com/extract')) {
    const body = JSON.parse(init.body || '{}');
    const urls = Array.isArray(body.urls) ? body.urls : [];
    return stubResponse({
      results: urls.map((/** @type {any} */ target) => ({ url: target, title: '冒烟抓取', raw_content: '冒烟抓取正文' })),
      failed_results: [],
    });
  }
  if (text.includes('browserless.io')) {
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      headers: { get: () => '' },
      text: async () => '# 冒烟无头\n冒烟无头正文',
      json: async () => ({}),
    });
  }
  if (text.includes('localhost:3000')) {
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      headers: { get: () => '' },
      text: async () => '# 冒烟 Jina 抓取\n冒烟 Jina 抓取正文',
      json: async () => ({}),
    });
  }
  if (text.includes('scrapingant.com')) {
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      headers: { get: () => '' },
      text: async () => '<html><head><title>冒烟蚁</title></head><body>冒烟蚁正文</body></html>',
      json: async () => ({}),
    });
  }
  if (text.includes('api.apify.com')) {
    if (text.includes('/acts/')) {
      return stubResponse({ data: { id: 'smoke-run-1', defaultDatasetId: 'smoke-ds-1' } });
    }
    if (text.includes('/actor-runs/')) {
      return stubResponse({
        data: { status: 'SUCCEEDED', defaultDatasetId: 'smoke-ds-1', stats: { totalChargeUsd: 0.001 } },
      });
    }
    if (text.includes('/datasets/')) {
      return stubResponse([
        { url: 'https://smoke.local/apify', title: '冒烟 Apify', markdown: '冒烟 Apify 正文' },
      ]);
    }
    return stubResponse({ data: { id: 'smoke-run-1', defaultDatasetId: 'smoke-ds-1' } });
  }
  if (text.includes('api.tavily.com/usage')) {
    return stubResponse({
      key: { usage: 150, limit: 1000 },
      account: { current_plan: 'Bootstrap', plan_usage: 500, plan_limit: 15000 },
    });
  }
  if (text.includes('api.hasdata.com/user/me/usage')) {
    return stubResponse({
      status: 'ok',
      data: { totalCredits: 10000000, availableCredits: 5473702, concurrentRequests: 0, availableConcurrency: 100 },
    });
  }
  if (text.includes('api.firecrawl.dev/v2/team/credit-usage')) {
    return stubResponse({
      success: true,
      data: {
        remainingCredits: 1000,
        planCredits: 500000,
        billingPeriodStart: '2025-01-01T00:00:00Z',
        billingPeriodEnd: '2025-01-31T23:59:59Z',
      },
    });
  }
  if (text.includes('api.scrape.do/info')) {
    return stubResponse({
      IsActive: true,
      ConcurrentRequest: 40,
      MaxMonthlyRequest: 3500000,
      RemainingConcurrentRequest: 15,
      RemainingMonthlyRequest: 2565023,
    });
  }
  if (text.includes('api.scraperapi.com/account')) {
    return stubResponse({
      requestLimit: '1000',
      requestCount: 588,
      concurrentRequests: 0,
      concurrencyLimit: 5,
      failedRequestCount: 258,
    });
  }
  if (text.includes('tinyfish')) {
    const body = JSON.parse(init.body || '{}');
    const urls = Array.isArray(body.urls) ? body.urls : [];
    // 回退链冒烟：回退目标地址报可重试的超时，其余地址直接成功（空错误）。
    if (urls.includes(FALLBACK_URL)) {
      return stubResponse({
        results: [],
        errors: [{ url: FALLBACK_URL, error: 'timeout' }],
      });
    }
    return stubResponse({ results: [], errors: [] });
  }
  throw new Error('桩 fetch 收到未知地址：' + text);
}

/**
 * 断言 helper：失败即抛中文错误。
 * @param {unknown} condition 断言条件
 * @param {string} message 失败信息
 * @returns {void}
 */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** 依次执行冒烟步骤，失败抛错、成功打印中文通过行。 */
async function main() {
  // 1. initialize：服务名与协议版本。
  const initRes = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { fetchImpl: stubFetch },
  );
  check(initRes?.result?.serverInfo?.name === 'so-mcp', 'initialize 未返回 so-mcp 服务信息');
  console.log('通过：initialize 返回服务名 so-mcp');

  // 2. tools/list：恰为搜、抓、验证三工具，且无余额工具。
  const listRes = await handleMcpRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { fetchImpl: stubFetch },
  );
  const toolNames = (listRes?.result?.tools || []).map((/** @type {any} */ tool) => tool.name);
  check(toolNames.length === 3, 'tools/list 应恰为三工具，实际：' + toolNames.join(','));
  for (const name of ['so_search', 'so_fetch', 'so_verify']) {
    check(toolNames.includes(name), 'tools/list 缺少工具：' + name);
  }
  check(!toolNames.includes('so_credits'), 'tools/list 不应再暴露 so_credits');
  console.log('通过：tools/list 返回 so_search/so_fetch/so_verify 三工具');

  // 3. tools/call so_search：桩结果正确映射 title/url/content。
  const callRes = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'so_search', arguments: { query: '冒烟关键词' } },
    },
    { searchProvider: 'tavily', tavilyApiKey: 'smoke-tavily-key', fetchImpl: stubFetch },
  );
  const payload = JSON.parse(callRes?.result?.content?.[0]?.text || '{}');
  check(payload.provider === 'tavily', 'so_search 未返回 tavily 供应商标记');
  check(payload.results?.[0]?.title === '冒烟标题一', 'so_search 首条标题映射错误');
  check(payload.results?.[1]?.url === 'https://smoke.local/b', 'so_search 次条地址映射错误');
  check(payload.results?.[1]?.content === '冒烟正文二', 'so_search 次条正文映射错误');
  console.log('通过：tools/call so_search 映射 title/url/content 正确');

  // 4. tools/call so_fetch：主供应商可重试失败后回退成功，置 fallbackUsed。
  const fetchRes = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'so_fetch', arguments: { urls: [FALLBACK_URL] } },
    },
    {
      fetchPrimary: 'tinyfish',
      fetchFallback: 'tavily',
      tinyfishApiKey: 'smoke-tinyfish-key',
      tavilyApiKey: 'smoke-tavily-key',
      fetchImpl: stubFetch,
    },
  );
  const fetchPayload = JSON.parse(fetchRes?.result?.content?.[0]?.text || '{}');
  check(fetchPayload.fallbackUsed === true, 'so_fetch 回退链未置 fallbackUsed');
  check(
    Array.isArray(fetchPayload.providers) &&
      fetchPayload.providers[0] === 'tinyfish' &&
      fetchPayload.providers[1] === 'tavily',
    'so_fetch 回退链 providers 应为 tinyfish,tavily',
  );
  check(fetchPayload.results?.[0]?.url === FALLBACK_URL, 'so_fetch 回退结果地址错误');
  check((fetchPayload.errors || []).length === 0, 'so_fetch 回退后 errors 应为空');
  console.log('通过：tools/call so_fetch 回退链正确');

  // 4b. tools/call so_search 扇出：双源并行按 URL 去重，保留首见 provider。
  // 同名去重后只剩单源会走老语义，故用两个不同源触发扇出（桩按地址路由，同负载去重后 3 条）。
  const fanoutRes = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'so_search', arguments: { query: '冒烟关键词', providers: ['tinyfish', 'tavily'] } },
    },
    {
      tinyfishApiKey: 'smoke-tinyfish-key',
      tavilyApiKey: 'smoke-tavily-key',
      fetchImpl: stubFetch,
    },
  );
  const fanoutPayload = JSON.parse(fanoutRes?.result?.content?.[0]?.text || '{}');
  check(fanoutPayload.provider === 'fanout', 'so_search 扇出未返回 fanout 标记');
  check(Array.isArray(fanoutPayload.results) && fanoutPayload.results.length === 3, 'so_search 扇出去重后应为 3 条');
  console.log('通过：tools/call so_search 扇出去重正确');

  // 4c. tools/call so_verify：逐条引用与来源追溯装配正确（显式 tinyfish+tavily 双源共 3 源）。
  const verifyRes = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'so_verify', arguments: { query: '冒烟关键词', maxResults: 3, searchProviders: ['tinyfish', 'tavily'], fetchChain: ['tavily'] } },
    },
    {
      tinyfishApiKey: 'smoke-tinyfish-key',
      tavilyApiKey: 'smoke-tavily-key',
      fetchImpl: stubFetch,
    },
  );
  const verifyPayload = JSON.parse(verifyRes?.result?.content?.[0]?.text || '{}');
  check(Array.isArray(verifyPayload.sources) && verifyPayload.sources.length === 3, 'so_verify 来源应为 3 条');
  check(Array.isArray(verifyPayload.citations) && verifyPayload.citations.length === 3, 'so_verify 引用应逐条对应');
  check(verifyPayload.citations[0]?.index === 1 && verifyPayload.citations[2]?.index === 3, 'so_verify 引用序号错误');
  check(typeof verifyPayload.citations[0]?.source?.provider === 'string', 'so_verify 引用缺少来源归属');
  console.log('通过：tools/call so_verify 引用装配正确');
  const okRequest = new Request('https://smoke.local/credits', {
    headers: { Authorization: 'Bearer ' + PROXY_KEY },
  });
  const okResponse = await handleCredits(
    okRequest,
    {
      env: {
        PROXY_API_KEY: PROXY_KEY,
        TAVILY_API_KEY: 'smoke-tavily-key',
        TINYFISH_API_KEY: 'smoke-tinyfish-key',
      },
      fetchImpl: stubFetch,
    },
  );
  const okBody = await okResponse.json();
  check(okResponse.status === 200, 'handleCredits 双家动态键未回 200');
  check(okBody?.data?.tinyfish?.provider === 'tinyfish', 'handleCredits tinyfish 钱包缺失');
  check(
    okBody?.data?.tavily?.provider === 'tavily' &&
      typeof okBody.data.tavily.remaining === 'number' &&
      typeof okBody.data.tavily.limit === 'number',
    'handleCredits tavily 余额缺失',
  );
  check(!('total' in (okBody?.data ?? {})), 'handleCredits 不应回汇总 total 字段');
  check(!('balance' in (okBody?.data ?? {})), 'handleCredits 不应回汇总 balance 字段');
  console.log('通过：handleCredits 双家动态键均 OK 且无汇总字段');

  // 6. handleCredits 空名单：十六家上游密钥均缺配才回 500 代理未配置。
  const emptyRequest = new Request('https://smoke.local/credits', {
    headers: { Authorization: 'Bearer ' + PROXY_KEY },
  });
  const emptyResponse = await handleCredits(
    emptyRequest,
    { env: { PROXY_API_KEY: PROXY_KEY }, fetchImpl: stubFetch },
  );
  const emptyBody = await emptyResponse.json();
  check(emptyResponse.status === 500, 'handleCredits 空名单时未回 500');
  check(emptyBody?.error === 'proxy_misconfigured', 'handleCredits 空名单时未报代理未配置');
  console.log('通过：handleCredits 空名单时回 500 代理未配置');

  // 7. handleCredits 单家：仅 TINYFISH_API_KEY 时只回 tinyfish 单键（十六家名单下其余缺席）。
  const singleRequest = new Request('https://smoke.local/credits', {
    headers: { Authorization: 'Bearer ' + PROXY_KEY },
  });
  const singleResponse = await handleCredits(
    singleRequest,
    {
      env: { PROXY_API_KEY: PROXY_KEY, TINYFISH_API_KEY: 'smoke-tinyfish-key' },
      fetchImpl: stubFetch,
    },
  );
  const singleBody = await singleResponse.json();
  check(singleResponse.status === 200, 'handleCredits 单家时未回 200');
  check(singleBody?.data?.tinyfish?.provider === 'tinyfish', 'handleCredits 单家 tinyfish 键缺失');
  check(!('tavily' in (singleBody?.data ?? {})), 'handleCredits 单家时不应补 tavily 空键');
  console.log('通过：handleCredits 单家只回 tinyfish 单键');
  // 8. handleCredits 十六家扇出：十六 Key 全配时 data 恰含十六键，exa/querit/langsearch/youcom/brightdata/browserless/jina/scrapingant/apify/gnews 为 null 占位（余额占位无需触网）。
  const fullRequest = new Request('https://smoke.local/credits', {
    headers: { Authorization: 'Bearer ' + PROXY_KEY },
  });
  const fullResponse = await handleCredits(
    fullRequest,
    {
      env: {
        PROXY_API_KEY: PROXY_KEY,
        TINYFISH_API_KEY: 'smoke-tinyfish-key',
        TAVILY_API_KEY: 'smoke-tavily-key',
        EXA_API_KEY: 'smoke-exa-key',
        QUERIT_API_KEY: 'smoke-querit-key',
        HASDATA_API_KEY: 'smoke-hasdata-key',
        FIRECRAWL_API_KEY: 'smoke-firecrawl-key',
        SCRAPEDO_API_KEY: 'smoke-scrapedo-key',
        SCRAPERAPI_API_KEY: 'smoke-scraperapi-key',
        LANGSEARCH_API_KEY: 'smoke-langsearch-key',
        YOUCOM_API_KEY: 'smoke-youcom-key',
        BRIGHTDATA_API_KEY: 'smoke-brightdata-key',
        BROWSERLESS_API_KEY: 'smoke-browserless-key',
        JINA_API_KEY: 'smoke-jina-key',
        SCRAPINGANT_API_KEY: 'smoke-scrapingant-key',
        APIFY_API_KEY: 'smoke-apify-key',
        GNEWS_API_KEY: 'smoke-gnews-key',
      },
      fetchImpl: stubFetch,
    },
  );
  const fullBody = await fullResponse.json();
  check(fullResponse.status === 200, 'handleCredits 十六家扇出时未回 200');
  check(Object.keys(fullBody?.data ?? {}).length === 16, 'handleCredits 十六家扇出时 data 应恰含十六键');
  for (const name of ['tinyfish', 'tavily', 'exa', 'querit', 'hasdata', 'firecrawl', 'scrapedo', 'scraperapi', 'langsearch', 'youcom', 'brightdata', 'browserless', 'jina', 'scrapingant', 'apify', 'gnews']) {
    check(fullBody?.data?.[name]?.provider === name, 'handleCredits 十六家扇出缺失：' + name);
  }
  check(fullBody?.data?.exa?.balance === null, 'handleCredits exa 应为 null 占位');
  check(fullBody?.data?.querit?.balance === null, 'handleCredits querit 应为 null 占位');
  check(fullBody?.data?.langsearch?.balance === null, 'handleCredits langsearch 应为 null 占位');
  check(fullBody?.data?.youcom?.balance === null, 'handleCredits youcom 应为 null 占位');
  check(fullBody?.data?.brightdata?.balance === null, 'handleCredits brightdata 应为 null 占位');
  check(fullBody?.data?.browserless?.balance === null, 'handleCredits browserless 应为 null 占位');
  check(fullBody?.data?.jina?.balance === null, 'handleCredits jina 应为 null 占位');
  check(fullBody?.data?.scrapingant?.balance === null, 'handleCredits scrapingant 应为 null 占位');
  check(fullBody?.data?.apify?.balance === null, 'handleCredits apify 应为 null 占位');
  check(fullBody?.data?.gnews?.balance === null, 'handleCredits gnews 应为 null 占位');
  console.log('通过：handleCredits 十六家扇出十六键齐全且 exa/querit/langsearch/youcom/brightdata/browserless/jina/scrapingant/apify/gnews 为 null 占位');
  console.log('冒烟全部通过');
}
main().catch((error) => {
  console.error('冒烟失败：' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
