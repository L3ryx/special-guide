/**
 * etsyScraper.js
 * Scrape les pages de résultats Etsy via Playwright + stealth.
 *
 * Fonctionnalités :
 *  - Playwright chromium avec playwright-extra + puppeteer-extra-plugin-stealth
 *  - Délais aléatoires entre chaque requête (comportement humain)
 *  - Ouvertures/fermetures de pages leurres pendant la navigation
 *  - Stockage et réutilisation des cookies entre sessions (fichier JSON)
 *  - Réutilisation de la session navigateur (browser + context singleton)
 *  - Fallback fetch si Playwright indisponible
 *
 * Dépendances : cheerio, playwright, playwright-extra, puppeteer-extra-plugin-stealth
 */

'use strict';

const cheerio  = require('cheerio');
const fs       = require('fs');
const path     = require('path');

// ── Chemins persistance ────────────────────────────────────────────────────────

const COOKIES_PATH  = path.join(__dirname, '../../.etsy_cookies.json');
const STORAGE_PATH  = path.join(__dirname, '../../.etsy_storage.json');

// ── Pool user-agents ──────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

// Pages leurres credibles a ouvrir brievement pendant la navigation
const DECOY_URLS = [
  'https://www.etsy.com/trending',
  'https://www.etsy.com/featured',
  'https://www.etsy.com/c/jewelry',
  'https://www.etsy.com/c/home-and-living',
  'https://www.etsy.com/c/art-and-collectibles',
  'https://www.etsy.com/c/clothing',
  'https://www.etsy.com/c/toys-and-games',
];

// ── Utilitaires ────────────────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function humanDelay(minMs, maxMs) {
  if (minMs === undefined) minMs = 1500;
  if (maxMs === undefined) maxMs = 4000;
  const base   = randomInt(minMs, maxMs);
  const jitter = randomInt(-300, 300);
  return sleep(Math.max(500, base + jitter));
}

// ── Stats ──────────────────────────────────────────────────────────────────────

const _stats = {
  pagesScraped: 0,
  itemsFound:   0,
  errors:       0,
  blocked:      0,
};

// ── Rate limiters ──────────────────────────────────────────────────────────────

class RateLimiter {
  constructor() { this.lastCallAt = 0; }
  async wait(minMs, maxMs) {
    if (minMs === undefined) minMs = 800;
    if (maxMs === undefined) maxMs = 2000;
    const delay   = randomInt(minMs, maxMs);
    const elapsed = Date.now() - this.lastCallAt;
    const waiting = Math.max(0, delay - elapsed);
    if (waiting > 0) await sleep(waiting);
    this.lastCallAt = Date.now();
  }
}

const _rateLimiter     = new RateLimiter();
const _shopRateLimiter = new RateLimiter();

// ── Session Playwright (singleton) ────────────────────────────────────────────

let _browser  = null;
let _context  = null;
let _pwReady  = false;
let _pwFailed = false;

async function initPlaywright() {
  if (_pwReady || _pwFailed) return;
  try {
    const { chromium } = require('playwright-extra');
    const stealth       = require('puppeteer-extra-plugin-stealth');
    chromium.use(stealth());

    let storageState = undefined;
    if (fs.existsSync(STORAGE_PATH)) {
      try {
        storageState = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
        console.log('[etsyScraper] Session Playwright restauree depuis disque');
      } catch (_) {}
    }

    _browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1366,768',
      ],
    });

    const ctxOptions = {
      userAgent:  pick(USER_AGENTS),
      locale:     'en-US',
      timezoneId: 'America/New_York',
      viewport:   { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'DNT': '1',
      },
    };

    if (storageState) ctxOptions.storageState = storageState;
    _context = await _browser.newContext(ctxOptions);

    if (!storageState && fs.existsSync(COOKIES_PATH)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        if (Array.isArray(cookies) && cookies.length > 0) {
          await _context.addCookies(cookies);
          console.log('[etsyScraper] ' + cookies.length + ' cookies Etsy restaures');
        }
      } catch (_) {}
    }

    // Bloquer ressources lourdes inutiles
    await _context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    _pwReady = true;
    console.log('[etsyScraper] Playwright stealth initialise');
  } catch (e) {
    _pwFailed = true;
    console.warn('[etsyScraper] Playwright indisponible, fallback fetch: ' + e.message);
  }
}

async function persistSession() {
  if (!_context) return;
  try {
    const cookies = await _context.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    const storage = await _context.storageState();
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(storage, null, 2));
    console.log('[etsyScraper] Session persistee (' + cookies.length + ' cookies)');
  } catch (e) {
    console.warn('[etsyScraper] Echec persistance session: ' + e.message);
  }
}

async function closeBrowser() {
  if (!_browser) return;
  try {
    await persistSession();
    await _browser.close();
  } catch (_) {}
  _browser = null;
  _context = null;
  _pwReady = false;
}

// ── Comportement humain : scroll + mouse ──────────────────────────────────────

async function humanBehavior(page) {
  try {
    const scrollSteps = randomInt(2, 5);
    for (let i = 0; i < scrollSteps; i++) {
      await page.mouse.wheel(0, randomInt(200, 600));
      await sleep(randomInt(200, 600));
    }
    await page.mouse.move(randomInt(100, 1000), randomInt(100, 600));
    await sleep(randomInt(100, 400));
  } catch (_) {}
}

// ── Decoy : ouvre/ferme une page leurre en arriere-plan ──────────────────────

async function spawnDecoyPage() {
  if (!_context) return;
  if (Math.random() > 0.40) return;
  const url = pick(DECOY_URLS);
  let decoyPage;
  try {
    decoyPage = await _context.newPage();
    console.log('[etsyScraper] Page leurre ouverte: ' + url);
    await decoyPage.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
    await sleep(randomInt(1500, 4000));
    await humanBehavior(decoyPage);
  } catch (_) {
    // silencieux
  } finally {
    if (decoyPage && !decoyPage.isClosed()) {
      await decoyPage.close().catch(() => {});
      console.log('[etsyScraper] Page leurre fermee');
    }
  }
}

// ── Fetch Playwright ──────────────────────────────────────────────────────────

async function fetchWithPlaywright(url) {
  const page = await _context.newPage();
  try {
    const referer = url.includes('/shop/') ? 'https://www.etsy.com/search' : 'https://www.etsy.com/';
    await page.setExtraHTTPHeaders({ 'Referer': referer });
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await humanBehavior(page);
    const html = await page.content();
    if (/captcha|i am not a robot|unusual traffic/i.test(html)) {
      _stats.blocked++;
      throw new Error('Etsy captcha detecte');
    }
    persistSession().catch(() => {});
    return html;
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

// ── Helpers HTML ──────────────────────────────────────────────────────────────

function makeAbsoluteURL(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  return 'https://www.etsy.com' + (url.startsWith('/') ? url : '/' + url);
}

function cleanImage(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  return url.split('?')[0].replace(/\/il_(fullxfull|\d+x\d+|[^/.]+)\.(jpg|jpeg|png|webp)/i, '/il_570xN.$2') || null;
}

function cleanText(text) {
  return String(text || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
}

function extractListingId(url) {
  const m = url && url.match(/\/listing\/(\d+)/);
  return m ? m[1] : null;
}

function extractShopName(url) {
  const m = url && url.match(/etsy\.com\/shop\/([^/?#&]+)/);
  return m ? m[1] : null;
}

function isLikelyDigitalProduct(title) {
  return /\b(digital|download|printable|svg|template|pdf|excel|spreadsheet|tracker|planner|pattern|cricut|sublimation|clipart|png|jpg|canva|stl|editable|certificate|plans?|cnc)\b/i.test(title);
}

function buildHeaders(referer) {
  return {
    'User-Agent': pick(USER_AGENTS),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Referer': referer || 'https://www.etsy.com/',
    'DNT': '1',
    'Upgrade-Insecure-Requests': '1',
  };
}

// ── Fetch principal (Playwright -> fallback fetch) ────────────────────────────

async function fetchPage(url, retries) {
  if (retries === undefined) retries = 2;
  if (!_pwReady && !_pwFailed) await initPlaywright();

  if (_pwReady && _context) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await humanDelay(1200, 3500);
        spawnDecoyPage().catch(() => {});
        return await fetchWithPlaywright(url);
      } catch (e) {
        _stats.errors++;
        console.warn('[etsyScraper] Playwright attempt ' + (attempt + 1) + ' echoue: ' + e.message);
        if (e.message.includes('captcha')) throw e;
        if (attempt < retries) await humanDelay(3000, 6000);
      }
    }
    console.warn('[etsyScraper] Playwright epuise, tentative fetch direct');
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await humanDelay(1500, 4000);
      const referer = url.includes('/shop/') ? 'https://www.etsy.com/search' : 'https://www.etsy.com/';
      const response = await fetch(url, { headers: buildHeaders(referer) });
      if (response.status === 429 || response.status === 503) {
        _stats.blocked++;
        const wait = 4000 * (attempt + 1);
        console.warn('[etsyScraper] HTTP ' + response.status + ' -- attente ' + wait + 'ms');
        await sleep(wait);
        continue;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const html = await response.text();
      if (/captcha|i am not a robot|unusual traffic/i.test(html)) {
        _stats.blocked++;
        throw new Error('Etsy captcha detecte');
      }
      return html;
    } catch (e) {
      lastError = e;
      if (attempt < retries) await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

// ── Parser : page de resultats Etsy ──────────────────────────────────────────

function parseEtsySearchPage(html) {
  const $       = cheerio.load(html);
  const results = [];
  const seenIds = new Set();

  $("script[type='application/ld+json']").each(function(_, el) {
    try {
      const data  = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;
        const link = (item.url || '').split('?')[0];
        const id   = extractListingId(link);
        if (!id || seenIds.has(id)) continue;
        const title = cleanText(item.name || '');
        if (isLikelyDigitalProduct(title)) continue;
        const rawImg = item.image;
        const image  = cleanImage(
          typeof rawImg === 'string' ? rawImg
          : (Array.isArray(rawImg) && rawImg.length ? (rawImg[0] && rawImg[0].contentURL ? rawImg[0].contentURL : rawImg[0]) : null)
        );
        if (!image) continue;
        const brand    = item.brand || {};
        const shopName = typeof brand === 'object' ? (brand.name || null) : String(brand || '');
        seenIds.add(id);
        results.push({ listingId: id, title, link, image, shopName: shopName || null, shopUrl: shopName ? 'https://www.etsy.com/shop/' + shopName : null, source: 'etsy-search' });
      }
    } catch (_) {}
  });

  if (results.length < 5) {
    const cardSelectors = ['div.v2-listing-card[data-listing-id]', 'div[data-listing-id]', 'li[data-palette-listing-id]', 'article.listing-card'].join(', ');
    $(cardSelectors).each(function(_, card) {
      const $card     = $(card);
      const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id') || null;
      if (!listingId || seenIds.has(listingId)) return;
      const linkEl  = $card.find('a[href*="/listing/"]').first();
      const rawHref = linkEl.attr('href') || '';
      const link    = rawHref ? makeAbsoluteURL(rawHref).split('?')[0] : '';
      if (!link) return;
      const title = cleanText($card.find('.v2-listing-card__title, h3, h2').first().text());
      if (isLikelyDigitalProduct(title)) return;
      const imgEl = $card.find('img[data-src], img[src]').first();
      const image = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
      if (!image || image.indexOf('placeholder') !== -1 || image.indexOf('data:') !== -1) return;
      let shopName = null;
      const shopHref = $card.find('a[href*="/shop/"]').first().attr('href') || '';
      if (shopHref) shopName = extractShopName(makeAbsoluteURL(shopHref));
      seenIds.add(listingId);
      results.push({ listingId, title, link, image, shopName: shopName || null, shopUrl: shopName ? 'https://www.etsy.com/shop/' + shopName : null, source: 'etsy-search-html' });
    });
  }

  return results;
}

// ── Parser : page boutique -> 2eme image ─────────────────────────────────────

async function getSecondShopImage(shopUrl, excludeListingId) {
  if (!shopUrl) return null;
  try {
    await _shopRateLimiter.wait(800, 2000);
    const html = await fetchPage(shopUrl);
    const $    = cheerio.load(html);
    let image2 = null;

    $("script[type='application/ld+json']").each(function(_, el) {
      if (image2) return false;
      try {
        const data  = JSON.parse($(el).text());
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item['@type'] !== 'Product') continue;
          const link = (item.url || '').split('?')[0];
          const id   = extractListingId(link);
          if (!id || id === String(excludeListingId)) continue;
          const rawImg = item.image;
          const img    = cleanImage(typeof rawImg === 'string' ? rawImg : (Array.isArray(rawImg) && rawImg.length ? (rawImg[0] && rawImg[0].contentURL ? rawImg[0].contentURL : rawImg[0]) : null));
          if (img) { image2 = img; break; }
        }
      } catch (_) {}
    });

    if (!image2) {
      const cardSelectors = ['div.v2-listing-card[data-listing-id]', 'div[data-listing-id]', 'li[data-palette-listing-id]'].join(', ');
      $(cardSelectors).each(function(_, card) {
        if (image2) return false;
        const $card     = $(card);
        const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id');
        if (!listingId || listingId === String(excludeListingId)) return;
        const imgEl = $card.find('img[data-src], img[src]').first();
        const img   = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
        if (img && img.indexOf('placeholder') === -1 && img.indexOf('data:') === -1) { image2 = img; }
      });
    }

    console.log(image2 ? '[etsyScraper] 2eme image boutique OK: ' + shopUrl.slice(0, 60) : '[etsyScraper] Pas de 2eme image pour: ' + shopUrl.slice(0, 60));
    return image2;
  } catch (e) {
    console.warn('[etsyScraper] getSecondShopImage failed (' + shopUrl + '): ' + e.message);
    return null;
  }
}

// ── API principale : scrape toutes les pages ──────────────────────────────────

async function searchEtsyPages(keyword, maxPages, onPage, isAborted) {
  if (maxPages === undefined) maxPages = 7;
  if (!onPage) onPage = null;
  if (!isAborted) isAborted = function() { return false; };

  if (!_pwReady && !_pwFailed) await initPlaywright();

  const BASE           = 'https://www.etsy.com/search';
  const allListings    = [];
  const seenListingIds = new Set();
  const seenShopNames  = new Set();

  for (let page = 1; page <= maxPages; page++) {
    if (isAborted()) break;
    if (page > 1) await humanDelay(2000, 5000);

    const url = BASE + '?q=' + encodeURIComponent(keyword) + '&page=' + page + '&explicit=1';
    console.log('[etsyScraper] Scrape Etsy page ' + page + '/' + maxPages + ': ' + url);

    let html;
    try {
      html = await fetchPage(url);
      _stats.pagesScraped++;
    } catch (e) {
      _stats.errors++;
      console.error('[etsyScraper] page ' + page + ' echouee: ' + e.message);
      if (e.message.indexOf('captcha') !== -1) break;
      continue;
    }

    const pageResults = parseEtsySearchPage(html);
    console.log('[etsyScraper] page ' + page + ' -> ' + pageResults.length + ' listings parses');

    let newThisPage = 0;
    for (const listing of pageResults) {
      if (seenListingIds.has(listing.listingId)) continue;
      seenListingIds.add(listing.listingId);
      const shopKey = listing.shopName || listing.listingId;
      if (seenShopNames.has(shopKey)) continue;
      seenShopNames.add(shopKey);
      allListings.push(listing);
      newThisPage++;
    }

    _stats.itemsFound += newThisPage;
    console.log('[etsyScraper] +' + newThisPage + ' nouvelles boutiques | total: ' + allListings.length);
    if (onPage) onPage(page, allListings.length);
    if (pageResults.length === 0) { console.log('[etsyScraper] Page vide -- arret de la pagination'); break; }
  }

  await persistSession().catch(() => {});
  console.log('[etsyScraper] searchEtsyPages termine: ' + allListings.length + ' boutiques uniques');
  return allListings;
}

// ── Compat scrape.js ──────────────────────────────────────────────────────────

async function searchListingIds(keyword, limit, offset) {
  if (limit === undefined) limit = 48;
  if (offset === undefined) offset = 0;
  const page = Math.floor(offset / limit) + 1;
  await _rateLimiter.wait(1000, 2500);
  const url = 'https://www.etsy.com/search?q=' + encodeURIComponent(keyword) + '&page=' + page + '&explicit=1';
  let html;
  try {
    html = await fetchPage(url);
    _stats.pagesScraped++;
  } catch (e) {
    _stats.errors++;
    console.error('[etsyScraper] searchListingIds page ' + page + ' echouee: ' + e.message);
    return [];
  }
  const results = parseEtsySearchPage(html);
  _stats.itemsFound += results.length;
  console.log('[etsyScraper] searchListingIds page ' + page + ': ' + results.length + ' listings | keyword="' + keyword + '"');
  return results.slice(0, limit).map(function(r) { return Object.assign({}, r, { hasRealShopName: !!r.shopName, shopId: null }); });
}

async function searchListings(keyword, limit, offset) { return searchListingIds(keyword, limit, offset); }

async function getShopListings(shopIdOrName, limit) {
  if (limit === undefined) limit = 5;
  const shopUrl = 'https://www.etsy.com/shop/' + shopIdOrName;
  try {
    await _shopRateLimiter.wait(800, 2000);
    const html = await fetchPage(shopUrl);
    const $    = cheerio.load(html);
    const results = [];
    const seen    = new Set();
    $('div.v2-listing-card[data-listing-id], div[data-listing-id], li[data-palette-listing-id]').each(function(_, card) {
      if (results.length >= limit) return false;
      const $card     = $(card);
      const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id');
      if (!listingId || seen.has(listingId)) return;
      seen.add(listingId);
      const imgEl = $card.find('img[data-src], img[src]').first();
      const image = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
      const linkEl = $card.find('a[href*="/listing/"]').first();
      const link   = makeAbsoluteURL(linkEl.attr('href') || '').split('?')[0];
      results.push({ listingId, link, image, shopName: String(shopIdOrName), shopUrl, source: 'etsy-shop' });
    });
    return results;
  } catch (e) {
    console.warn('[etsyScraper] getShopListings failed for ' + shopIdOrName + ': ' + e.message);
    return [];
  }
}

async function getShopNameAndImage(shopId, listingId, listingId2) { return { shopName: null, shopUrl: null, image: null, image2: null }; }
async function getShopInfo(shopIdOrName) { return { shopId: null, shopName: String(shopIdOrName), title: String(shopIdOrName), shopUrl: 'https://www.etsy.com/shop/' + shopIdOrName, shopAvatar: null, numSales: 0, admirers: 0 }; }
async function getListingDetail(listingId) { return { title: null, price: null, images: [], shopName: null, shopId: null, totalSales: null, admirers: null }; }
async function getShopMetrics(shopIdOrName) { return { shopName: String(shopIdOrName), shopUrl: 'https://www.etsy.com/shop/' + shopIdOrName, numSales: 0, admirers: 0 }; }

async function scrapeProducts(opts) {
  if (!opts) opts = {};
  const keyword = (function() { try { return new URL(opts.baseUrl || '').searchParams.get('q') || 'etsy product'; } catch (_) { return 'etsy product'; } })();
  return searchEtsyPages(keyword, opts.maxPages || 7, opts.onPage);
}

function getStats() { return Object.assign({}, _stats); }
function handleEtsyError(e) { if (e && e.message) { console.error('[etsyScraper] Erreur:', e.message); throw e; } throw new Error('Erreur scraper Etsy inconnue'); }
async function isScraperAvailable() { return true; }

process.on('SIGTERM', () => closeBrowser().catch(() => {}));
process.on('SIGINT',  () => closeBrowser().catch(() => {}));

module.exports = {
  searchEtsyPages,
  getSecondShopImage,
  searchListings,
  searchListingIds,
  getShopNameAndImage,
  getShopListings,
  getShopInfo,
  getListingDetail,
  scrapeProducts,
  getShopMetrics,
  getStats,
  handleEtsyError,
  isScraperAvailable,
  closeBrowser,
};
