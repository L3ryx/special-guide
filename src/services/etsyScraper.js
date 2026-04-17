/**
 * etsyScraper.js
 * Scraper Etsy — Puppeteer Stealth (vrai Chrome headless, anti-DataDome).
 *
 * Approche tirée de etsy-scraper-main : puppeteer-extra + plugin stealth pour
 * imiter un vrai navigateur Chrome et contourner la détection bot d'Etsy.
 * Toute la logique de parsing (cheerio) est conservée intacte.
 *
 * Dépendances : puppeteer-extra, puppeteer-extra-plugin-stealth, cheerio
 */

const cheerio = require('cheerio');

let puppeteer;
let StealthPlugin;
try {
  puppeteer    = require('puppeteer-extra');
  StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
} catch (_) {
  puppeteer    = null;
  StealthPlugin = null;
}

// ── Pool user-agents / viewports (issus de etsy-scraper-main) ─────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Gestion du navigateur (singleton réutilisé) ───────────────────────────────

let _browser = null;

const { execSync } = require('child_process');

function findChromiumExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try { return execSync('which chromium', { encoding: 'utf8' }).trim(); } catch (_) {}
  try { return execSync('which chromium-browser', { encoding: 'utf8' }).trim(); } catch (_) {}
  try { return execSync('which google-chrome', { encoding: 'utf8' }).trim(); } catch (_) {}
  return null;
}

async function getBrowser() {
  if (!puppeteer) throw new Error('puppeteer-extra non installé. Lancer: npm install puppeteer-extra puppeteer-extra-plugin-stealth dans special-guide/');

  if (_browser) {
    try {
      const pages = await _browser.pages();
      if (pages !== null) return _browser;
    } catch (_) {
      _browser = null;
    }
  }

  const executablePath = findChromiumExecutable();
  const proxyUrl = process.env.PROXY_URL || null;

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
  ];
  if (proxyUrl) {
    launchArgs.push(`--proxy-server=${proxyUrl}`);
    console.log('[etsyScraper] Proxy résidentiel configuré');
  }

  const launchOpts = { headless: 'new', args: launchArgs };
  if (executablePath) {
    launchOpts.executablePath = executablePath;
    console.log(`[etsyScraper] Chromium système: ${executablePath}`);
  }

  console.log('[etsyScraper] Lancement navigateur Puppeteer Stealth…');
  _browser = await puppeteer.launch(launchOpts);

  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
  }
}

// ── Simulation mouvement souris (anti-bot) ────────────────────────────────────

async function simulateMouse(page) {
  try {
    const vp = page.viewport() || { width: 1366, height: 768 };
    const steps = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      const x = Math.floor(Math.random() * (vp.width  - 100)) + 50;
      const y = Math.floor(Math.random() * (vp.height - 100)) + 50;
      await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 5) });
      await sleep(80 + Math.random() * 150);
    }
  } catch (_) {}
}

// ── Détection blocage ──────────────────────────────────────────────────────────

function isBlocked(status, html) {
  if (status === 403 || status === 429 || status === 503) return true;
  const lower = (html || '').toLowerCase();
  return (
    lower.includes('access denied') ||
    lower.includes('captcha') ||
    lower.includes('just a moment') ||
    lower.includes('rate limit') ||
    (lower.includes('please verify') && lower.includes('human'))
  );
}

// ── Statistiques ──────────────────────────────────────────────────────────────

const _stats = {
  pagesScraped: 0,
  itemsFound:   0,
  errors:       0,
  blocked:      0,
};

// ── fetchHtml : Puppeteer Stealth (remplace axios) ───────────────────────────

const MAX_RETRIES = 3;

async function fetchHtml(url, _referer = null) {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();

      const ua = pick(USER_AGENTS);
      const vp = pick(VIEWPORTS);
      await page.setUserAgent(ua);
      await page.setViewport(vp);
      await page.setExtraHTTPHeaders({
        'Accept-Language':           'en-US,en;q=0.9',
        'Accept-Encoding':           'gzip, deflate, br',
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest':            'document',
        'Sec-Fetch-Mode':            'navigate',
        'Sec-Fetch-Site':            'none',
        'Sec-Fetch-User':            '?1',
        'Upgrade-Insecure-Requests': '1',
      });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      if (attempt > 0) await sleep(randomInt(2000, 5000) * attempt);
      await simulateMouse(page);

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status   = response ? response.status() : 0;

      await sleep(500 + Math.random() * 1000);

      const html = await page.content();
      await page.close();

      if (status === 404) throw new Error(`HTTP 404 — URL introuvable: ${url}`);

      if (isBlocked(status, html)) {
        console.warn(`[etsyScraper] Blocage détecté (${status}) sur ${url} — tentative ${attempt + 1}/${MAX_RETRIES}`);
        _stats.blocked++;
        await closeBrowser();
        if (attempt < MAX_RETRIES - 1) {
          await sleep(randomInt(5000, 15000));
          continue;
        }
        throw new Error(`IP/session bloquée par Etsy (DataDome) après ${MAX_RETRIES} tentatives. Réessayez dans quelques minutes.`);
      }

      _stats.pagesScraped++;
      return html;

    } catch (e) {
      try { if (page && !page.isClosed()) await page.close(); } catch (_) {}
      lastError = e;
      if (e.message.includes('404')) throw e;
      console.warn(`[etsyScraper] Tentative ${attempt + 1}/${MAX_RETRIES} échouée: ${e.message}`);
      _stats.errors++;
      if (attempt < MAX_RETRIES - 1) {
        await closeBrowser();
        await sleep(randomInt(3000, 8000));
      }
    }
  }

  throw lastError || new Error(`Échec après ${MAX_RETRIES} tentatives: ${url}`);
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

class RateLimiter {
  constructor() { this.lastCallAt = 0; }
  async wait() {
    const delay    = randomInt(1000, 3000);
    const elapsed  = Date.now() - this.lastCallAt;
    const waiting  = Math.max(0, delay - elapsed);
    if (waiting > 0) await sleep(waiting);
    this.lastCallAt = Date.now();
  }
}

const _rateLimiter = new RateLimiter();

// ── Helpers URL / image ────────────────────────────────────────────────────────

function makeAbsoluteURL(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  return 'https://www.etsy.com' + (url.startsWith('/') ? url : '/' + url);
}

function cleanImage(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  return url.split('?')[0] || null;
}

function extractListingId(url) {
  const m = url && url.match(/\/listing\/(\d+)/);
  return m ? m[1] : null;
}

function extractShopName(url) {
  const m = url && url.match(/etsy\.com\/shop\/([^/?#&]+)/);
  return m ? m[1] : null;
}

// ── Extraction produit depuis une card ────────────────────────────────────────

function extractProductFromCard($, card) {
  const $card = $(card);

  const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id') || null;
  const linkEl    = $card.find('a[href*="/listing/"]').first();
  const rawHref   = linkEl.attr('href') || '';
  const link      = rawHref
    ? makeAbsoluteURL(rawHref).split('?')[0]
    : (listingId ? `https://www.etsy.com/listing/${listingId}` : '');

  if (!listingId && !link) return null;
  const resolvedId = listingId || extractListingId(link);
  if (!resolvedId) return null;

  const title  = ($card.find('.v2-listing-card__title, h3, h2').first().text() || '').trim() || null;
  const imgEl  = $card.find('img.wt-image, img').first();
  const image  = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);

  const salePriceRaw = $card.find('.lc-price, .currency-value, .wt-text-black').first().text().replace(/[^\d.,]/g, '').trim();
  const origPriceRaw = $card.find('.wt-text-strikethrough .currency-value').first().text().replace(/[^\d.,]/g, '').trim();
  const isOnSale     = !!origPriceRaw;
  const discountM    = $card.find('.wt-text-grey').first().text().match(/(\d+)%/);

  let shopName = null;
  const shopLinkHref = $card.find('a[href*="/shop/"]').first().attr('href') || '';
  if (shopLinkHref) shopName = extractShopName(makeAbsoluteURL(shopLinkHref));
  if (!shopName)    shopName = extractShopName(link);

  const cardText = $card.text().toLowerCase();

  return {
    listingId:          resolvedId,
    shopId:             null,
    title,
    link,
    image,
    shopName,
    shopUrl:            shopName ? `https://www.etsy.com/shop/${shopName}` : null,
    price:              salePriceRaw || null,
    salePrice:          salePriceRaw || null,
    originalPrice:      origPriceRaw || null,
    discountPercentage: discountM ? discountM[1] : null,
    isOnSale,
    isAdvertisement:   cardText.includes('advertisement'),
    isDigitalDownload: cardText.includes('digital download') || cardText.includes('instant download'),
    isBestseller:      cardText.includes('bestseller'),
    isStarSeller:      cardText.includes('star seller'),
    freeShipping:      cardText.includes('free shipping'),
    source:            'etsy',
  };
}

// ── Parser : page de recherche ────────────────────────────────────────────────

function parseSearchPage(html) {
  const $       = cheerio.load(html);
  const results = [];
  const seenIds = new Set();

  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const data  = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;
        const link = (item.url || '').split('?')[0];
        const id   = extractListingId(link);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const rawImg   = item.image;
        const image    = cleanImage(
          typeof rawImg === 'string' ? rawImg
          : (Array.isArray(rawImg) && rawImg.length ? rawImg[0] : null)
        );
        const brand    = item.brand || {};
        const shopName = typeof brand === 'object' ? (brand.name || null) : null;
        const offers   = item.offers || {};
        const salePriceRaw = offers.price ? String(offers.price) : null;

        results.push({
          listingId: id, shopId: null,
          title:     item.name || null,
          link, image, shopName,
          shopUrl:            shopName ? `https://www.etsy.com/shop/${shopName}` : null,
          price:              salePriceRaw,
          salePrice:          salePriceRaw,
          originalPrice:      null,
          discountPercentage: null,
          isOnSale:           false,
          isAdvertisement:    false,
          isDigitalDownload:  false,
          isBestseller:       false,
          isStarSeller:       false,
          freeShipping:       false,
          source:             'etsy',
        });
      }
    } catch (_) {}
  });

  if (results.length > 0) return results;

  const cards = $(
    'div.v2-listing-card[data-listing-id], ' +
    'div[data-listing-id], ' +
    'li[data-palette-listing-id], ' +
    'article.listing-card'
  );

  cards.each((_, el) => {
    const product = extractProductFromCard($, el);
    if (product && !seenIds.has(product.listingId)) {
      seenIds.add(product.listingId);
      results.push(product);
    }
  });

  return results;
}

// ── Parser : page listing ─────────────────────────────────────────────────────

function parseListingPage(html) {
  const $ = cheerio.load(html);

  let title = $("h1[data-buy-box-listing-title='true']").text().trim();
  if (!title) title = $('h1').first().text().trim() || null;

  const images = [];
  const seen   = new Set();

  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const processObj = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj['@type'] === 'Product' && Array.isArray(obj.image)) {
          obj.image.forEach(img => {
            const u = cleanImage(img.contentURL || (typeof img === 'string' ? img : null));
            if (u && !seen.has(u)) { seen.add(u); images.push(u); }
          });
        }
        Object.values(obj).forEach(v => {
          if (v && typeof v === 'object') processObj(v);
        });
      };
      processObj(data);
    } catch (_) {}
  });

  if (!images.length) {
    $('ul.carousel-pane-list li img, .listing-page-image-carousel-component img, #photos img, img').each((_, el) => {
      const src = cleanImage(
        $(el).attr('data-src-zoom-image') ||
        $(el).attr('src') ||
        $(el).attr('data-src') || ''
      );
      if (src && (src.includes('etsystatic') || src.includes('il_')) && !seen.has(src)) {
        seen.add(src);
        images.push(src);
        if (images.length >= 5) return false;
      }
    });
  }

  let shopName = null;
  const shopLink = $('a[href*="etsy.com/shop/"]').first().attr('href') || '';
  if (shopLink) shopName = extractShopName(makeAbsoluteURL(shopLink));

  const priceText = $("[data-selector='price-only'] .wt-text-black, .lc-price, .currency-value").first().text().trim();

  const bodyText = $.text();
  const salesM   = bodyText.match(/(\d[\d,]*)\s+Sales/i);
  const admM     = bodyText.match(/(\d[\d,]*)\s+Admirers/i);

  return {
    title,
    price:      priceText || null,
    images:     images.slice(0, 5),
    shopName,
    shopId:     null,
    totalSales: salesM ? parseInt(salesM[1].replace(/,/g, ''), 10) : null,
    admirers:   admM   ? parseInt(admM[1].replace(/,/g, ''), 10)   : null,
  };
}

// ── Parser : page boutique ────────────────────────────────────────────────────

function parseShopPage(html, shopIdOrName, limit = 20) {
  const $        = cheerio.load(html);
  const listings = [];
  const seen     = new Set();

  $(
    'div.v2-listing-card[data-listing-id], ' +
    'div[data-listing-id], ' +
    'li[data-palette-listing-id]'
  ).each((_, el) => {
    if (listings.length >= limit) return false;
    const product = extractProductFromCard($, el);
    if (product && !seen.has(product.listingId)) {
      seen.add(product.listingId);
      product.shopName = product.shopName || String(shopIdOrName);
      product.shopUrl  = product.shopUrl  || `https://www.etsy.com/shop/${shopIdOrName}`;
      listings.push(product);
    }
  });

  return listings;
}

// ── Parser : pagination ───────────────────────────────────────────────────────

function parsePagination(html) {
  const $ = cheerio.load(html);
  const info = { hasNext: false, currentPage: 1, totalPages: null };

  const nextBtn = $('a[aria-label*="Next"], a.wt-pagination__item--next').first();
  if (nextBtn.length && !nextBtn.attr('disabled')) info.hasNext = true;

  const current = $('span[aria-current="page"], .wt-pagination__item--current').first();
  if (current.length) {
    const n = parseInt(current.text().trim(), 10);
    if (!isNaN(n)) info.currentPage = n;
  }

  let maxPage = 0;
  $('a[href*="page="], a[href*="ref=pagination"]').each((_, el) => {
    const m = ($(el).attr('href') || '').match(/page=(\d+)/);
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    const t = parseInt($(el).text().trim(), 10);
    if (!isNaN(t)) maxPage = Math.max(maxPage, t);
  });
  if (maxPage > 0) info.totalPages = maxPage;

  return info;
}

// ── API publique ──────────────────────────────────────────────────────────────

async function searchListingIds(keyword, limit = 48, offset = 0) {
  const page = Math.floor(offset / limit) + 1;
  const url  = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

  await _rateLimiter.wait();
  const html    = await fetchHtml(url);
  const results = parseSearchPage(html);

  _stats.itemsFound += results.length;
  console.log(`[etsyScraper] searchListingIds: ${results.length} résultats | keyword="${keyword}" page=${page}`);
  return results;
}

async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

async function getShopNameAndImage(shopId, listingId, listingId2 = null) {
  try {
    await _rateLimiter.wait();
    const html   = await fetchHtml(`https://www.etsy.com/listing/${listingId}`);
    const detail = parseListingPage(html);

    let image2 = null;
    if (listingId2) {
      try {
        await _rateLimiter.wait();
        const html2   = await fetchHtml(`https://www.etsy.com/listing/${listingId2}`);
        const detail2 = parseListingPage(html2);
        image2 = detail2.images?.[0] || null;
      } catch (_) {}
    }

    return {
      shopName: detail.shopName || null,
      shopUrl:  detail.shopName ? `https://www.etsy.com/shop/${detail.shopName}` : null,
      image:    detail.images?.[0] || null,
      image2,
      image3:   null,
      image4:   null,
    };
  } catch (e) {
    console.warn('[etsyScraper] getShopNameAndImage error:', e.message);
    return { shopName: null, shopUrl: null, image: null, image2: null, image3: null, image4: null };
  }
}

async function getShopListings(shopIdOrName, limit = 20) {
  await _rateLimiter.wait();
  const html = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  return parseShopPage(html, shopIdOrName, limit);
}

async function getShopInfo(shopIdOrName) {
  await _rateLimiter.wait();
  const html     = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  const $        = cheerio.load(html);
  const name     = $('h1').first().text().trim() || String(shopIdOrName);
  const bodyText = $.text();

  const salesM = bodyText.match(/(\d[\d,]*)\s+Sales/i);
  const admM   = bodyText.match(/(\d[\d,]*)\s+Admirers/i);

  return {
    shopId:     null,
    shopName:   name,
    title:      name,
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    shopAvatar: null,
    numSales:   salesM ? parseInt(salesM[1].replace(/,/g, ''), 10) : 0,
    admirers:   admM   ? parseInt(admM[1].replace(/,/g, ''), 10)   : 0,
  };
}

async function getListingDetail(listingId) {
  await _rateLimiter.wait();
  const html = await fetchHtml(`https://www.etsy.com/listing/${listingId}`);
  return parseListingPage(html);
}

async function scrapeProducts({ maxPages, startPage = 1, baseUrl, onPage } = {}) {
  const url     = baseUrl || 'https://www.etsy.com/c/paper-and-party-supplies/paper/stationery/design-and-templates/templates/personal-finance-templates?explicit=1';
  const results = [];
  let   page    = startPage;

  while (true) {
    if (maxPages && (page - startPage) >= maxPages) break;

    const pageUrl = page === 1 ? url : (() => {
      const u = new URL(url);
      u.searchParams.set('page', String(page));
      u.searchParams.set('ref', `pagination_${page}`);
      return u.toString();
    })();

    if (page > startPage) await _rateLimiter.wait();

    let html;
    try {
      html = await fetchHtml(pageUrl);
    } catch (e) {
      console.warn(`[etsyScraper] Erreur page ${page}: ${e.message}`);
      break;
    }

    const products = parseSearchPage(html);
    console.log(`[etsyScraper] scrapeProducts: page ${page} → ${products.length} produits`);

    if (products.length === 0) break;
    results.push(...products);
    _stats.itemsFound += products.length;

    if (onPage) onPage(page, products);

    const pagination = parsePagination(html);
    if (!pagination.hasNext) break;

    page++;
  }

  console.log(`[etsyScraper] scrapeProducts total: ${results.length} produits`);
  return results;
}

async function getShopMetrics(shopIdOrName) {
  await _rateLimiter.wait();
  const html     = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  const bodyText = cheerio.load(html).text();

  const salesM = bodyText.match(/(\d[\d,]*)\s+Sales/i);
  const admM   = bodyText.match(/(\d[\d,]*)\s+Admirers/i);

  return {
    shopName:   String(shopIdOrName),
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    numSales:   salesM ? parseInt(salesM[1].replace(/,/g, ''), 10) : 0,
    admirers:   admM   ? parseInt(admM[1].replace(/,/g, ''), 10)   : 0,
  };
}

function getStats() {
  return { ..._stats };
}

function handleEtsyError(e) {
  if (e && e.message) {
    console.error('[etsyScraper] Erreur:', e.message);
    throw e;
  }
  throw new Error('Erreur scraper Etsy inconnue');
}

async function isScraperAvailable() {
  if (!puppeteer) return false;
  try {
    const browser = await getBrowser();
    return !!browser;
  } catch (_) {
    return false;
  }
}

module.exports = {
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
};
