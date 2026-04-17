/**
 * etsyScraper.js
 * Scraper Etsy — source gratuite via résultats indexés.
 *
 * Le scraping direct avec navigateur a été retiré pour fonctionner proprement
 * sur Render gratuit, sans dépendance navigateur.
 *
 * Dépendances : cheerio
 */

const cheerio = require('cheerio');

// ── Pool user-agents ──────────────────────────────────────────────────────────

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

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Statistiques ──────────────────────────────────────────────────────────────

const _stats = {
  pagesScraped: 0,
  itemsFound:   0,
  errors:       0,
  blocked:      0,
  fallbackPages: 0,
};

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

function cleanText(text) {
  return String(text || '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractListingId(url) {
  const m = url && url.match(/\/listing\/(\d+)/);
  return m ? m[1] : null;
}

function extractShopName(url) {
  const m = url && url.match(/etsy\.com\/shop\/([^/?#&]+)/);
  return m ? m[1] : null;
}

function extractShopNameFromTitle(title) {
  const cleaned = cleanText(title);
  const byMatch = cleaned.match(/\bby\s+([A-Za-z0-9_-]{3,})\b/i);
  if (byMatch) return byMatch[1];
  return null;
}

function isLikelyDigitalProduct(title) {
  return /\b(digital|download|printable|svg|template|pdf|excel|spreadsheet|tracker|planner|pattern|cricut|sublimation|clipart|png|jpg|canva|stl|editable|certificate|plans?|cnc)\b/i.test(title);
}

function decodeHtmlAttr(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeEtsyImage(url) {
  const cleaned = cleanImage(url);
  if (!cleaned) return null;
  return cleaned.replace(/\/il_(\d+x\d+|fullxfull)\./, '/il_570xN.');
}

function buildFallbackProduct(item) {
  const link = (item.purl || item.pageUrl || '').split('?')[0];
  const listingId = extractListingId(link);
  if (!listingId || !/etsy\.com\/listing\//i.test(link)) return null;

  const title = cleanText(item.t || item.title || item.desc || '');
  if (isLikelyDigitalProduct(title)) return null;
  const image = normalizeEtsyImage(item.murl || item.mediaUrl || item.turl);
  if (!image) return null;

  const extractedShopName = extractShopName(link) || extractShopNameFromTitle(title);
  const fallbackName = cleanText(title.replace(/\s*[-|]\s*Etsy\s*$/i, '').replace(/\s*\.\.\.\s*$/g, '')).slice(0, 70) || `Etsy listing ${listingId}`;
  const shopName = extractedShopName || fallbackName;
  const hasRealShopName = !!extractedShopName;

  return {
    listingId,
    shopId: null,
    title: title || null,
    link,
    image,
    shopName,
    shopUrl: hasRealShopName ? `https://www.etsy.com/shop/${shopName}` : link,
    hasRealShopName,
    price: null,
    salePrice: null,
    originalPrice: null,
    discountPercentage: null,
    isOnSale: false,
    isAdvertisement: false,
    isDigitalDownload: isLikelyDigitalProduct(title),
    isBestseller: false,
    isStarSeller: false,
    freeShipping: false,
    source: 'etsy-indexed',
  };
}

async function fetchBingImageResults(keyword, limit = 48, offset = 0) {
  const first = Math.max(1, offset + 1);
  const query = `site:etsy.com/listing ${keyword} -digital -download -printable -svg -template`;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=${first}&count=${Math.min(limit, 50)}&safeSearch=moderate`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': pick(USER_AGENTS),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
  });

  const html = await response.text();
  if (!response.ok) throw new Error(`Bing images HTTP ${response.status}`);

  const results = [];
  const seen = new Set();
  const re = /<a[^>]+class="iusc"[^>]+m="([^"]+)"/g;
  let match;

  while ((match = re.exec(html)) && results.length < limit) {
    try {
      const item = JSON.parse(decodeHtmlAttr(match[1]));
      const product = buildFallbackProduct(item);
      if (!product || seen.has(product.listingId)) continue;
      seen.add(product.listingId);
      results.push(product);
    } catch (_) {}
  }

  if (!results.length && /captcha|verify|unusual traffic/i.test(html)) {
    throw new Error('Source de secours temporairement limitée');
  }

  _stats.fallbackPages++;
  console.log(`[etsyScraper] fallback Bing Images: ${results.length} résultats | keyword="${keyword}"`);
  return results;
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

  await _rateLimiter.wait();
  const results = await fetchBingImageResults(keyword, limit, offset);

  _stats.itemsFound += results.length;
  console.log(`[etsyScraper] searchListingIds: ${results.length} résultats | keyword="${keyword}" page=${page}`);
  return results;
}

async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

async function getShopNameAndImage(shopId, listingId, listingId2 = null) {
  const fallback = await fetchBingImageResults(String(listingId), listingId2 ? 2 : 1, 0).catch(() => []);
  return {
    shopName: fallback[0]?.shopName || null,
    shopUrl: fallback[0]?.shopUrl || null,
    image: fallback[0]?.image || null,
    image2: fallback[1]?.image || null,
    image3: null,
    image4: null,
  };
}

async function getShopListings(shopIdOrName, limit = 20) {
  return fetchBingImageResults(String(shopIdOrName), limit, 0).catch(() => []);
}

async function getShopInfo(shopIdOrName) {
  const name = String(shopIdOrName);

  return {
    shopId:     null,
    shopName:   name,
    title:      name,
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    shopAvatar: null,
    numSales:   0,
    admirers:   0,
  };
}

async function getListingDetail(listingId) {
  const fallback = await fetchBingImageResults(String(listingId), 1, 0).catch(() => []);
  return {
    title: fallback[0]?.title || null,
    price: null,
    images: fallback[0]?.image ? [fallback[0].image] : [],
    shopName: fallback[0]?.shopName || null,
    shopId: null,
    totalSales: null,
    admirers: null,
  };
}

async function scrapeProducts({ maxPages, startPage = 1, baseUrl, onPage } = {}) {
  const url     = baseUrl || 'https://www.etsy.com/c/paper-and-party-supplies/paper/stationery/design-and-templates/templates/personal-finance-templates?explicit=1';
  const keyword = (() => {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('q') || parsed.pathname.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') || 'etsy product';
    } catch (_) {
      return 'etsy product';
    }
  })();
  const results = [];
  let   page    = startPage;

  while (true) {
    if (maxPages && (page - startPage) >= maxPages) break;
    if (page > startPage) await _rateLimiter.wait();
    const products = await fetchBingImageResults(keyword, 48, (page - 1) * 48).catch(() => []);
    console.log(`[etsyScraper] scrapeProducts: page ${page} → ${products.length} produits`);

    if (products.length === 0) break;
    results.push(...products);
    _stats.itemsFound += products.length;

    if (onPage) onPage(page, products);

    if (products.length < 48) break;
    page++;
  }

  console.log(`[etsyScraper] scrapeProducts total: ${results.length} produits`);
  return results;
}

async function getShopMetrics(shopIdOrName) {
  return {
    shopName:   String(shopIdOrName),
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    numSales:   0,
    admirers:   0,
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
