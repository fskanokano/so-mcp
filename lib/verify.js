/**
 * lib/verify.js
 * 时效多信源交叉验证：搜索取多源 → 域名去重 → Top 抓取验时效。
 * 零运行时依赖，原生 ESM，变量名英文、注释与 JSDoc 中文。
 */

import { dispatchTool } from './tools.js';

/**
 * 验证查询参数。
 * @typedef {object} VerifyQueryInput
 * @property {string} query 待验证问题或主题
 * @property {string} [fromDate] 起始日期 YYYY-MM-DD
 * @property {string} [toDate] 结束日期 YYYY-MM-DD
 * @property {number} [maxResults] 搜索取源数，默认 8
 * @property {string} [depth] 搜索深度，默认 standard
 * @property {string[]|string} [searchProviders] 搜索扇出名单，默认 tinyfish,tavily,exa,langsearch,youcom,jina,querit,firecrawl,gnews,hasdata（GNews 仅新闻条件扇出，通用查询自动过滤）
 * @property {string[]|string} [fetchChain] 抓取分级名单，默认 tinyfish,tavily,exa,youcom,jina,scrapedo,scraperapi,scrapingant,firecrawl,hasdata,browserless,brightdata,apify
 * @property {number} [budget] 可选预算上限（占位透传，不做硬拦截）
 */

/**
 * 验证返回形状。
 * @typedef {object} VerifyResult
 * @property {string} query 原始问题
 * @property {{fromDate: (string|undefined), toDate: (string|undefined)}} window 时间窗口
 * @property {Array<{title: string, url: string, domain: string, provider: string}>} sources 搜索来源（含供应商归属）
 * @property {Array<any>} fetched 抓取成功条目（含 provider 归属）
 * @property {Array<{index: number, source: {title: string, url: string, domain: string, provider: string}, fetched: any|null}>} citations 逐条结论引用（来源与抓取一一对应）
 * @property {number} distinctDomains 去重后域名数
 * @property {boolean} consistent 时效一致性判断
 * @property {string[]} notes 说明备注
 */

/** 抓取 Top 地址的最大条数（控制成本与延迟）。 */
const VERIFY_FETCH_TOP_N = 5;

/**
 * 从地址中提取域名，失败时回退简单解析。
 * @param {string} url 待解析地址
 * @returns {string} 域名小写，解析失败返回空字符串
 */
function extractDomain(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    // 回退：去掉协议与路径后取主机部分。
    const withoutProtocol = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    const host = withoutProtocol.split('/')[0].split('?')[0].split('#')[0].split('@').pop() || '';
    return host.split(':')[0].toLowerCase();
  }
}

/**
 * 归一名单：数组或逗号串转小写去重数组，未提供回 undefined。
 * @param {unknown} raw 名单原文
 * @returns {string[]|undefined} 归一化名单
 */
function normalizeNameList(raw) {
  if (raw === undefined || raw === null) return undefined;
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  const names = [];
  const seen = new Set();
  for (const part of parts) {
    const name = String(part ?? '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

/**
 * 从多种 deps 形态读取名单：调用方直挂优先，其次 config，其次 resolved.config。
 * @param {any} deps 调用方注入依赖
 * @param {string[]} keys 候选键名（按优先序）
 * @returns {string[]|undefined} 归一化名单
 */
function readNameList(deps, keys) {
  if (!deps || typeof deps !== 'object') return undefined;
  const layers = [deps, deps.config, deps.resolved?.config];
  for (const key of keys) {
    for (const layer of layers) {
      if (layer && typeof layer === 'object' && layer[key] !== undefined) {
        const normalized = normalizeNameList(layer[key]);
        if (normalized !== undefined) return normalized;
      }
    }
  }
  return undefined;
}

/**
 * 时效多信源交叉验证。
 * 流程：so_search 取多源（maxResults 默认 8，depth 默认 standard）→ 按域名去重计数
 * distinctDomains → 对 Top URL 调 dispatchTool so_fetch → 取 publishedDate 做备注，
 * consistent 当且仅当 多源>=2 且 域名>=2 且 抓取成功>=1。
 * @param {VerifyQueryInput} input 验证输入
 * @param {any} [deps] 调用方注入的依赖（透传给 dispatchTool）
 * @returns {Promise<VerifyResult>} 验证结果
 */
export async function verifyQuery(input, deps) {
  /** 安全输入归一化：非对象输入回退为空对象，后续属性访问走 any。 */
  const safeInput = /** @type {any} */ (input && typeof input === 'object' ? input : {});
  const query = String(safeInput.query || '').trim();
  if (!query) {
    throw new Error('verifyQuery 参数 query 不能为空');
  }
  const fromDate = safeInput.fromDate ? String(safeInput.fromDate) : undefined;
  const toDate = safeInput.toDate ? String(safeInput.toDate) : undefined;
  const maxResults =
    Number.isInteger(safeInput.maxResults) && safeInput.maxResults > 0
      ? safeInput.maxResults
      : 8;
  const depth = safeInput.depth ? String(safeInput.depth) : 'standard';
  // 搜索扇出与抓取分级名单：调用方优先，其次配置，最后缺省（搜索十家、抓取十三家；GNews 仅新闻条件扇出）。
  let searchProviders = normalizeNameList(safeInput.searchProviders)
    ?? readNameList(deps, ['verifySearchProviders', 'searchProviders'])
    ?? ['tinyfish', 'tavily', 'exa', 'langsearch', 'youcom', 'jina', 'querit', 'firecrawl', 'gnews', 'hasdata'];
  // GNews 仅新闻条件扇出：topic 等于 news 或 fromDate/toDate/freshness 任一出现时保留，否则过滤。
  const topicText = typeof safeInput.topic === 'string' ? safeInput.topic.trim().toLowerCase() : '';
  const freshnessRaw = safeInput.freshness;
  const freshnessText = freshnessRaw === undefined || freshnessRaw === null ? '' : String(freshnessRaw).trim();
  const isNewsQuery = topicText === 'news' || fromDate !== undefined || toDate !== undefined || freshnessText !== '';
  if (!isNewsQuery) searchProviders = searchProviders.filter((name) => name !== 'gnews');
  const fetchChain = normalizeNameList(safeInput.fetchChain)
    ?? readNameList(deps, ['verifyFetchChain', 'fetchChain'])
    ?? ['tinyfish', 'tavily', 'exa', 'youcom', 'jina', 'scrapedo', 'scraperapi', 'scrapingant', 'firecrawl', 'hasdata', 'browserless', 'brightdata', 'apify'];

  /** @type {string[]} */
  const notes = [];

  // 第一步：多源搜索扇出（免费优先，失败逐家记入备注）。
  const searchResult = await dispatchTool(
    'so_search',
    { query, fromDate, toDate, maxResults, depth, providers: searchProviders },
    deps,
  );
  const rawResults = Array.isArray(searchResult?.results) ? searchResult.results : [];
  if (Array.isArray(searchResult?.notes)) {
    for (const note of searchResult.notes) notes.push(String(note));
  }

  /** @type {Array<{title: string, url: string, domain: string, provider: string}>} */
  const sources = rawResults
    .filter((/** @type {any} */ item) => item && typeof item.url === 'string' && item.url.length > 0)
    .map((/** @type {any} */ item) => {
      const url = String(item.url);
      return {
        title: typeof item.title === 'string' ? item.title : '',
        url,
        domain: extractDomain(url),
        provider: typeof item.provider === 'string' ? item.provider : 'unknown',
      };
    });

  const domainSet = new Set();
  for (const source of sources) {
    if (source.domain) domainSet.add(source.domain);
  }
  const distinctDomains = domainSet.size;
  // 各搜索源贡献计数：tinyfish:3、tavily:5 形式记入备注。
  /** @type {Map<string, number>} */
  const contribution = new Map();
  for (const source of sources) {
    contribution.set(source.provider, (contribution.get(source.provider) ?? 0) + 1);
  }
  if (contribution.size > 0) {
    const parts = [...contribution.entries()].map(([name, count]) => `${name}:${count}`);
    notes.push(`搜索源贡献 ${parts.join('、')}。`);
  }

  // 第二步：对 Top URL 做抓取验时效。
  const topUrls = sources.slice(0, VERIFY_FETCH_TOP_N).map((source) => source.url);
  /** @type {Array<any>} */
  let fetched = [];
  if (topUrls.length > 0) {
    try {
      const fetchResult = await dispatchTool('so_fetch', { urls: topUrls, chain: fetchChain }, deps);
      fetched = Array.isArray(fetchResult?.results) ? fetchResult.results : [];
      const failedCount = Array.isArray(fetchResult?.errors) ? fetchResult.errors.length : 0;
      if (Array.isArray(fetchResult?.providers) && fetchResult.providers.length > 0) {
        notes.push(`抓取链 ${fetchResult.providers.join('→')}。`);
      } else if (fetchResult?.fallbackUsed) notes.push('抓取已使用回退供应商补抓。');
      if (failedCount > 0) notes.push(`抓取失败 ${failedCount} 条。`);
    } catch (fetchError) {
      // 抓取整体失败不阻断验证，仅记录备注。
      notes.push(`抓取异常：${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
      fetched = [];
    }
  } else {
    notes.push('搜索无可用来源，未执行抓取。');
  }

  // 第三步：时效一致性判断（多源>=2 且 域名>=2 且 抓取成功>=1 即 true）。
  const consistent = sources.length >= 2 && distinctDomains >= 2 && fetched.length >= 1;

  // 收集 publishedDate 用于时效备注。
  const datedCount = fetched.filter((/** @type {any} */ item) => item && item.publishedDate).length;
  notes.unshift(
    `搜索 ${sources.length} 源、去重域名 ${distinctDomains} 个、抓取成功 ${fetched.length} 条` +
      (fetched.length > 0 ? `（含发布时间 ${datedCount} 条）` : '。'),
  );
  if (!consistent) {
    notes.push('未达到一致性阈值（需多源>=2、域名>=2、抓取成功>=1）。');
  }
  // 第四步：装配逐条引用（来源序号与抓取按 URL 对齐，便于逐条核对）。
  /** @type {Map<string, any>} */
  const fetchedByUrl = new Map();
  for (const item of fetched) {
    if (item && typeof item.url === 'string' && !fetchedByUrl.has(item.url)) {
      fetchedByUrl.set(item.url, item);
    }
  }
  const citations = sources.map((source, index) => ({
    index: index + 1,
    source,
    fetched: fetchedByUrl.get(source.url) ?? null,
  }));

  return {
    query,
    window: { fromDate, toDate },
    sources,
    fetched,
    citations,
    distinctDomains,
    consistent,
    notes,
  };
}
