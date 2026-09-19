/**
 * lib/tools.js
 * MCP 工具定义与分发：so_search / so_fetch / so_verify。
 * 零运行时依赖，原生 ESM，变量名英文、注释与 JSDoc 中文。
 */

import { getSearchProvider, getFetchProvider } from './providers/index.js';

/**
 * 统一搜索输入形状。
 * @typedef {object} UnifiedSearchInput
 * @property {string} query 搜索关键词
 * @property {string} [depth] flash|fast|standard|deep
 * @property {string} [outputType] searchResults|sourcedAnswer|structured
 * @property {string} [fromDate] 起始日期 YYYY-MM-DD
 * @property {string} [toDate] 结束日期 YYYY-MM-DD
 * @property {number} [maxResults] 最大结果数
 * @property {string[]} [includeDomains] 限定域名
 * @property {string[]} [excludeDomains] 排除域名
 * @property {string[]|string} [providers] 搜索扇出名单（可选，多源并行）
 */

/**
 * 统一抓取输入形状。
 * @typedef {object} UnifiedFetchInput
 * @property {string[]} urls 待抓取地址（1..10 条）
 * @property {string} [format] markdown|html
 * @property {number} [ttl] 缓存秒数
 * @property {number} [perUrlTimeoutMs] 单地址超时毫秒
 * @property {string[]|string} [chain] 抓取分级名单（可选，按序降级，上限 16 级）
 */

/**
 * 调用方注入的依赖（lib/config.js 的 resolveDeps 产物或其 Config）。
 * 兼容三种形态：{resolved:{config}}（端点透传）、{config}、扁平 Config 本体；
 * 下游供应商统一经 resolveProviderDeps 拍平后调用。
 * @typedef {object} ToolDeps
 * @property {object} [config] 直挂配置
 * @property {{config?: object}} [resolved] resolveDeps 的 resolved 包
 * @property {string} [searchProvider] 扁平形态直挂字段（兼容用）
 * @property {string} [fetchPrimary] 扁平形态直挂字段（兼容用）
 * @property {string} [fetchFallback] 扁平形态直挂字段（兼容用）
 * @property {string} [tinyfishApiKey] 扁平形态直挂密钥（兼容用）
 */

/**
 * 三个 MCP 工具的 JSON Schema 定义（供 tools/list 直接返回）。
 * 工具名固定：so_search、so_fetch、so_verify。
 * @type {Array<{name: string, description: string, inputSchema: object}>}
 */
export const TOOL_DEFS = [
  {
    name: 'so_search',
    description: '统一搜索：默认 tinyfish 单源，可选十家并行扇出（providers）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        depth: { type: 'string', enum: ['flash', 'fast', 'standard', 'deep'] },
        outputType: { type: 'string', enum: ['searchResults', 'sourcedAnswer', 'structured'] },
        fromDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        toDate: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        includeDomains: { type: 'array', items: { type: 'string' } },
        excludeDomains: { type: 'array', items: { type: 'string' } },
        providers: { type: 'array', items: { type: 'string' }, description: '搜索扇出名单（可选，如 ["tinyfish","tavily"]）' },
      },
      required: ['query'],
      additionalProperties: true,
    },
  },
  {
    name: 'so_fetch',
    description: '统一抓取：默认 tinyfish 单级，可选十三家分级链并行分工（chain，上限 16 级）。',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 10,
          description: '待抓取地址（1..10 条）',
        },
        format: { type: 'string', enum: ['markdown', 'html'] },
        ttl: { type: 'integer', minimum: 0 },
        perUrlTimeoutMs: { type: 'integer', minimum: 1000 },
        chain: { type: 'array', items: { type: 'string' }, description: '抓取分级名单（可选，如 ["tinyfish","tavily"]）' },
      },
      required: ['urls'],
      additionalProperties: true,
    },
  },
  {
    name: 'so_verify',
    description: '时效多信源交叉验证：搜索取多源，去重计数并抓取验时效，逐条带引用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '待验证问题或主题' },
        fromDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        toDate: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        depth: { type: 'string', enum: ['flash', 'fast', 'standard', 'deep'] },
        searchProviders: { type: 'array', items: { type: 'string' }, description: '搜索扇出名单（可选，默认 tinyfish,tavily）' },
        fetchChain: { type: 'array', items: { type: 'string' }, description: '抓取分级名单（可选，默认 tinyfish,tavily）' },
      },
      required: ['query'],
      additionalProperties: true,
    },
  },
];

/**
 * 归一供应商名单：数组或逗号串转小写去重数组，未提供回 undefined。
 * @param {unknown} raw 名单原文
 * @returns {string[]|undefined} 归一化名单
 */
function normalizeProviderList(raw) {
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
 * 从多种 deps 形态中提取统一 Config。
 * 优先级：deps.config > deps.resolved.config > deps 本体扁平字段。
 * @param {any} deps 调用方注入的依赖
 * @returns {Record<string, any>} 归一化配置（恒为对象）
 */
function resolveToolConfig(deps) {
  const fromConfig = deps && typeof deps === 'object' ? deps.config : undefined;
  const fromResolved = deps && typeof deps === 'object' ? deps.resolved?.config : undefined;
  const flat = deps && typeof deps === 'object' ? deps : {};
  /** @type {Record<string, any>} */
  const merged = {
    searchProvider: undefined,
    fetchPrimary: undefined,
    fetchFallback: undefined,
    tinyfishApiKey: undefined,
    tavilyApiKey: undefined,
    exaApiKey: undefined,
    langsearchApiKey: undefined,
    youcomApiKey: undefined,
    queritApiKey: undefined,
    hasdataApiKey: undefined,
    firecrawlApiKey: undefined,
    scrapedoApiKey: undefined,
    scraperapiApiKey: undefined,
    brightdataApiKey: undefined,
    browserlessApiKey: undefined,
    jinaApiKey: undefined,
    scrapingantApiKey: undefined,
    apifyApiKey: undefined,
    gnewsApiKey: undefined,
  };
  // 扁平本体先垫底，直挂 config / resolved.config 逐层覆盖。
  for (const key of Object.keys(merged)) {
    if (typeof flat[key] === 'string') merged[key] = flat[key];
  }
  for (const source of [fromConfig, fromResolved]) {
    if (source && typeof source === 'object') {
      for (const key of Object.keys(merged)) {
        if (typeof source[key] === 'string') merged[key] = source[key];
      }
    }
  }
  // 透传其余配置字段（端点地址、超时等）同样按 扁平 < config < resolved.config 合并。
  /** @type {Record<string, any>} */
  const extra = {};
  for (const source of [flat, fromConfig, fromResolved]) {
    if (source && typeof source === 'object') {
      for (const key of Object.keys(source)) {
        if (key === 'config' || key === 'resolved') continue;
        if (source[key] !== undefined) extra[key] = source[key];
      }
    }
  }
  // 名单字段归一为小写数组：数组或逗号串均可，优先级 resolved.config > config > 扁平。
  const listKeys = ['searchProviders', 'fetchChain', 'verifySearchProviders', 'verifyFetchChain'];
  /** @type {Record<string, any>} */
  const lists = {};
  for (const key of listKeys) {
    const raw = (fromResolved && typeof fromResolved === 'object' && fromResolved[key] !== undefined)
      ? fromResolved[key]
      : (fromConfig && typeof fromConfig === 'object' && fromConfig[key] !== undefined)
        ? fromConfig[key]
        : flat[key];
    const normalized = normalizeProviderList(raw);
    if (normalized !== undefined) lists[key] = normalized;
  }
  return { ...extra, ...merged, ...lists };
}

/**
 * 组装透传给供应商的依赖：拍平后的配置 + 原 deps 透传字段（如 fetchImpl）。
 * 供应商只认扁平密钥，此处保证无论上游传哪种形态都能读到。
 * @param {any} deps 调用方注入的依赖
 * @param {Record<string, any>} toolConfig 归一化配置
 * @returns {any} 下游依赖
 */
function resolveProviderDeps(deps, toolConfig) {
  const base = deps && typeof deps === 'object' ? deps : {};
  return { ...base, ...toolConfig, config: toolConfig };
}
/**
 * 判断抛出的异常是否值得回退：纯标志判断，只有明确 retryable:false 才跳过。
 * 与 errors[] 条目规则一致；无标志的凭证类错误同样尝试回退（回退方可能有可用 Key/额度）。
 * @param {any} error 捕获的异常
 * @returns {boolean} 是否可重试
 */
function isRetryableThrown(error) {
  if (error && typeof error === 'object' && error.retryable === false) return false;
  return true;
}

/**
 * 判断抓取错误是否值得重试（缺省可重试，只有明确 retryable:false 才跳过）。
 * @param {any} errItem UnifiedFetch errors 数组中的单项
 * @returns {boolean} 是否可重试
 */
function isRetryableError(errItem) {
  if (!errItem || typeof errItem !== 'object') return true;
  if (errItem.retryable === false) return false;
  return true;
}

/**
 * 归一化抓取供应商返回值，保证 {results, errors} 形状。
 * @param {any} value 供应商原始返回值
 * @returns {{results: Array<any>, errors: Array<any>}} 归一化结果
 */
function normalizeFetchResult(value) {
  const results = Array.isArray(value?.results) ? value.results : [];
  const errors = Array.isArray(value?.errors) ? value.errors : [];
  return { results, errors };
}

/**
 * 分发 MCP 工具调用。
 * - so_search：按归一化配置 searchProvider 取搜索供应商并调用。
 * - so_fetch：先调主抓取（fetchPrimary），errors 非空或抛错且可重试时用回退供应商补抓并置 fallbackUsed=true。
 * - so_verify：转调 verifyQuery（动态导入，避免与 lib/verify.js 静态循环依赖）。
 * @param {string} name 工具名
 * @param {any} args 工具参数
 * @param {ToolDeps} [deps] 调用方注入的依赖（端点 resolveDeps 产物或直挂 Config 均可）
 * @returns {Promise<any>} 工具执行结果（可 JSON 序列化）
 */
export async function dispatchTool(name, args, deps) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  // 归一化配置并拍平透传：供应商只认扁平密钥。
  const toolConfig = resolveToolConfig(deps);
  const providerDeps = resolveProviderDeps(deps, toolConfig);

  switch (name) {
    case 'so_search': {
      // 可选 providers 数组：缺省走 SEARCH_PROVIDER 单源老语义。
      const fanout = normalizeProviderList(safeArgs.providers ?? toolConfig.searchProviders);
      if (!fanout || fanout.length <= 1) {
        // 按 SEARCH_PROVIDER 选择搜索供应商，默认 tinyfish。
        const providerName = (fanout && fanout[0]) || toolConfig.searchProvider || 'tinyfish';
        const searchFn = getSearchProvider(providerName);
        if (typeof searchFn !== 'function') {
          throw new Error(`未知搜索供应商: ${providerName}`);
        }
        return await searchFn(safeArgs, providerDeps);
      }
      // 多源并行扇出：全部并行，逐家结算，失败不阻断其他家。
      const settled = await Promise.allSettled(
        fanout.map(async (providerName) => {
          const searchFn = getSearchProvider(providerName);
          if (typeof searchFn !== 'function') throw new Error(`未知搜索供应商: ${providerName}`);
          const result = await searchFn(safeArgs, providerDeps);
          const items = Array.isArray(result?.results) ? result.results : [];
          return { providerName, items, usage: result?.usage, answer: result?.answer };
        }),
      );
      /** @type {Array<any>} */
      const merged = [];
      /** @type {Array<any>} */
      const errors = [];
      /** @type {Array<string>} */
      const notes = [];
      /** @type {Set<string>} */
      const seenUrls = new Set();
      /** @type {Array<string>} */
      const okProviders = [];
      for (let index = 0; index < settled.length; index += 1) {
        const providerName = fanout[index];
        const entry = settled[index];
        if (entry.status !== 'fulfilled') {
          const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
          errors.push({ provider: providerName, error: reason, retryable: true });
          notes.push(`搜索 ${providerName} 失败：${reason}`);
          continue;
        }
        okProviders.push(providerName);
        for (const item of entry.value.items) {
          const url = item && typeof item.url === 'string' ? item.url : '';
          if (!url) continue;
          // 按 URL 去重，保留首见条目与其 provider 归属。
          if (seenUrls.has(url)) continue;
          seenUrls.add(url);
          merged.push({ ...item, provider: item.provider || providerName });
        }
      }
      return { provider: 'fanout', providers: okProviders, results: merged, errors, notes };
    }

    case 'so_fetch': {
      // 校验 urls 形状：1..10 条。
      const urls = safeArgs.urls;
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 10) {
        throw new Error('so_fetch 参数 urls 须为 1..10 条地址数组');
      }
      // 可选 chain 数组：缺省走主备老语义；传入时十三家并行分工，上限 16 级防烧钱。
      const chain = normalizeProviderList(safeArgs.chain ?? toolConfig.fetchChain);
      const primaryName = toolConfig.fetchPrimary || 'tinyfish';
      const fallbackName = toolConfig.fetchFallback || 'tinyfish';
      const levels = chain && chain.length > 0 ? chain.slice(0, 16) : [primaryName, fallbackName];
      // 去重保序：同名只保留首次出现。
      /** @type {Array<string>} */
      const ordered = [];
      for (const name of levels) {
        if (!ordered.includes(name)) ordered.push(name);
      }
      // 单级老语义：保持原主备行为（首级失败才走次级）。
      if (ordered.length <= 1) {
        const providerName = ordered[0];
        const fetchFn = getFetchProvider(providerName);
        if (typeof fetchFn !== 'function') {
          throw new Error(`未知抓取供应商: ${providerName}`);
        }
        const single = normalizeFetchResult(await fetchFn(safeArgs, providerDeps));
        return { results: single.results, errors: single.errors, fallbackUsed: false, providers: [providerName] };
      }
      // 多级并行分工：第一轮按地址轮转分片同时开打，空分片跳过省额度。
      const targets = urls.map((url) => String(url));
      /** @type {Array<Array<string>>} */
      const shards = ordered.map(() => []);
      targets.forEach((url, index) => {
        shards[index % ordered.length].push(url);
      });
      const firstSettled = await Promise.allSettled(
        ordered.map(async (providerName, shardIndex) => {
          if (shards[shardIndex].length === 0) return { providerName, skipped: true, result: { results: [], errors: [] } };
          const fetchFn = getFetchProvider(providerName);
          if (typeof fetchFn !== 'function') throw new Error(`未知抓取供应商: ${providerName}`);
          const params = { ...safeArgs, urls: shards[shardIndex] };
          const result = normalizeFetchResult(await fetchFn(params, providerDeps));
          return { providerName, skipped: false, result };
        }),
      );
      /** @type {Map<string, any>} */
      const okByUrl = new Map();
      /** @type {Array<any>} */
      const keptErrors = [];
      /** @type {Array<{url: string, from: string}>} */
      const retryQueue = [];
      /** @type {Array<string>} */
      const usedProviders = [];
      for (let index = 0; index < firstSettled.length; index += 1) {
        const providerName = ordered[index];
        const entry = firstSettled[index];
        if (entry.status !== 'fulfilled' || entry.value.skipped) {
          if (entry.status !== 'fulfilled') {
            const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
            for (const url of shards[index]) retryQueue.push({ url, from: providerName });
            usedProviders.push(providerName);
          }
          continue;
        }
        usedProviders.push(providerName);
        for (const item of entry.value.result.results) {
          if (item && typeof item.url === 'string' && !okByUrl.has(item.url)) {
            okByUrl.set(item.url, { ...item, provider: item.provider || providerName });
          }
        }
        for (const item of entry.value.result.errors) {
          if (!item || typeof item.url !== 'string') continue;
          if (okByUrl.has(item.url)) continue;
          if (isRetryableError(item)) retryQueue.push({ url: item.url, from: providerName });
          else keptErrors.push({ ...item, provider: item.provider || providerName });
        }
      }
      // 第二轮：可重试失败换家并行重打，最多再打一轮封顶成本。
      if (retryQueue.filter((task) => !okByUrl.has(task.url)).length > 0) {
        /** @type {Map<string, Array<string>>} */
        const retryShards = new Map();
        retryQueue.filter((task) => !okByUrl.has(task.url)).forEach((task, taskIndex) => {
          const fromIndex = ordered.indexOf(task.from);
          const pick = ordered[(fromIndex + 1 + taskIndex) % ordered.length] ?? ordered[(taskIndex + 1) % ordered.length];
          if (!retryShards.has(pick)) retryShards.set(pick, []);
          retryShards.get(pick).push(task.url);
        });
        const retryEntries = [...retryShards.entries()];
        const secondSettled = await Promise.allSettled(
          retryEntries.map(async ([providerName, retryUrls]) => {
            const fetchFn = getFetchProvider(providerName);
            if (typeof fetchFn !== 'function') throw new Error(`未知抓取供应商: ${providerName}`);
            const params = { ...safeArgs, urls: retryUrls };
            const result = normalizeFetchResult(await fetchFn(params, providerDeps));
            return { providerName, result };
          }),
        );
        for (let index = 0; index < secondSettled.length; index += 1) {
          const providerName = retryEntries[index][0];
          if (!usedProviders.includes(providerName)) usedProviders.push(providerName);
          const entry = secondSettled[index];
          if (entry.status !== 'fulfilled') {
            const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
            for (const url of retryEntries[index][1]) {
              if (!okByUrl.has(url)) keptErrors.push({ url, error: `${providerName}: ${reason}`, retryable: true, provider: providerName });
            }
            continue;
          }
          for (const item of entry.value.result.results) {
            if (item && typeof item.url === 'string' && !okByUrl.has(item.url)) {
              okByUrl.set(item.url, { ...item, provider: item.provider || providerName });
            }
          }
          for (const item of entry.value.result.errors) {
            if (!item || typeof item.url !== 'string') continue;
            if (okByUrl.has(item.url)) continue;
            keptErrors.push({ ...item, provider: item.provider || providerName });
          }
        }
      }
      return {
        results: [...okByUrl.values()],
        errors: keptErrors,
        fallbackUsed: usedProviders.length > 1,
        providers: usedProviders,
      };
    }


    case 'so_verify': {
      // 动态导入打破 tools <-> verify 的静态循环依赖。
      const verifyModule = await import('./verify.js');
      return await verifyModule.verifyQuery(safeArgs, deps);
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}
