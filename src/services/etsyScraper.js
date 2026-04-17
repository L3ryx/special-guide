/**
 * etsyScraper.js
 * Scraping Etsy via ScrapeOps — intégration officielle avec cheerio.
 * Basé sur le scraper officiel ScrapeOps cheerio-axios.
 * Dépendances requises : axios (déjà installé), cheerio (ajouté dans package.json)
 * Variable d'environnement requise : SCRAPEOPS_API_KEY
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const SCRAPEOPS_KEY      = process.env.SCRAPEOPS_API_KEY || '';
const SCRAPEOPS_ENDPOINT = 'https://proxy.scrapeops.io/v1/';
const TIMEOUT            = 35000;
const MAX_RETRIES        = 3;

// ── ScrapeOps fetch (format officiel) ────────────────────────────────────────

async function fetchHtml(targetUrl) {
  if (!SCRAPEOPS_KEY) {
    throw new Error('SCRAPEOPS_API_KEY manquant dans les variables d\'environnement Render');
  }

  // Format officiel ScrapeOps avec optimize_request=true
  const params   = new URLSearchParams({ api_key: SCRAPEOPS_KEY, url: targetUrl, optimize_request: 'true' });
  const proxyUrl = `${SCRAPEOPS_ENDPOINT}?${params.toString()}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(proxyUrl, {
        timeout:        TIMEOUT,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      });

      if (resp.status === 200) return resp.data;

      if (resp.status === 429) {
        const wait = Math.pow(2, attempt) * 2000;
        console.warn(`[fetchHtml] 429 rate-limit, retry dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (resp.status === 403) {
        const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        if (body.toLowerCase().includes('invalid') || body.toLowerCase().includes('api key')) {
          throw new Error('SCRAPEOPS_API_KEY invalide — vérifiez la variable sur Render');
        }
        if (attempt < MAX_RETRIES - 1) {
          console.warn(`[fetchHtml] 403 attempt ${attempt + 1}, retry...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error(`Etsy bloque ScrapeOps après ${MAX_RETRIES} tentatives (403)`);
      }

      throw new Error(`HTTP ${resp.status} de ScrapeOps pour ${targetUrl}`);

    } catch (e) {
      if (e.message.includes('SCRAPEOPS_API_KEY') || e.message.includes('bloque ScrapeOps')) throw e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('ScrapeOps : échec après toutes les tentatives');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAbsoluteURL(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  return 'https://www.etsy.com' + (url.startsWith('/') ? url : '/' + url);
}

function cleanPrice(text) {
  if (!text) return null;
  const match = (text || '').match(/[\d,]+\.?\d*/);
  return match ? parseFloat(match[0].replace(/,/g, '')) : null;
}

function cleanImage(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  return url.split('?')[0] || null;
}

// ── Parser : page de recherche ────────────────────────────────────────────────

function parseSearchPage(html) {
  const $        = cheerio.load(html);
  const listings = [];
  const seenIds  = new Set();

  // 1. JSON-LD Product (source la plus fiable)
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const data  = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;
        const link = item.url || '';
        const idM  = link.match(/\/listing\/(\d+)/);
        if (!idM) continue;
        const listingId = idM[1];
        if (seenIds.has(listingId)) continue;
        seenIds.add(listingId);
        const rawImg = item.image;
        const image  = cleanImage(
          typeof rawImg === 'string' ? rawImg
          : (Array.isArray(rawImg) && rawImg.length ? rawImg[0] : null)
        );
        const brand    = item.brand || {};
        const shopName = typeof brand === 'object' ? (brand.name || null) : null;
        const offers   = item.offers || {};
        let price      = null;
        if (offers.price) price = `${offers.priceCurrency || ''} ${offers.price}`.trim();
        listings.push({
          listingId, shopId: null,
          title: item.name || null,
          link: link.split('?')[0],
          image, shopName,
          shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
          price, source: 'etsy',
        });
      }
    } catch (_) {}
  });

  if (listings.length) return listings;

  // 2. Fallback CSS selectors officiels ScrapeOps
  $("ul[data-results-grid-container] > li div.v2-listing-card[data-listing-id], li[data-palette-listing-id]").each((_, el) => {
    const card      = $(el);
    const listingId = card.attr('data-listing-id') || card.attr('data-palette-listing-id') || '';
    if (!listingId || seenIds.has(listingId)) return;
    seenIds.add(listingId);

    const linkEl   = card.find('a.v2-listing-card__img, a.listing-link, a[href*="/listing/"]').first();
    const rawLink  = linkEl.attr('href') || '';
    const link     = makeAbsoluteURL(rawLink).split('?')[0] || `https://www.etsy.com/listing/${listingId}`;

    const title    = card.find('.v2-listing-card__title, h3').first().text().trim() || null;
    const imgEl    = card.find('img.wt-image, img').first();
    const image    = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
    const priceRaw = card.find('.lc-price, .currency-value').first().text();
    const price    = priceRaw ? priceRaw.trim() : null;

    // Nom boutique depuis "By ShopName" ou via lien
    let shopName = null;
    const shopSpan = card.find('.shop-name-with-rating span').filter((_, s) => $(s).text().includes('By ')).first().text();
    if (shopSpan) shopName = shopSpan.replace('By ', '').trim();
    if (!shopName) {
      const shopM = link.match(/etsy\.com\/shop\/([^/?#&]+)/);
      if (shopM) shopName = shopM[1];
    }

    listings.push({
      listingId, shopId: null, title, link, image, shopName,
      shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
      price, source: 'etsy',
    });
  });

  return listings;
}

// ── Parser : page listing (produit) ──────────────────────────────────────────

function parseListingPage(html) {
  const $ = cheerio.load(html);

  // Titre
  let title = $("h1[data-buy-box-listing-title='true']").text().trim();
  if (!title) title = $('h1').first().text().trim() || null;

  // Images via JSON-LD (stratégie 1, officielle)
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
        Object.values(obj).forEach(processObj);
      };
      processObj(data);
    } catch (_) {}
  });

  // Stratégie 2 : carousel HTML
  if (!images.length) {
    $('ul.carousel-pane-list li img, .listing-page-image-carousel-component img, #photos img, img').each((_, el) => {
      const src = cleanImage($(el).attr('data-src-zoom-image') || $(el).attr('src') || $(el).attr('data-src') || '');
      if (src && (src.includes('etsystatic') || src.includes('il_')) && !seen.has(src)) {
        seen.add(src);
        images.push(src);
        if (images.length >= 5) return false;
      }
    });
  }

  // Nom boutique
  let shopName = null;
  const shopLink = $('a[href*="etsy.com/shop/"]').first().attr('href') || '';
  const shopM    = shopLink.match(/etsy\.com\/shop\/([^/?#&]+)/);
  if (shopM) shopName = shopM[1];
  if (!shopName) {
    const shopA = $("[data-seller-cred] a, .wt-text-link").first().attr('href') || '';
    const shopM2 = shopA.match(/etsy\.com\/shop\/([^/?#&]+)/);
    if (shopM2) shopName = shopM2[1];
  }

  // Prix
  let price = null;
  const priceEl = $("[data-selector='price-only'] .wt-text-black, .lc-price").first().text();
  if (priceEl) price = priceEl.trim();

  return { title, price, images: images.slice(0, 5), shopName, shopId: null };
}

// ── Parser : page boutique ────────────────────────────────────────────────────

function parseShopPage(html, shopIdOrName, limit = 20) {
  const $        = cheerio.load(html);
  const listings = [];

  $("div.v2-listing-card[data-listing-id], li[data-palette-listing-id]").slice(0, limit).each((_, el) => {
    const card      = $(el);
    const lid       = card.attr('data-listing-id') || card.attr('data-palette-listing-id') || null;
    const linkEl    = card.find('a[href*="/listing/"]').first();
    const link      = makeAbsoluteURL(linkEl.attr('href') || '').split('?')[0] || null;
    const imgEl     = card.find('img.wt-image, img').first();
    const image     = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
    const title     = card.find('.v2-listing-card__title, h3').first().text().trim() || null;
    listings.push({
      listingId: lid, title, link, image, source: 'etsy',
      shopName: String(shopIdOrName),
      shopUrl:  `https://www.etsy.com/shop/${shopIdOrName}`,
    });
  });

  return listings;
}

// ── Fonctions exportées ───────────────────────────────────────────────────────

async function searchListingIds(keyword, limit = 48, offset = 0) {
  const page = Math.floor(offset / limit) + 1;
  const url  = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;
  const html = await fetchHtml(url);
  const results = parseSearchPage(html);
  console.log(`[etsyScraper] searchListingIds: ${results.length} résultats | keyword="${keyword}" page=${page}`);
  return results;
}

async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

async function getShopNameAndImage(shopId, listingId, listingId2 = null) {
  try {
    const html   = await fetchHtml(`https://www.etsy.com/listing/${listingId}`);
    const detail = parseListingPage(html);
    let image2   = null;
    if (listingId2) {
      try {
        const html2   = await fetchHtml(`https://www.etsy.com/listing/${listingId2}`);
        const detail2 = parseListingPage(html2);
        image2 = detail2.images?.[0] || null;
      } catch (_) {}
    }
    console.log(`[etsyScraper] getShopNameAndImage: shopName=${detail.shopName} | image=${!!detail.images?.[0]}`);
    return {
      shopName: detail.shopName || null,
      shopUrl:  detail.shopName ? `https://www.etsy.com/shop/${detail.shopName}` : null,
      image:    detail.images?.[0] || null,
      image2, image3: null, image4: null,
    };
  } catch (e) {
    console.warn('[etsyScraper] getShopNameAndImage error:', e.message);
    return { shopName: null, shopUrl: null, image: null, image2: null, image3: null, image4: null };
  }
}

async function getShopListings(shopIdOrName, limit = 20) {
  const html = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  return parseShopPage(html, shopIdOrName, limit);
}

async function getShopInfo(shopIdOrName) {
  const html = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  const $    = cheerio.load(html);
  const name = $('h1').first().text().trim() || String(shopIdOrName);
  return {
    shopId: null, shopName: name, title: name,
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    shopAvatar: null, numSales: 0,
  };
}

async function getListingDetail(listingId) {
  const html = await fetchHtml(`https://www.etsy.com/listing/${listingId}`);
  return parseListingPage(html);
}

function handleEtsyError(e) {
  throw new Error(`Etsy Scraper error: ${e.message}`);
}

async function isScraperAvailable() {
  return !!SCRAPEOPS_KEY;
}

module.exports = {
  searchListings,
  searchListingIds,
  getShopNameAndImage,
  getShopListings,
  getShopInfo,
  getListingDetail,
  handleEtsyError,
  isScraperAvailable,
};
