/**
 * 供应商注册表：搜索与抓取引擎的可扩展装配点。
 *
 * 约定：新增引擎只需在本文件注册表加一行（名 -> 实现函数），
 * 调用方经由 getSearchProvider/getFetchProvider 按名获取，无需改动上层。
 */

import { tinyfishSearch } from './search-tinyfish.js';
import { tavilySearch } from './search-tavily.js';
import { exaSearch } from './search-exa.js';
import { queritSearch } from './search-querit.js';
import { langsearchSearch } from './search-langsearch.js';
import { youcomSearch } from './search-youcom.js';
import { hasdataSearch } from './search-hasdata.js';
import { gnewsSearch } from './search-gnews.js';
import { jinaSearch } from './search-jina.js';
import { firecrawlSearch } from './search-firecrawl.js';
import { tinyfishFetch } from './fetch-tinyfish.js';
import { tavilyFetch } from './fetch-tavily.js';
import { exaFetch } from './fetch-exa.js';
import { youcomFetch } from './fetch-youcom.js';
import { scrapedoFetch } from './fetch-scrapedo.js';
import { hasdataFetch } from './fetch-hasdata.js';
import { scraperapiFetch } from './fetch-scraperapi.js';
import { firecrawlFetch } from './fetch-firecrawl.js';
import { brightdataFetch } from './fetch-brightdata.js';
import { browserlessFetch } from './fetch-browserless.js';
import { jinaFetch } from './fetch-jina.js';
import { scrapingantFetch } from './fetch-scrapingant.js';
import { apifyFetch } from './fetch-apify.js';
import {
  getTinyfishWallet,
  getTavilyBalance,
  getExaBalance,
  getQueritBalance,
  getLangsearchBalance,
  getYoucomBalance,
  getHasdataBalance,
  getFirecrawlBalance,
  getScrapedoBalance,
  getScraperapiBalance,
  getBrightdataBalance,
  getBrowserlessBalance,
  getJinaBalance,
  getScrapingantBalance,
  getApifyBalance,
  getGnewsBalance,
} from '../credits.js';

/**
 * 搜索供应商注册表。
 * @type {Record<string, Function>}
 */
export const SEARCH_REGISTRY = {
  tinyfish: tinyfishSearch,
  tavily: tavilySearch,
  exa: exaSearch,
  querit: queritSearch,
  langsearch: langsearchSearch,
  youcom: youcomSearch,
  hasdata: hasdataSearch,
  firecrawl: firecrawlSearch,
  gnews: gnewsSearch,
  jina: jinaSearch,
};

/**
 * 抓取供应商注册表。
 * @type {Record<string, Function>}
 */
export const FETCH_REGISTRY = {
  tinyfish: tinyfishFetch,
  tavily: tavilyFetch,
  exa: exaFetch,
  youcom: youcomFetch,
  scrapedo: scrapedoFetch,
  hasdata: hasdataFetch,
  scraperapi: scraperapiFetch,
  firecrawl: firecrawlFetch,
  brightdata: brightdataFetch,
  browserless: browserlessFetch,
  jina: jinaFetch,
  scrapingant: scrapingantFetch,
  apify: apifyFetch,
};

/**
 * 余额供应商注册表。
 * 新增钱包只需在此注册一行（名 -> 余额函数），余额端点按名单动态扇出，无需改动上层。
 * 无官方余额口径的供应商返回 {provider, balance: null, note} 占位，不抛错阻塞扇出。
 * @type {Record<string, Function>}
 */
export const CREDITS_REGISTRY = {
  tinyfish: getTinyfishWallet,
  tavily: getTavilyBalance,
  exa: getExaBalance,
  querit: getQueritBalance,
  hasdata: getHasdataBalance,
  firecrawl: getFirecrawlBalance,
  scrapedo: getScrapedoBalance,
  scraperapi: getScraperapiBalance,
  langsearch: getLangsearchBalance,
  youcom: getYoucomBalance,
  brightdata: getBrightdataBalance,
  browserless: getBrowserlessBalance,
  jina: getJinaBalance,
  scrapingant: getScrapingantBalance,
  apify: getApifyBalance,
  gnews: getGnewsBalance,
};

/**
 * 构造未知供应商错误。
 * @param {string} kind 类别（search/fetch）
 * @param {string} name 供应商名
 * @returns {Error & {code: string}} 结构化错误
 */
function unknownProvider(kind, name) {
  const err = /** @type {Error & {code: string}} */ (
    new Error('未知' + kind + '供应商：' + name)
  );
  err.code = 'UNKNOWN_PROVIDER';
  return err;
}

/**
 * 按名获取搜索供应商实现。
 * @param {string} name 供应商名（如 tinyfish）
 * @returns {Function} 搜索函数 (params, deps) => Promise<UnifiedSearch>
 */
export function getSearchProvider(name) {
  const fn = SEARCH_REGISTRY[name];
  if (!fn) throw unknownProvider('搜索', String(name));
  return fn;
}

/**
 * 按名获取抓取供应商实现。
 * @param {string} name 供应商名（如 tinyfish、tavily）
 * @returns {Function} 抓取函数 (params, deps) => Promise<{results, errors}>
 */
export function getFetchProvider(name) {
  const fn = FETCH_REGISTRY[name];
  if (!fn) throw unknownProvider('抓取', String(name));
  return fn;
}
/**
 * 按名获取余额供应商实现。
 * 新增钱包只需在余额注册表加一行，调用方无需改动。
 * @param {string} name 供应商名（如 tinyfish、tavily）
 * @returns {Function} 余额函数 (deps) => Promise<余额状态>
 */
export function getCreditsProvider(name) {
  const fn = CREDITS_REGISTRY[name];
  if (!fn) throw unknownProvider('余额', String(name));
  return fn;
}

/**
 * 列出已注册的余额供应商名。
 * @returns {string[]} 余额供应商名列表
 */
export function listCreditsProviders() {
  return Object.keys(CREDITS_REGISTRY);
}

/**
 * 列出已注册的供应商名。
 * @returns {{search: string[], fetch: string[]}} 搜索与抓取的供应商名列表
 */
export function listProviders() {
  return {
    search: Object.keys(SEARCH_REGISTRY),
    fetch: Object.keys(FETCH_REGISTRY),
  };
}
