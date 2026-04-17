/**
 * etsyScraper.js
 * Scraping Etsy via ScrapeOps Proxy — directement depuis Node.js, sans microservice Python.
 * Variable d'environnement requise : SCRAPEOPS_API_KEY
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const SCRAPEOPS_KEY      = process.env.SCRAPEOPS_API_KEY || '';
const SCRAPEOPS_ENDPOINT = 'https://proxy.scrapeops.io/v1/';

// ── Helpers ───────────────────────────────────────────────────────────────────

function scrapeopsUrl(targetUrl) {
  return `${SCRAPEOPS_ENDPOINT}?api_key=${SCRAPEOPS_KEY}&url=${encodeURIComponent(targetUrl)}&render_js=false&country=us`;
}

function cleanImage(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  return url.split('?')[0] || null;
}

async function fetchHtml(url, timeout = 40000) {
  if (!SCRAPEOPS_KEY) throw new Error('SCRAPEOPS_API_KEY manquant dans les variables d\'environnement Render');
  const proxied = scrapeopsUrl(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await axios.get(proxied, { timeout });
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 4000 + attempt * 3000));
        continue;
      }
      return resp.data;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      else throw e;
    }
  }
  throw new Error('ScrapeOps : pas de réponse après 3 tentatives');
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseSearchPage(html) {
  const listings = [];

  // 1. JSON-LD (le plus fiable)
  const jldRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jldRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;
        const link = item.url || '';
        const idMatch = link.match(/\/listing\/(\d+)/);
        if (!idMatch) continue;
        const listingId = idMatch[1];
        const rawImg = item.image;
        const image = cleanImage(
          typeof rawImg === 'string' ? rawImg
            : (Array.isArray(rawImg) && rawImg.length ? rawImg[0] : null)
        );
        const brand    = item.brand || {};
        const shopName = typeof brand === 'object' ? (brand.name || null) : null;
        const offers   = item.offers || {};
        let price = null;
        if (offers.price) price = `${offers.priceCurrency || ''} ${offers.price}`.trim();
        listings.push({
          listingId, shopId: null,
          title: item.name || null,
          link, image,
          shopName,
          shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
          price, source: 'etsy',
        });
      }
    } catch (_) {}
  }
  if (listings.length) return listings;

  // 2. Fallback Cheerio
  const $ = cheerio.load(html);
  $('li[data-palette-listing-id], [data-listing-id]').each((_, card) => {
    const listingId = $(card).attr('data-palette-listing-id') || $(card).attr('data-listing-id');
    if (!listingId) return;
    const linkEl  = $(card).find('a[href*="/listing/"]').first();
    let link = linkEl.attr('href') || `https://www.etsy.com/listing/${listingId}`;
    if (link && !link.startsWith('http')) link = 'https://www.etsy.com' + link;
    const title  = $(card).find('h3, .v2-listing-card__title').first().text().trim() || null;
    const imgEl  = $(card).find('img').first();
    const image  = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
    let shopName = null;
    const shopMatch = link.match(/etsy\.com\/shop\/([^/?#&]+)/);
    if (shopMatch) shopName = shopMatch[1];
    const price  = $(card).find('.currency-value').first().text().trim() || null;
    listings.push({ listingId, shopId: null, title, link, image, shopName,
      shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null, price, source: 'etsy' });
  });
  return listings;
}

function parseListingPage(html, listingId) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || null;
  const images = [];
  $('img').each((_, el) => {
    const src = cleanImage($(el).attr('src') || $(el).attr('data-src') || '');
    if (src && (src.includes('etsystatic') || src.includes('il_')) && !images.includes(src)) {
      images.push(src);
      if (images.length >= 5) return false;
    }
  });
  let shopName = null;
  const shopLink = $('a[href*="etsy.com/shop/"]').first().attr('href') || '';
  const shopMatch = shopLink.match(/etsy\.com\/shop\/([^/?#&]+)/);
  if (shopMatch) shopName = shopMatch[1];
  return { title, price: null, images, shopName, shopId: null };
}

function parseShopPage(html, shopIdOrName, limit = 20) {
  const $ = cheerio.load(html);
  const listings = [];
  $('li[data-palette-listing-id], [data-listing-id]').slice(0, limit).each((_, card) => {
    const lid   = $(card).attr('data-palette-listing-id') || $(card).attr('data-listing-id');
    const linkEl = $(card).find('a[href*="/listing/"]').first();
    let link = linkEl.attr('href') || null;
    if (link && !link.startsWith('http')) link = 'https://www.etsy.com' + link;
    const imgEl = $(card).find('img').first();
    const image = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
    const title = $(card).find('h3, .v2-listing-card__title').first().text().trim() || null;
    listings.push({ listingId: lid, title, link, image, source: 'etsy',
      shopName: String(shopIdOrName), shopUrl: `https://www.etsy.com/shop/${shopIdOrName}` });
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
    const html = await fetchHtml(`https://www.etsy.com/listing/${listingId}`);
    const detail = parseListingPage(html, listingId);
    let image2 = null;
    if (listingId2) {
      try {
        const html2  = await fetchHtml(`https://www.etsy.com/listing/${listingId2}`);
        const detail2 = parseListingPage(html2, listingId2);
        image2 = detail2.images?.[0] || null;
      } catch (_) {}
    }
    console.log(`[etsyScraper] getShopNameAndImage: shopName=${detail.shopName} | image=${!!detail.images?.[0]}`);
    return {
      shopName: detail.shopName || null,
      shopUrl:  detail.shopName ? `https://www.etsy.com/shop/${detail.shopName}` : null,
      image:    detail.images?.[0] || null,
      image2,
      image3: null,
      image4: null,
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
  const $ = cheerio.load(html);
  const shopName = $('h1').first().text().trim() || String(shopIdOrName);
  return {
    shopId:     null,
    shopName,
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    shopAvatar: null,
    title:      shopName,
    numSales:   0,
  };
}

async function getListingDetail(listingId) {
  const html = await fetchHtml(`https://www.etsy.com/listing/${listingId}`);
  return parseListingPage(html, listingId);
}

function handleEtsyError(e) {
  throw new Error(`Etsy Scraper error: ${e.message}`);
}

/**
 * Vérifie que la clé ScrapeOps est bien configurée (pas de requête réseau).
 */
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
