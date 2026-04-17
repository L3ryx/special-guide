/**
 * etsyScraper.js
 * Scraper Etsy avancé — architecture modulaire portée depuis etsy_scraper-main (Python).
 *
 * Fonctionnement : requêtes directes avec headers Chrome authentiques + gestion anti-bot.
 * Pas de proxy payant requis.
 *
 * Dépendances : axios, cheerio (déjà dans package.json)
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  timing: {
    pageMin:           1000,
    pageMax:           3000,
    retryMin:          5000,
    retryMax:          10000,
    blockRecoveryMin:  30000,
    blockRecoveryMax:  60000,
  },
  session: {
    maxRequestsPerSession: 50,
    maxSessionAgeMs:       5 * 60 * 1000, // 5 min
    maxRetries:            3,
    backoffFactor:         2.0,
  },
  validation: {
    blockedStatusCodes:  [403, 429, 503],
    datadomeIndicators:  ['x-datadome', 'datadome-captcha', 'dd-protection'],
  },
  timeout: 30000,
};

const CHROME_HEADERS = {
  'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-encoding':           'gzip, deflate, br, zstd',
  'accept-language':           'en-US,en;q=0.9',
  'cache-control':             'no-cache',
  'pragma':                    'no-cache',
  'priority':                  'u=0, i',
  'sec-ch-ua':                 '"Not;A=Brand";v="99", "Google Chrome";v="124", "Chromium";v="124"',
  'sec-ch-ua-mobile':          '?0',
  'sec-ch-ua-platform':        '"Windows"',
  'sec-fetch-dest':            'document',
  'sec-fetch-mode':            'navigate',
  'sec-fetch-site':            'same-origin',
  'sec-fetch-user':            '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// ── Utilitaires ────────────────────────────────────────────────────────────────

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getRandomDelay(type = 'page') {
  const t = CONFIG.timing;
  if (type === 'page')    return randomInt(t.pageMin, t.pageMax);
  if (type === 'retry')   return randomInt(t.retryMin, t.retryMax);
  return randomInt(t.blockRecoveryMin, t.blockRecoveryMax);
}

// ── Gestionnaire de session ────────────────────────────────────────────────────

class SessionManager {
  constructor() {
    this.requestCount  = 0;
    this.sessionStart  = Date.now();
    this.lastRequestAt = 0;
  }

  shouldRotate() {
    const { maxRequestsPerSession, maxSessionAgeMs } = CONFIG.session;
    return (
      this.requestCount >= maxRequestsPerSession ||
      (Date.now() - this.sessionStart) > maxSessionAgeMs
    );
  }

  rotate() {
    this.requestCount  = 0;
    this.sessionStart  = Date.now();
    console.log('[SessionManager] Session tournée');
  }

  recordRequest() {
    this.requestCount++;
    this.lastRequestAt = Date.now();
  }
}

class RateLimiter {
  constructor() {
    this.lastCallAt = 0;
  }

  async wait() {
    const delay     = getRandomDelay('page');
    const elapsed   = Date.now() - this.lastCallAt;
    const remaining = Math.max(0, delay - elapsed);
    if (remaining > 0) await sleep(remaining);
    this.lastCallAt = Date.now();
  }
}

// Instances globales (partagées entre les appels)
const _sessionManager = new SessionManager();
const _rateLimiter    = new RateLimiter();
const _stats = {
  pagesScraped: 0,
  itemsFound:   0,
  errors:       0,
  blocked:      0,
};

// ── Détection blocage ──────────────────────────────────────────────────────────

function isBlocked(status, headers, body) {
  if (CONFIG.validation.blockedStatusCodes.includes(status)) return true;
  const headersStr = JSON.stringify(headers).toLowerCase();
  for (const indicator of CONFIG.validation.datadomeIndicators) {
    if (headersStr.includes(indicator)) return true;
  }
  if (typeof body === 'string' && body.toLowerCase().includes('captcha')) return true;
  return false;
}

// ── Requête HTTP avec retry ────────────────────────────────────────────────────

async function fetchHtml(targetUrl, referer = null) {
  if (_sessionManager.shouldRotate()) _sessionManager.rotate();

  const headers = { ...CHROME_HEADERS };
  if (referer) headers['referer'] = referer;

  const { maxRetries, backoffFactor } = CONFIG.session;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await axios.get(targetUrl, {
        headers,
        timeout:        CONFIG.timeout,
        validateStatus: () => true,
        decompress:     true,
      });

      _sessionManager.recordRequest();

      if (resp.status === 200) {
        const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);

        if (isBlocked(resp.status, resp.headers, body)) {
          console.warn(`[etsyScraper] Blocage détecté sur ${targetUrl}`);
          _stats.blocked++;
          _sessionManager.rotate();
          await sleep(getRandomDelay('block'));
          continue;
        }

        _stats.pagesScraped++;
        return body;
      }

      if (resp.status === 429 || resp.status === 503) {
        console.warn(`[etsyScraper] HTTP ${resp.status} — attente avant retry`);
        _stats.blocked++;
        await sleep(getRandomDelay('retry'));
        _sessionManager.rotate();
        continue;
      }

      if (resp.status === 404) {
        throw new Error(`HTTP 404 — URL introuvable: ${targetUrl}`);
      }

      throw new Error(`HTTP ${resp.status} sur ${targetUrl}`);

    } catch (e) {
      lastError = e;
      if (e.message.includes('404')) throw e;
      console.warn(`[etsyScraper] Tentative ${attempt + 1}/${maxRetries} échouée: ${e.message}`);
      _stats.errors++;

      if (attempt < maxRetries - 1) {
        const delay = Math.pow(backoffFactor, attempt) * 1000 * (1 + Math.random());
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error(`Échec après ${maxRetries} tentatives: ${targetUrl}`);
}

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

// ── Extraction produit depuis une card (portée depuis DataExtractor Python) ───

function extractProductFromCard($, card) {
  const $card = $(card);

  const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id') || null;
  const linkEl    = $card.find('a[href*="/listing/"]').first();
  const rawHref   = linkEl.attr('href') || '';
  const link      = rawHref ? makeAbsoluteURL(rawHref).split('?')[0] : (listingId ? `https://www.etsy.com/listing/${listingId}` : '');

  if (!listingId && !link) return null;
  const resolvedId = listingId || extractListingId(link);
  if (!resolvedId) return null;

  const title  = ($card.find('.v2-listing-card__title, h3, h2').first().text() || '').trim() || null;
  const imgEl  = $card.find('img.wt-image, img').first();
  const image  = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);

  // Prix
  const salePriceRaw  = $card.find('.lc-price, .currency-value, .wt-text-black').first().text().replace(/[^\d.,]/g, '').trim();
  const origPriceRaw  = $card.find('.wt-text-strikethrough .currency-value').first().text().replace(/[^\d.,]/g, '').trim();
  const isOnSale      = !!origPriceRaw;
  const discountM     = $card.find('.wt-text-grey').first().text().match(/(\d+)%/);

  // Boutique
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

  // 1. JSON-LD (source la plus fiable)
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
          listingId:          id,
          shopId:             null,
          title:              item.name || null,
          link,
          image,
          shopName,
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

  // 2. Fallback sélecteurs CSS (portés depuis DataExtractor Python)
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

// ── Parser : page listing (produit) ──────────────────────────────────────────

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

  const priceText = $(
    "[data-selector='price-only'] .wt-text-black, .lc-price, .currency-value"
  ).first().text().trim();

  // Métriques boutique (portées depuis extract_shop_metrics Python)
  const bodyText  = $.text();
  const salesM    = bodyText.match(/(\d[\d,]*)\s+Sales/i);
  const admM      = bodyText.match(/(\d[\d,]*)\s+Admirers/i);

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

// ── Parser : pagination (portée depuis PaginationHandler Python) ──────────────

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

// ── Fonctions publiques exportées ─────────────────────────────────────────────

/**
 * Recherche des listings Etsy par mot-clé.
 * @param {string} keyword
 * @param {number} limit
 * @param {number} offset
 * @returns {Promise<Array>}
 */
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

/**
 * Alias de searchListingIds.
 */
async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

/**
 * Récupère les infos boutique + images via la page du listing.
 */
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

/**
 * Récupère les listings d'une boutique.
 */
async function getShopListings(shopIdOrName, limit = 20) {
  await _rateLimiter.wait();
  const html = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  return parseShopPage(html, shopIdOrName, limit);
}

/**
 * Récupère les infos générales d'une boutique (avec métriques ventes/admirateurs).
 */
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

/**
 * Récupère les détails complets d'un listing.
 */
async function getListingDetail(listingId) {
  await _rateLimiter.wait();
  const html = await fetchHtml(`https://www.etsy.com/listing/${listingId}`);
  return parseListingPage(html);
}

/**
 * Scraping de plusieurs pages avec pagination automatique.
 * Portée depuis scrape_products() (EtsyScraper Python).
 * @param {object} options
 * @param {number} [options.maxPages]
 * @param {number} [options.startPage=1]
 * @param {string} [options.baseUrl]
 * @param {function} [options.onPage] callback(page, products)
 * @returns {Promise<Array>}
 */
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
      html = await fetchHtml(pageUrl, page > 1 ? url : null);
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

/**
 * Récupère les métriques d'une boutique (ventes, admirateurs).
 * Portée depuis extract_shop_metrics() Python.
 */
async function getShopMetrics(shopIdOrName) {
  await _rateLimiter.wait();
  const html     = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  const bodyText = cheerio.load(html).text();

  const salesM = bodyText.match(/(\d[\d,]*)\s+Sales/i);
  const admM   = bodyText.match(/(\d[\d,]*)\s+Admirers/i);

  return {
    shopName:   String(shopIdOrName),
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    totalSales: salesM ? parseInt(salesM[1].replace(/,/g, ''), 10) : null,
    admirers:   admM   ? parseInt(admM[1].replace(/,/g, ''), 10)   : null,
    urlValid:   true,
  };
}

/**
 * Retourne les statistiques globales du scraper.
 */
function getStats() {
  return { ..._stats };
}

/**
 * Gestion d'erreur centralisée (compatibilité avec l'ancien scraper).
 */
function handleEtsyError(e) {
  throw new Error(`Etsy Scraper error: ${e.message}`);
}

/**
 * Le scraper est toujours disponible (aucune clé API requise).
 */
async function isScraperAvailable() {
  return true;
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
