/**
 * etsyScraper.js
 * Scraping Etsy via ScrapeOps — intégration officielle (optimize_request=true).
 * Aucune dépendance supplémentaire : utilise uniquement axios (déjà installé).
 * Variable d'environnement requise : SCRAPEOPS_API_KEY
 */

const axios = require('axios');

const SCRAPEOPS_KEY      = process.env.SCRAPEOPS_API_KEY || '';
const SCRAPEOPS_ENDPOINT = 'https://proxy.scrapeops.io/v1/';
const TIMEOUT            = 35000;
const MAX_RETRIES        = 3;

// ── ScrapeOps fetch ───────────────────────────────────────────────────────────

function buildScrapeOpsUrl(targetUrl) {
  // Format officiel ScrapeOps avec optimize_request=true
  const params = new URLSearchParams({
    api_key:          SCRAPEOPS_KEY,
    url:              targetUrl,
    optimize_request: 'true',
  });
  return `${SCRAPEOPS_ENDPOINT}?${params.toString()}`;
}

async function fetchHtml(targetUrl) {
  if (!SCRAPEOPS_KEY) {
    throw new Error('SCRAPEOPS_API_KEY manquant dans les variables d\'environnement Render');
  }

  const proxyUrl = buildScrapeOpsUrl(targetUrl);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(proxyUrl, {
        timeout:        TIMEOUT,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      });

      if (resp.status === 200) {
        return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      }

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
        throw new Error(`ScrapeOps 403 — Etsy bloque encore après ${MAX_RETRIES} tentatives`);
      }

      throw new Error(`HTTP ${resp.status} de ScrapeOps pour ${targetUrl}`);
    } catch (e) {
      if (e.message.includes('SCRAPEOPS_API_KEY') || e.message.includes('ScrapeOps 403')) throw e;
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

function cleanImage(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  return url.split('?')[0] || null;
}

function innerText(html, tag) {
  const rx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m  = html.match(rx);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() || null : null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseSearchPage(html) {
  const listings = [];

  // 1. JSON-LD (le plus fiable)
  const jldRx = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jldRx.exec(html)) !== null) {
    try {
      const data  = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;
        const link = item.url || '';
        const idM  = link.match(/\/listing\/(\d+)/);
        if (!idM) continue;
        const listingId = idM[1];
        const rawImg    = item.image;
        const image     = cleanImage(
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
          link, image, shopName,
          shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
          price, source: 'etsy',
        });
      }
    } catch (_) {}
  }
  if (listings.length) return listings;

  // 2. Fallback regex HTML
  const cardRx = /data-listing-id="(\d+)"[^>]*>([\s\S]*?)(?=data-listing-id="|<\/ul>)/gi;
  while ((match = cardRx.exec(html)) !== null) {
    const listingId = match[1];
    const block     = match[2];
    const linkM  = block.match(/href="(https?:\/\/www\.etsy\.com\/listing\/[^"]+)"/i);
    const link   = linkM ? linkM[1].split('?')[0] : `https://www.etsy.com/listing/${listingId}`;
    const imgM   = block.match(/(?:data-src|src)="([^"]+(?:etsystatic|il_)[^"]+)"/i);
    const image  = imgM ? cleanImage(imgM[1]) : null;
    const shopM  = link.match(/etsy\.com\/shop\/([^/?#&]+)/);
    const shopName = shopM ? shopM[1] : null;
    const titleM = block.match(/<h3[^>]*>([^<]+)<\/h3>/i);
    const title  = titleM ? titleM[1].trim() : null;
    if (!listingId) continue;
    listings.push({
      listingId, shopId: null, title, link, image, shopName,
      shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
      price: null, source: 'etsy',
    });
  }
  return listings;
}

function parseListingPage(html) {
  const title = innerText(html, 'h1');
  const images = [];
  const imgRx  = /(?:src|data-src)="([^"]+(?:etsystatic|il_)[^"]+)"/gi;
  let m;
  while ((m = imgRx.exec(html)) !== null) {
    const src = cleanImage(m[1]);
    if (src && !images.includes(src)) {
      images.push(src);
      if (images.length >= 5) break;
    }
  }
  let shopName = null;
  const shopM = html.match(/href="https?:\/\/www\.etsy\.com\/shop\/([^/?#"&]+)/i);
  if (shopM) shopName = shopM[1];
  return { title, price: null, images, shopName, shopId: null };
}

function parseShopPage(html, shopIdOrName, limit = 20) {
  const listings = [];
  const cardRx = /data-listing-id="(\d+)"[^>]*>([\s\S]*?)(?=data-listing-id="|<\/ul>)/gi;
  let match;
  while ((match = cardRx.exec(html)) !== null && listings.length < limit) {
    const lid    = match[1];
    const block  = match[2];
    const linkM  = block.match(/href="(https?:\/\/www\.etsy\.com\/listing\/[^"]+)"/i);
    const link   = linkM ? linkM[1].split('?')[0] : null;
    const imgM   = block.match(/(?:data-src|src)="([^"]+(?:etsystatic|il_)[^"]+)"/i);
    const image  = imgM ? cleanImage(imgM[1]) : null;
    const titleM = block.match(/<h3[^>]*>([^<]+)<\/h3>/i);
    const title  = titleM ? titleM[1].trim() : null;
    listings.push({
      listingId: lid, title, link, image, source: 'etsy',
      shopName:  String(shopIdOrName),
      shopUrl:   `https://www.etsy.com/shop/${shopIdOrName}`,
    });
  }
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
  const html  = await fetchHtml(`https://www.etsy.com/shop/${shopIdOrName}`);
  const title = innerText(html, 'h1') || String(shopIdOrName);
  return {
    shopId: null, shopName: title, title,
    shopUrl: `https://www.etsy.com/shop/${shopIdOrName}`,
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
