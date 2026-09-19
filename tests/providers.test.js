/**
 * tests/providers.test.js
 * 供应商层单测：全部用桩 fetchImpl，不打真实网络。
 * 覆盖搜索映射、抓取 retryable 标记、批量结算、缺键抛码、回退链、分级上限、搜索扇出、
 * 余额端点鉴权、十六家余额（六家实调十家占位）、动态钱包双家与空名单。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tavilySearch } from '../lib/providers/search-tavily.js';
import { tinyfishFetch } from '../lib/providers/fetch-tinyfish.js';
import { tavilyFetch } from '../lib/providers/fetch-tavily.js';
import { langsearchSearch } from '../lib/providers/search-langsearch.js';
import { gnewsSearch } from '../lib/providers/search-gnews.js';
import { jinaSearch } from '../lib/providers/search-jina.js';
import { youcomSearch } from '../lib/providers/search-youcom.js';
import { youcomFetch } from '../lib/providers/fetch-youcom.js';
import { brightdataFetch } from '../lib/providers/fetch-brightdata.js';
import { browserlessFetch } from '../lib/providers/fetch-browserless.js';
import { jinaFetch } from '../lib/providers/fetch-jina.js';
import { scrapingantFetch } from '../lib/providers/fetch-scrapingant.js';
import { apifyFetch } from '../lib/providers/fetch-apify.js';
import {
  getTinyfishWallet,
  getTavilyBalance,
  getHasdataBalance,
  getFirecrawlBalance,
  getScrapedoBalance,
  getScraperapiBalance,
  getExaBalance,
  getQueritBalance,
  getLangsearchBalance,
  getYoucomBalance,
  getBrightdataBalance,
  getBrowserlessBalance,
  getJinaBalance,
  getScrapingantBalance,
  getApifyBalance,
  getGnewsBalance,
} from '../lib/credits.js';
import { dispatchTool } from '../lib/tools.js';
import { handleCredits } from '../lib/endpoints/credits.js';

/** Tinyfish 抓取地址（与实现默认值对齐，回退桩路由用）。 */
const TINYFISH_FETCH_URL = 'https://api.fetch.tinyfish.ai';
/** Tinyfish 钱包地址（与实现默认值对齐，钱包与智能体同宿主，与抓取宿主分离）。 */
const TINYFISH_WALLET_URL = 'https://agent.tinyfish.ai/v1/wallet';
/** 回退成功的目标地址。 */
const GOOD_URL = 'https://case.local/good';
/** 回退失败的目标地址。 */
const BAD_URL = 'https://case.local/bad';
/** 余额端点冒烟用的代理密钥（只活在单测进程）。 */
const PROXY_KEY = 'test-proxy-key';

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
 * 搜索桩：返回两种字段形态的结果，断言映射用。
 * @param {string} url 请求地址
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<unknown>}>} 桩响应
 */
async function searchStub(url) {
  assert.match(String(url), /api\.tavily\.com\/search/);
  return stubResponse({
    results: [
      { title: '标题甲', url: 'https://case.local/1', content: '正文甲' },
      { title: '标题乙', link: 'https://case.local/2', snippet: '正文乙' },
    ],
  });
}

/** 搜索映射：url/content 与 link/snippet 都归一为 title/url/content。 */
describe('tavilySearch 映射', () => {
  it('两种字段形态都归一', async () => {
    const out = await tavilySearch({ query: '单测' }, {
      tavilyApiKey: 'test-key',
      fetchImpl: searchStub,
    });
    assert.equal(out.provider, 'tavily');
    assert.equal(out.results.length, 2);
    assert.deepEqual(
      { title: out.results[0].title, url: out.results[0].url, content: out.results[0].content },
      { title: '标题甲', url: 'https://case.local/1', content: '正文甲' },
    );
    assert.deepEqual(
      { title: out.results[1].title, url: out.results[1].url, content: out.results[1].content },
      { title: '标题乙', url: 'https://case.local/2', content: '正文乙' },
    );
  });
});

/** 抓取包内错误：timeout 可重试、page_not_found 不可重试。 */
describe('tinyfishFetch 错误标记', () => {
  it('retryable 按枚举标记', async () => {
    /** @type {(url: string) => Promise<any>} 固定包内错误的桩 */
    const mixedStub = async () => stubResponse({
      results: [],
      errors: [
        { url: 'https://case.local/1', error: 'timeout' },
        { url: 'https://case.local/2', error: 'page_not_found' },
      ],
    });
    const out = await tinyfishFetch({ urls: ['https://case.local/1', 'https://case.local/2'] }, {
      tinyfishApiKey: 'test-key',
      fetchImpl: mixedStub,
    });
    assert.equal(out.errors.length, 2);
    assert.equal(out.errors[0].retryable, true);
    assert.equal(out.errors[1].retryable, false);
  });
});

/** 批量结算：成功地址进 results，失败地址进 errors 且不可重试。 */
describe('tavilyFetch 批量结算', () => {
  it('逐地址结算互不干扰', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 固定批量回包的桩 */
    const fanoutStub = async (url) => {
      assert.match(String(url), /api\.tavily\.com\/extract/);
      return stubResponse({
        results: [{ url: GOOD_URL, title: '好标题', raw_content: '好正文' }],
        failed_results: [{ url: BAD_URL, error: 'extract_failed' }],
      });
    };
    const out = await tavilyFetch({ urls: [GOOD_URL, BAD_URL] }, {
      tavilyApiKey: 'test-key',
      fetchImpl: fanoutStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '好正文');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].url, BAD_URL);
    assert.equal(out.errors[0].retryable, false);
  });
});

/** 缺 Key：直接抛 CREDENTIAL_MISSING，不触碰网络。 */
describe('tavilySearch 缺 Key', () => {
  it('抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      tavilySearch({ query: '单测' }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});
/** LangSearch 映射：results 归一为 title/url/content，缺键抛 CREDENTIAL_MISSING。 */
describe('langsearchSearch 映射与缺键', () => {
  it('两种字段形态都归一', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} LangSearch 搜索桩 */
    const langsearchStub = async (url) => {
      assert.match(String(url), /api\.langsearch\.com\/v1\/web-search/);
      return stubResponse({
        results: [
          { title: '郎标题甲', url: 'https://case.local/1', content: '郎正文甲' },
          { title: '郎标题乙', url: 'https://case.local/2', snippet: '郎正文乙' },
        ],
      });
    };
    const out = await langsearchSearch({ query: '单测' }, {
      langsearchApiKey: 'test-key',
      fetchImpl: langsearchStub,
    });
    assert.equal(out.provider, 'langsearch');
    assert.equal(out.results.length, 2);
    assert.deepEqual(
      { title: out.results[0].title, url: out.results[0].url, content: out.results[0].content },
      { title: '郎标题甲', url: 'https://case.local/1', content: '郎正文甲' },
    );
    assert.deepEqual(
      { title: out.results[1].title, url: out.results[1].url, content: out.results[1].content },
      { title: '郎标题乙', url: 'https://case.local/2', content: '郎正文乙' },
    );
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      langsearchSearch({ query: '单测' }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** You.com 搜索映射：results 归一为 title/url/content，缺键抛 CREDENTIAL_MISSING。 */
describe('youcomSearch 映射与缺键', () => {
  it('两种字段形态都归一', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} You.com 搜索桩 */
    const youcomStub = async (url) => {
      assert.match(String(url), /api\.ydc-index\.io\/search/);
      return stubResponse({
        results: [
          { title: '优标题甲', url: 'https://case.local/1', snippet: '优正文甲' },
          { title: '优标题乙', url: 'https://case.local/2', content: '优正文乙' },
        ],
      });
    };
    const out = await youcomSearch({ query: '单测' }, {
      youcomApiKey: 'test-key',
      fetchImpl: youcomStub,
    });
    assert.equal(out.provider, 'youcom');
    assert.equal(out.results.length, 2);
    assert.deepEqual(
      { title: out.results[0].title, url: out.results[0].url, content: out.results[0].content },
      { title: '优标题甲', url: 'https://case.local/1', content: '优正文甲' },
    );
    assert.deepEqual(
      { title: out.results[1].title, url: out.results[1].url, content: out.results[1].content },
      { title: '优标题乙', url: 'https://case.local/2', content: '优正文乙' },
    );
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      youcomSearch({ query: '单测' }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** You.com 抓取批量结算：成功地址进 results，失败地址进 errors 且不可重试。 */
describe('youcomFetch 批量结算', () => {
  it('逐地址结算互不干扰', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 新版 POST 端点按体分流的桩 */
    const batchStub = async (url, init = {}) => {
      assert.match(String(url), /youcom\.local\/v1\/contents/);
      const asked = JSON.parse(init.body || '{}').urls || [];
      if (asked.includes(BAD_URL)) {
        return stubResponse({ error: 'not_found' }, 404);
      }
      return stubResponse({
        contents: asked.map((/** @type {any} */ target) => ({ url: target, title: '好标题', markdown: '好正文' })),
      });
    };
    const out = await youcomFetch({ urls: [GOOD_URL, BAD_URL] }, {
      youcomApiKey: 'test-key',
      fetchUrlYoucom: 'https://youcom.local/v1/contents',
      fetchImpl: batchStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '好正文');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].url, BAD_URL);
    assert.equal(out.errors[0].retryable, false);
  });
});

/** BrightData 抓取：无 zone 可发网且请求体不带 zone，缺键抛 CREDENTIAL_MISSING。 */
describe('brightdataFetch 无 zone 与缺键', () => {
  it('无 zone 可发网且请求体不带 zone', async () => {
    /** @type {any} 捕获到的上游请求体 */
    let seenBody;
    /** @type {(url: string, init?: any) => Promise<any>} 断言请求体并回固定正文的桩 */
    const noZoneStub = async (url, init = {}) => {
      assert.match(String(url), /api\.brightdata\.com\/request/);
      seenBody = JSON.parse(init.body || '{}');
      return {
        ok: true,
        status: 200,
        headers: { get: () => '' },
        text: async () => '# 好标题\n好正文',
      };
    };
    const out = await brightdataFetch({ urls: [GOOD_URL] }, {
      brightdataApiKey: 'test-key',
      fetchImpl: noZoneStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '# 好标题\n好正文');
    assert.equal('zone' in (seenBody ?? {}), false);
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      brightdataFetch({ urls: [GOOD_URL] }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** 钱包默认宿主：钱包与智能体同宿主，缺键抛码、鉴权四态不断言旧抓取宿主。 */
describe('getTinyfishWallet 默认钱包宿主', () => {
  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      getTinyfishWallet({ fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });

  it('默认请求智能体侧钱包地址', async () => {
    /** @type {string[]} 收到的请求地址 */
    const seen = [];
    /** @type {(url: string) => Promise<any>} 记录地址的桩 */
    const recordStub = async (url) => {
      seen.push(String(url));
      return stubResponse({ available_balance: '21.44', currency: 'USD', as_of: '2026-08-10T18:04:11.220Z' });
    };
    const out = await getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: recordStub });
    assert.equal(out.provider, 'tinyfish');
    assert.equal(seen.length, 1);
    assert.equal(seen[0], TINYFISH_WALLET_URL);
    assert.equal(out.remaining, 21.44);
    assert.equal(out.balance, 21.44);
    assert.equal(out.currency, 'USD');
    assert.equal(out.limit, null);
    assert.equal(out.usage, null);
    assert.deepEqual(out.raw, { available_balance: '21.44', currency: 'USD', as_of: '2026-08-10T18:04:11.220Z' });
  });

  it('404 转 legacy 占位不抛错', async () => {
    /** @type {(url: string) => Promise<any>} 固定 404 的桩 */
    const legacyStub = async () => stubResponse({ error: { code: 'FEATURE_NOT_AVAILABLE' } }, 404);
    const out = await getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: legacyStub });
    assert.equal(out.provider, 'tinyfish');
    assert.equal(out.balance, null);
    assert.equal(out.remaining, null);
    assert.match(String(out.note), /legacy/);
  });

  it('鉴权四态：401/403 抛 CREDENTIAL_MISSING，其余非 2xx 抛 UPSTREAM_ERROR', async () => {
    for (const status of [401, 403]) {
      /** @type {(url: string) => Promise<any>} 固定鉴权失败的桩 */
      const authStub = async () => stubResponse({ message: 'unauthorized' }, status);
      await assert.rejects(
        getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: authStub }),
        (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
      );
    }
    /** @type {(url: string) => Promise<any>} 固定服务端异常的桩 */
    const errorStub = async () => stubResponse({ message: 'boom' }, 500);
    await assert.rejects(
      getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: errorStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'UPSTREAM_ERROR',
    );
    /** @type {(url: string) => Promise<any>} 固定超时的桩 */
    const timeoutStub = async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    };
    await assert.rejects(
      getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: timeoutStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'UPSTREAM_TIMEOUT',
    );
  });
});

/** Tavily 实调：单接口 GET /usage，总额取计划级，剩余=总额-已用。 */
describe('getTavilyBalance 实调', () => {
  it('成功归一 limit/usage/remaining', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 按地址路由的桩 */
    const usageStub = async (url, init = {}) => {
      assert.match(String(url), /api\.tavily\.com\/usage/);
      assert.match(String(init?.headers?.Authorization ?? ''), /^Bearer /);
      return stubResponse({
        key: { usage: 150, limit: 1000 },
        account: { plan_usage: 500, plan_limit: 15000, current_plan: 'Bootstrap' },
      });
    };
    const out = await getTavilyBalance({ tavilyApiKey: 'test-key', fetchImpl: usageStub });
    assert.equal(out.provider, 'tavily');
    assert.equal(out.limit, 15000);
    assert.equal(out.usage, 500);
    assert.equal(out.remaining, 14500);
    assert.equal(out.balance, 14500);
    assert.equal(out.unit, 'credits');
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      getTavilyBalance({ fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });

  it('401 转 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 固定鉴权失败的桩 */
    const authStub = async () => stubResponse({ message: 'unauthorized' }, 401);
    await assert.rejects(
      getTavilyBalance({ tavilyApiKey: 'test-key', fetchImpl: authStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** HasData 实调：单接口 GET /user/me/usage，已用本地推导。 */
describe('getHasdataBalance 实调', () => {
  it('成功归一 remaining/limit/usage', async () => {
    /** @type {(url: string) => Promise<any>} 按地址路由的桩 */
    const usageStub = async (url) => {
      assert.match(String(url), /api\.hasdata\.com\/user\/me\/usage/);
      return stubResponse({
        status: 'ok',
        data: { totalCredits: 10000000, availableCredits: 5473702, concurrentRequests: 0, availableConcurrency: 100 },
      });
    };
    const out = await getHasdataBalance({ hasdataApiKey: 'test-key', fetchImpl: usageStub });
    assert.equal(out.provider, 'hasdata');
    assert.equal(out.remaining, 5473702);
    assert.equal(out.balance, 5473702);
    assert.equal(out.limit, 10000000);
    assert.equal(out.usage, 10000000 - 5473702);
  });
});

/** Firecrawl 实调：单接口 GET /v2/team/credit-usage，camel 与 snake 双兼容。 */
describe('getFirecrawlBalance 实调', () => {
  it('成功归一 remaining/limit', async () => {
    /** @type {(url: string) => Promise<any>} 按地址路由的桩 */
    const creditStub = async (url) => {
      assert.match(String(url), /api\.firecrawl\.dev\/v2\/team\/credit-usage/);
      return stubResponse({ success: true, data: { remainingCredits: 1000, planCredits: 500000 } });
    };
    const out = await getFirecrawlBalance({ firecrawlApiKey: 'test-key', fetchImpl: creditStub });
    assert.equal(out.provider, 'firecrawl');
    assert.equal(out.remaining, 1000);
    assert.equal(out.balance, 1000);
    assert.equal(out.limit, 500000);
  });

  it('snake_case 回退', async () => {
    /** @type {(url: string) => Promise<any>} 蛇形字段的桩 */
    const snakeStub = async () => stubResponse({ success: true, data: { remaining_credits: 42, plan_credits: 1000 } });
    const out = await getFirecrawlBalance({ firecrawlApiKey: 'test-key', fetchImpl: snakeStub });
    assert.equal(out.remaining, 42);
    assert.equal(out.limit, 1000);
  });
});

/** Scrape.do 实调：主 info 接口，429/5xx 降级 /me。 */
describe('getScrapedoBalance 实调', () => {
  it('主接口成功归一 remaining/limit/usage', async () => {
    /** @type {(url: string) => Promise<any>} 按地址路由的桩 */
    const infoStub = async (url) => {
      assert.match(String(url), /api\.scrape\.do\/info/);
      return stubResponse({ IsActive: true, MaxMonthlyRequest: 3500000, RemainingMonthlyRequest: 2565023 });
    };
    const out = await getScrapedoBalance({ scrapedoApiKey: 'test-key', fetchImpl: infoStub });
    assert.equal(out.provider, 'scrapedo');
    assert.equal(out.remaining, 2565023);
    assert.equal(out.balance, 2565023);
    assert.equal(out.limit, 3500000);
    assert.equal(out.usage, 3500000 - 2565023);
  });

  it('/me 降级回剩余点数', async () => {
    /** @type {(url: string) => Promise<any>} 主限流备成功的桩 */
    const fallbackStub = async (url) => {
      const text = String(url);
      if (text.includes('api.scrape.do/info')) return stubResponse({ message: 'throttled' }, 429);
      assert.match(text, /q\.scrape\.do\/api\/v1\/me/);
      return stubResponse({ AvaliableCredits: 42 });
    };
    const out = await getScrapedoBalance({ scrapedoApiKey: 'test-key', fetchImpl: fallbackStub });
    assert.equal(out.provider, 'scrapedo');
    assert.equal(out.remaining, 42);
    assert.equal(out.balance, 42);
  });
});

/** ScraperAPI 实调：单接口 GET /account，requestLimit 可能为字符串。 */
describe('getScraperapiBalance 实调', () => {
  it('成功归一 remaining=412', async () => {
    /** @type {(url: string) => Promise<any>} 按地址路由的桩 */
    const accountStub = async (url) => {
      assert.match(String(url), /api\.scraperapi\.com\/account/);
      return stubResponse({ requestLimit: '1000', requestCount: 588, concurrentRequests: 0, concurrencyLimit: 5 });
    };
    const out = await getScraperapiBalance({ scraperapiApiKey: 'test-key', fetchImpl: accountStub });
    assert.equal(out.provider, 'scraperapi');
    assert.equal(out.limit, 1000);
    assert.equal(out.usage, 588);
    assert.equal(out.remaining, 412);
    assert.equal(out.balance, 412);
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      getScraperapiBalance({ fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });

  it('401 转 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 固定鉴权失败的桩 */
    const authStub = async () => stubResponse({ message: 'unauthorized' }, 401);
    await assert.rejects(
      getScraperapiBalance({ scraperapiApiKey: 'test-key', fetchImpl: authStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** Exa/Querit 占位：无公开余额接口，不触网。 */
describe('getExaBalance/getQueritBalance 占位', () => {
  it('Exa 回 null 余额且 note 含 dashboard 提示', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('占位不应触碰网络');
    };
    const out = await getExaBalance({ exaApiKey: 'test-key', fetchImpl: neverStub });
    assert.equal(out.provider, 'exa');
    assert.equal(out.balance, null);
    assert.equal(out.remaining, null);
    assert.match(String(out.note), /dashboard/i);
  });

  it('Querit 回 null 余额且 note 含文档提示', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('占位不应触碰网络');
    };
    const out = await getQueritBalance({ queritApiKey: 'test-key', fetchImpl: neverStub });
    assert.equal(out.provider, 'querit');
    assert.equal(out.balance, null);
    assert.equal(out.remaining, null);
    assert.match(String(out.note), /Dashboard/);
  });
});

/** Langsearch/Youcom/Brightdata 占位：无公开余额接口，不触网。 */
describe('getLangsearchBalance/getYoucomBalance/getBrightdataBalance 占位', () => {
  it('三个占位余额回 null 不触网', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('占位不应触碰网络');
    };
    const langsearchOut = await getLangsearchBalance({ fetchImpl: neverStub });
    assert.equal(langsearchOut.provider, 'langsearch');
    assert.equal(langsearchOut.balance, null);
    assert.equal(langsearchOut.remaining, null);
    const youcomOut = await getYoucomBalance({ fetchImpl: neverStub });
    assert.equal(youcomOut.provider, 'youcom');
    assert.equal(youcomOut.balance, null);
    assert.equal(youcomOut.remaining, null);
    const brightdataOut = await getBrightdataBalance({ fetchImpl: neverStub });
    assert.equal(brightdataOut.provider, 'brightdata');
    assert.equal(brightdataOut.balance, null);
    assert.equal(brightdataOut.remaining, null);
  });
});

/** GNews 搜索映射：articles 归一为 title/url/content，缺键抛 CREDENTIAL_MISSING。 */
describe('gnewsSearch 映射与缺键', () => {
  it('两种字段形态都归一', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} GNews 搜索桩 */
    const gnewsStub = async (url) => {
      assert.match(String(url), /gnews\.local\/api\/v4\/search/);
      assert.match(String(url), /apikey=/);
      return stubResponse({
        articles: [
          { title: '新标题甲', url: 'https://case.local/1', description: '新正文甲' },
          { title: '新标题乙', link: 'https://case.local/2', content: '新正文乙' },
        ],
      });
    };
    const out = await gnewsSearch({ query: '单测' }, {
      gnewsApiKey: 'test-key',
      searchUrlGnews: 'https://gnews.local/api/v4/search',
      fetchImpl: gnewsStub,
    });
    assert.equal(out.provider, 'gnews');
    assert.equal(out.results.length, 2);
    assert.deepEqual(
      { title: out.results[0].title, url: out.results[0].url, content: out.results[0].content },
      { title: '新标题甲', url: 'https://case.local/1', content: '新正文甲' },
    );
    assert.deepEqual(
      { title: out.results[1].title, url: out.results[1].url, content: out.results[1].content },
      { title: '新标题乙', url: 'https://case.local/2', content: '新正文乙' },
    );
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      gnewsSearch({ query: '单测' }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** Jina 搜索映射：results/data 归一为 title/url/content，缺键抛 CREDENTIAL_MISSING。 */
describe('jinaSearch 映射与缺键', () => {
  it('两种字段形态都归一', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} Jina 搜索桩 */
    const jinaStub = async (url) => {
      assert.match(String(url), /jina-search\.local/);
      return stubResponse({
        results: [
          { title: '金标题甲', url: 'https://case.local/1', content: '金正文甲' },
          { title: '金标题乙', link: 'https://case.local/2', snippet: '金正文乙' },
        ],
      });
    };
    const out = await jinaSearch({ query: '单测' }, {
      jinaApiKey: 'test-key',
      searchUrlJina: 'https://jina-search.local/',
      fetchImpl: jinaStub,
    });
    assert.equal(out.provider, 'jina');
    assert.equal(out.results.length, 2);
    assert.deepEqual(
      { title: out.results[0].title, url: out.results[0].url, content: out.results[0].content },
      { title: '金标题甲', url: 'https://case.local/1', content: '金正文甲' },
    );
    assert.deepEqual(
      { title: out.results[1].title, url: out.results[1].url, content: out.results[1].content },
      { title: '金标题乙', url: 'https://case.local/2', content: '金正文乙' },
    );
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      jinaSearch({ query: '单测' }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** Browserless 抓取：无 zone 可发网且请求体不带 zone，批量结算互不干扰，缺键抛 CREDENTIAL_MISSING。 */
describe('browserlessFetch 无 zone 与缺键', () => {
  it('无 zone 可发网且请求体不带 zone', async () => {
    /** @type {any[]} 捕获到的上游请求体 */
    const seenBodies = [];
    /** @type {(url: string, init?: any) => Promise<any>} 单地址分流的桩 */
    const noZoneStub = async (url, init = {}) => {
      assert.match(String(url), /browserless\.local\/scrape/);
      assert.match(String(url), /token=/);
      seenBodies.push(JSON.parse(init.body || '{}'));
      if (String(init.body || '').includes(BAD_URL)) {
        return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => '' },
        text: async () => '# 好标题\n好正文',
      };
    };
    const out = await browserlessFetch({ urls: [GOOD_URL, BAD_URL] }, {
      browserlessApiKey: 'test-key',
      fetchUrlBrowserless: 'https://browserless.local/scrape',
      fetchImpl: noZoneStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '# 好标题\n好正文');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].url, BAD_URL);
    assert.equal(out.errors[0].retryable, false);
    const goodBody = seenBodies.find((/** @type {any} */ item) => item.url === GOOD_URL);
    assert.ok(goodBody);
    assert.equal('zone' in (goodBody ?? {}), false);
    assert.deepEqual(goodBody.elements, [{ selector: 'body' }]);
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      browserlessFetch({ urls: [GOOD_URL] }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** Jina 抓取批量结算：成功地址进 results，失败地址进 errors 且不可重试，缺键抛 CREDENTIAL_MISSING。 */
describe('jinaFetch 批量结算与缺键', () => {
  it('逐地址结算互不干扰', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 按地址分流的桩 */
    const batchStub = async (url, init = {}) => {
      assert.match(String(url), /jina\.local/);
      assert.equal(init.headers?.Authorization, 'Bearer test-key');
      if (String(url).includes(BAD_URL)) {
        return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => '' },
        text: async () => '# 好标题\n好正文',
      };
    };
    const out = await jinaFetch({ urls: [GOOD_URL, BAD_URL] }, {
      jinaApiKey: 'test-key',
      fetchUrlJina: 'https://jina.local/',
      fetchImpl: batchStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '# 好标题\n好正文');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].url, BAD_URL);
    assert.equal(out.errors[0].retryable, false);
  });

  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      jinaFetch({ urls: [GOOD_URL] }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** ScrapingAnt/Apify 抓取批量结算：成功地址进 results，失败地址进 errors，缺键抛 CREDENTIAL_MISSING。 */
describe('scrapingantFetch/apifyFetch 批量结算与缺键', () => {
  it('ScrapingAnt 默认不渲染且逐地址结算', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 按地址分流的桩 */
    const batchStub = async (url) => {
      assert.match(String(url), /scrapingant\.local\/v2\/general/);
      assert.match(String(url), /browser=false/);
      if (String(url).includes(encodeURIComponent(BAD_URL))) {
        return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
      }
      return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '好正文' };
    };
    const out = await scrapingantFetch({ urls: [GOOD_URL, BAD_URL] }, {
      scrapingantApiKey: 'test-key',
      fetchUrlScrapingant: 'https://scrapingant.local/v2/general',
      fetchImpl: batchStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '好正文');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].url, BAD_URL);
    assert.equal(out.errors[0].retryable, false);
  });

  it('ScrapingAnt 缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      scrapingantFetch({ urls: [GOOD_URL] }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });

  it('Apify 三段式逐地址结算互不干扰', async () => {
    /** @type {Map<string, string>} 运行标识到目标地址的映射 */
    const runToTarget = new Map();
    let seq = 0;
    /** @type {(url: string, init?: any) => Promise<any>} 三段式分流的桩 */
    const apifyStub = async (url, init = {}) => {
      const text = String(url);
      assert.match(text, /apify\.local\/v2/);
      const method = String(init.method || 'GET').toUpperCase();
      if (text.includes('/acts/') && method === 'POST') {
        const asked = JSON.parse(init.body || '{}').startUrls || [];
        const target = asked[0]?.url || GOOD_URL;
        seq += 1;
        const runId = 'run' + seq;
        runToTarget.set(runId, target);
        return stubResponse({ data: { id: runId, defaultDatasetId: 'ds-' + runId } });
      }
      if (text.includes('/actor-runs/')) {
        const runId = decodeURIComponent(text.split('/actor-runs/')[1].split('?')[0]);
        const target = runToTarget.get(runId);
        if (target === BAD_URL) {
          return stubResponse({ data: { status: 'FAILED', statusMessage: 'target_unreachable' } });
        }
        return stubResponse({ data: { status: 'SUCCEEDED', defaultDatasetId: 'ds-' + runId } });
      }
      if (text.includes('/datasets/')) {
        const dsPart = decodeURIComponent(text.split('/datasets/')[1].split('/')[0]);
        const target = runToTarget.get(dsPart.replace(/^ds-/, ''));
        return stubResponse([{ url: target, title: '好标题', markdown: '好正文' }]);
      }
      throw new Error('未知 apify 阶段：' + text);
    };
    const out = await apifyFetch({ urls: [GOOD_URL, BAD_URL] }, {
      apifyApiKey: 'test-key',
      fetchUrlApify: 'https://apify.local/v2',
      fetchImpl: apifyStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '好正文');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].url, BAD_URL);
    assert.equal(out.errors[0].retryable, true);
  });

  it('Apify 缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      apifyFetch({ urls: [GOOD_URL] }, { fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** Browserless/Jina/ScrapingAnt/Apify/GNews 占位：无公开余额接口，不触网。 */
describe('getBrowserlessBalance/getJinaBalance/getScrapingantBalance/getApifyBalance/getGnewsBalance 占位', () => {
  it('五个占位余额回 null 不触网', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('占位不应触碰网络');
    };
    const browserlessOut = await getBrowserlessBalance({ fetchImpl: neverStub });
    assert.equal(browserlessOut.provider, 'browserless');
    assert.equal(browserlessOut.balance, null);
    assert.equal(browserlessOut.remaining, null);
    const jinaOut = await getJinaBalance({ fetchImpl: neverStub });
    assert.equal(jinaOut.provider, 'jina');
    assert.equal(jinaOut.balance, null);
    assert.equal(jinaOut.remaining, null);
    const scrapingantOut = await getScrapingantBalance({ fetchImpl: neverStub });
    assert.equal(scrapingantOut.provider, 'scrapingant');
    assert.equal(scrapingantOut.balance, null);
    assert.equal(scrapingantOut.remaining, null);
    const apifyOut = await getApifyBalance({ fetchImpl: neverStub });
    assert.equal(apifyOut.provider, 'apify');
    assert.equal(apifyOut.balance, null);
    assert.equal(apifyOut.remaining, null);
    const gnewsOut = await getGnewsBalance({ fetchImpl: neverStub });
    assert.equal(gnewsOut.provider, 'gnews');
    assert.equal(gnewsOut.balance, null);
    assert.equal(gnewsOut.remaining, null);
  });
});

/** 回退链：主供应商可重试失败后，回退补抓成功并置 fallbackUsed。 */
describe('dispatchTool 回退链', () => {
  it('主失败走回退且标记 fallbackUsed', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 主次分流的桩 */
    const fallbackStub = async (url, init = {}) => {
      const text = String(url);
      if (text === TINYFISH_FETCH_URL) {
        const asked = JSON.parse(init.body || '{}').urls;
        return stubResponse({
          results: [],
          errors: asked.map((/** @type {any} */ item) => ({ url: item, error: 'timeout' })),
        });
      }
      assert.match(text, /api\.tavily\.com\/extract/);
      const asked = JSON.parse(init.body || '{}').urls || [];
      return stubResponse({
        results: asked.map((/** @type {any} */ target) => ({ url: target, title: '回退标题', raw_content: '回退正文' })),
        failed_results: [],
      });
    };
    const out = await dispatchTool('so_fetch', { urls: [GOOD_URL] }, /** @type {any} */ ({
      fetchPrimary: 'tinyfish',
      fetchFallback: 'tavily',
      tinyfishApiKey: 'test-key',
      tavilyApiKey: 'test-key',
      fetchImpl: fallbackStub,
    }));
    assert.equal(out.fallbackUsed, true);
    assert.deepEqual(out.providers, ['tinyfish', 'tavily']);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.errors.length, 0);
  });

  it('并行分片上限 12 级且不可重试不重打', async () => {
    /** @type {string[]} */
    const seen = [];
    /** @type {(url: string, init?: any) => Promise<any>} 按分片回包的桩 */
    const chainStub = async (url, init = {}) => {
      seen.push(String(url));
      const asked = JSON.parse(init.body || '{}').urls || [];
      return stubResponse({
        results: asked.filter((/** @type {any} */ item) => item === GOOD_URL).map((/** @type {any} */ item) => ({ url: item, title: '分片成功', text: '正文' })),
        failed_results: asked.filter((/** @type {any} */ item) => item === BAD_URL).map((/** @type {any} */ item) => ({ url: item, error: '目标页不存在' })),
      });
    };
    const out = await dispatchTool(
      'so_fetch',
      { urls: [GOOD_URL, BAD_URL], chain: ['tinyfish', 'tavily'] },
      /** @type {any} */ ({ tinyfishApiKey: 'test-key', tavilyApiKey: 'test-key', fetchImpl: chainStub }),
    );
    // 两地址轮转分片到两家并行，不可重试失败直接保留，不触发第二轮。
    assert.deepEqual([...out.providers].sort(), ['tavily', 'tinyfish']);
    assert.equal(out.fallbackUsed, true);
    assert.equal(out.results.length, 1);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].retryable, false);
  });
  it('16 级 chain 不截断全部分片开打', async () => {
    /** @type {string[]} 上游实际命中的请求地址 */
    const seenSixteen = [];
    /** @type {(url: string, init?: any) => Promise<any>} 全形态兼容的通用桩 */
    const sixteenStub = async (url) => {
      seenSixteen.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => '' },
        json: async () => ({ results: [], errors: [], failed_results: [], statuses: [] }),
        text: async () => '',
      };
    };
    const chain = ['tinyfish', 'tavily', 'exa', 'browserless', 'jina', 'scrapingant', 'scrapedo', 'scraperapi', 'firecrawl', 'hasdata', 'tinyfish', 'tavily', 'exa', 'browserless', 'jina', 'scrapingant'];
    const urls = ['tinyfish', 'tavily', 'exa', 'browserless', 'jina', 'scrapingant', 'scrapedo', 'scraperapi', 'firecrawl', 'hasdata'].map((name) => 'https://case.local/' + name);
    const out = await dispatchTool(
      'so_fetch',
      { urls, chain },
      /** @type {any} */ ({
        tinyfishApiKey: 'test-key',
        tavilyApiKey: 'test-key',
        exaApiKey: 'test-key',
        browserlessApiKey: 'test-key',
        jinaApiKey: 'test-key',
        scrapingantApiKey: 'test-key',
        scrapedoApiKey: 'test-key',
        scraperapiApiKey: 'test-key',
        firecrawlApiKey: 'test-key',
        hasdataApiKey: 'test-key',
        fetchImpl: sixteenStub,
      }),
    );
    // 16 级去重后十家并行：十地址轮转分片，每家至少被实际调用一次，不断言截断。
    assert.equal(out.providers.length, 10);
    for (const marker of ['api.fetch.tinyfish.ai', 'api.tavily.com/extract', 'api.exa.ai', 'browserless.io', 'localhost:3000', 'scrapingant.com', 'api.scrape.do', 'api.scraperapi.com', 'api.firecrawl.dev', 'api.hasdata.com']) {
      assert.ok(seenSixteen.some((hit) => hit.includes(marker)), '16 级 chain 未打到：' + marker);
    }
  });
});

/** 搜索扇出：多源并行按 URL 去重，失败不阻断，来源可追溯。 */
describe('dispatchTool 搜索扇出', () => {
  it('双源合并去重且保留首见 provider', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 按供应商分流的桩 */
    const fanoutStub = async (url) => {
      const text = String(url);
      if (text.includes('tinyfish')) {
        return stubResponse({
          results: [{ title: '免费标题', url: 'https://case.local/dup', snippet: '免费正文' }],
        });
      }
      return stubResponse({
        results: [
          { title: '精排标题', url: 'https://case.local/only', content: '精排正文' },
          { title: '重复标题', url: 'https://case.local/dup', content: '重复正文' },
        ],
      });
    };
    const out = await dispatchTool('so_search', { query: '扇出', providers: ['tinyfish', 'tavily'] }, /** @type {any} */ ({
      tinyfishApiKey: 'test-key',
      tavilyApiKey: 'test-key',
      searchUrlTinyfish: 'https://tinyfish.local/search',
      searchUrlTavily: 'https://tavily.local/search',
      fetchImpl: fanoutStub,
    }));
    assert.equal(out.provider, 'fanout');
    assert.deepEqual(out.providers, ['tinyfish', 'tavily']);
    assert.equal(out.results.length, 2);
    assert.equal(out.results.find((/** @type {any} */ item) => item.url === 'https://case.local/dup')?.provider, 'tinyfish');
  });
});

/** 余额端点鉴权：独立 /credits 端点无令牌、错令牌与旧出示方式均回 401 未授权。 */
describe('handleCredits 余额端点鉴权', () => {
  it('无代理密钥回缺密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request('https://case.local/credits');
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, TAVILY_API_KEY: 'test-tavily-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'missing_api_key');
  });

  it('错持有者令牌回无效密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer wrong-key' },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, TAVILY_API_KEY: 'test-tavily-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'invalid_api_key');
  });

  it('旧自定义头带正确值仍回缺密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request('https://case.local/credits', {
      headers: { 'x-api-key': PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, TAVILY_API_KEY: 'test-tavily-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'missing_api_key');
  });

  it('旧查询参数带正确值仍回缺密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request(`https://case.local/credits?apiKey=${PROXY_KEY}`);
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, TAVILY_API_KEY: 'test-tavily-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'missing_api_key');
  });
});

/** 动态钱包：余额 data 按接入名单动态组装，有几家回几家，空名单回 500 代理未配置。 */
describe('handleCredits 动态钱包', () => {
  it('单 tinyfish 只回 tinyfish 键', async () => {
    /** @type {(url: string) => Promise<any>} 只服务 Tinyfish 钱包地址的桩 */
    const tinyfishOnlyStub = async (url) => {
      assert.match(String(url), /agent\.tinyfish\.ai\/v1\/wallet/);
      return stubResponse({ available_balance: '21.44', currency: 'USD' });
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer ' + PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: tinyfishOnlyStub },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body?.data?.tinyfish?.provider, 'tinyfish');
    assert.equal('tavily' in (body?.data ?? {}), false);
  });

  it('双家动态键按新形状回剩余额度', async () => {
    /** @type {(url: string) => Promise<any>} 按地址路由的桩 */
    const dualStub = async (url) => {
      const text = String(url);
      if (text.includes('agent.tinyfish.ai/v1/wallet')) {
        return stubResponse({ available_balance: '21.44', currency: 'USD' });
      }
      assert.match(text, /api\.tavily\.com\/usage/);
      return stubResponse({
        key: { usage: 150, limit: 1000 },
        account: { plan_usage: 500, plan_limit: 15000, current_plan: 'Bootstrap' },
      });
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer ' + PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, TINYFISH_API_KEY: 'test-tinyfish-key', TAVILY_API_KEY: 'test-tavily-key' }, fetchImpl: dualStub },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body?.data?.tinyfish?.provider, 'tinyfish');
    assert.equal(body?.data?.tinyfish?.remaining, 21.44);
    assert.equal(body?.data?.tavily?.provider, 'tavily');
    assert.equal(body?.data?.tavily?.remaining, 14500);
    assert.equal(body?.data?.tavily?.limit, 15000);
  });


  it('空名单回 500 代理未配置', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('空名单时不应触碰上游');
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer ' + PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'proxy_misconfigured');
  });
});
