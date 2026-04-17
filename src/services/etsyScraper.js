/**
 * etsyScraper.js
 * Scraping Etsy via ScrapeOps Proxy API — format officiel de la documentation.
 * https://scrapeops.io/docs/web-scraping-proxy-api-aggregator/quickstart/
 *
 * Variables d'environnement requises : SCRAPEOPS_API_KEY
 * Dépendances : axios (déjà installé), cheerio (ajouté dans package.json)
 *
 * Codes de retour ScrapeOps :
 *   200 = succès (crédité)
 *   401 = crédits épuisés
 *   403 = clé API invalide OU email non validé sur scrapeops.io
 *   429 = limite de concurrence dépassée
 *   500 = ScrapeOps n'a pas pu obtenir de réponse après 2 min
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const SCRAPEOPS_KEY      = process.env.SCRAPEOPS_API_KEY || '';
const SCRAPEOPS_ENDPOINT = 'https://proxy.scrapeops.io/v1/';
const TIMEOUT            = 120000; // ScrapeOps peut prendre jusqu'à 2 min
const MAX_RETRIES        = 3;

// ── ScrapeOps fetch — format officiel ─────────────────────────────────────────

async function fetchHtml(targetUrl) {
  if (!SCRAPEOPS_KEY) {
    throw new Error('SCRAPEOPS_API_KEY manquant dans les variables d\'environnement Render');
  }

  // Format officiel selon la documentation ScrapeOps
  const params = new URLSearchParams({
    api_key: SCRAPEOPS_KEY,
    url:     targetUrl,
  });
  const proxyUrl = `${SCRAPEOPS_ENDPOINT}?${params.toString()}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(proxyUrl, {
        timeout:        TIMEOUT,
        validateStatus: () => true,
      });

      if (resp.status === 200) {
        return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      }

      if (resp.status === 401) {
        throw new Error(
          'ScrapeOps : crédits épuisés (401)\n' +
          '→ Vérifiez votre solde sur scrapeops.io/app\n' +
          '→ Le plan gratuit donne 1000 crédits/mois (reset mensuel)\n' +
          '→ Ou créez un nouveau compte gratuit pour avoir 1000 crédits frais'
        );
      }

      if (resp.status === 403) {
        throw new Error(
          'ScrapeOps 403 : clé API invalide OU email non confirmé.\n' +
          '→ Vérifiez votre boîte mail et confirmez votre email scrapeops.io\n' +
          '→ Vérifiez que SCRAPEOPS_API_KEY est bien défini sur Render'
        );
      }

      if (resp.status === 429) {
        const wait = Math.pow(2, attempt) * 3000;
        console.warn(`[fetchHtml] 429 concurrence dépassée, retry dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (resp.status === 500) {
        if (attempt < MAX_RETRIES - 1) {
          console.warn(`[fetchHtml] 500 ScrapeOps timeout, retry ${attempt + 1}...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw new Error('ScrapeOps 500 : impossible d\'obtenir une réponse d\'Etsy après 2 min');
      }

      throw new Error(`ScrapeOps a retourné HTTP ${resp.status}`);

    } catch (e) {
      // Ne pas retry sur les erreurs définitives
      if (
        e.message.includes('SCRAPEOPS_API_KEY') ||
        e.message.includes('ScrapeOps 403') ||
        e.message.includes('crédits épuisés')
      ) throw e;

      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
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

  // 1. JSON-LD (source la plus fiable)
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
        const rawImg   = item.image;
        const image    = cleanImage(
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
          title:    item.name || null,
          link:     link.split('?')[0],
          image, shopName,
          shopUrl:  shopName ? `https://www.etsy.com/shop/${shopName}` : null,
          price, source: 'etsy',
        });
      }
    } catch (_) {}
  });

  if (listings.length) return listings;

  // 2. Fallback sélecteurs CSS officiels ScrapeOps
  $("ul[data-results-grid-container] > li div.v2-listing-card[data-listing-id], li[data-palette-listing-id]").each((_, el) => {
    const card      = $(el);
    const listingId = card.attr('data-listing-id') || card.attr('data-palette-listing-id') || '';
    if (!listingId || seenIds.has(listingId)) return;
    seenIds.add(listingId);

    const linkEl  = card.find('a.v2-listing-card__img, a.listing-link, a[href*="/listing/"]').first();
    const link    = makeAbsoluteURL(linkEl.attr('href') || '').split('?')[0] || `https://www.etsy.com/listing/${listingId}`;
    const title   = card.find('.v2-listing-card__title, h3').first().text().trim() || null;
    const imgEl   = card.find('img.wt-image, img').first();
    const image   = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
    const price   = card.find('.lc-price, .currency-value').first().text().trim() || null;

    let shopName = null;
    const bySpan = card.find('.shop-name-with-rating span').filter((_, s) => $(s).text().includes('By ')).first().text();
    if (bySpan) shopName = bySpan.replace('By ', '').trim();
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
        Object.values(obj).forEach(processObj);
      };
      processObj(data);
    } catch (_) {}
  });

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

  let shopName = null;
  const shopLink = $('a[href*="etsy.com/shop/"]').first().attr('href') || '';
  const shopM    = shopLink.match(/etsy\.com\/shop\/([^/?#&]+)/);
  if (shopM) shopName = shopM[1];

  const priceText = $("[data-selector='price-only'] .wt-text-black, .lc-price").first().text().trim();

  return { title, price: priceText || null, images: images.slice(0, 5), shopName, shopId: null };
}

// ── Parser : page boutique ────────────────────────────────────────────────────

function parseShopPage(html, shopIdOrName, limit = 20) {
  const $        = cheerio.load(html);
  const listings = [];

  $("div.v2-listing-card[data-listing-id], li[data-palette-listing-id]").slice(0, limit).each((_, el) => {
    const card  = $(el);
    const lid   = card.attr('data-listing-id') || card.attr('data-palette-listing-id') || null;
    const link  = makeAbsoluteURL(card.find('a[href*="/listing/"]').first().attr('href') || '').split('?')[0] || null;
    const image = cleanImage(card.find('img.wt-image, img').first().attr('data-src') || card.find('img.wt-image, img').first().attr('src') || null);
    const title = card.find('.v2-listing-card__title, h3').first().text().trim() || null;
    listings.push({
      listingId: lid, title, link, image, source: 'etsy',
      shopName:  String(shopIdOrName),
      shopUrl:   `https://www.etsy.com/shop/${shopIdOrName}`,
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
