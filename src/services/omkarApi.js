/**
 * omkarApi.js
 * Remplacement de etsyApi.js — utilise omkar.cloud (5 000 req/mois gratuites)
 * Interface 100% identique à etsyApi.js pour un remplacement sans toucher au reste du code.
 *
 * Endpoints utilisés :
 *  GET https://etsy-scraper.omkar.cloud/etsy/search?keyword=...&page=...
 *    → { result_count, listings: [{ listing_id, name }] }
 *
 *  GET https://etsy-scraper.omkar.cloud/etsy/listing?listing_id=...
 *    → { listing_id, name, url, price_usd, shop_id, shop_name, full_image_url,
 *        thumbnail_url, tags, ... }
 *
 * Variable d'environnement requise : OMKAR_API_KEY
 */

'use strict';

const axios = require('axios');

const BASE = 'https://etsy-scraper.omkar.cloud';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getKey() {
  const key = process.env.OMKAR_API_KEY;
  if (!key) throw new Error('OMKAR_API_KEY not configured');
  return key;
}

function headers() {
  return { 'API-Key': getKey() };
}

function cleanImage(url) {
  if (!url) return null;
  return url.split('?')[0];
}

/**
 * Convertit une réponse listing omkar → format interne identique à etsyApi.js
 */
function normalizeListing(item, shopName = null, shopUrl = null) {
  const resolvedShop = shopName || item.shop_name || null;
  const resolvedUrl  = shopUrl  || (resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null);

  const image =
    cleanImage(item.full_image_url || item.thumbnail_url || null);

  const price = item.price_usd != null
    ? `USD ${Number(item.price_usd).toFixed(2)}`
    : null;

  return {
    title:     item.name  || null,
    link:      item.url   || `https://www.etsy.com/listing/${item.listing_id}`,
    image,
    source:    'etsy',
    shopName:  resolvedShop,
    shopUrl:   resolvedUrl,
    price,
    listingId: item.listing_id,
    shopId:    item.shop_id || null,
  };
}

// ── Rate limiter simple (respect des limites omkar) ───────────────────────────

let _lastCall = 0;
async function rateWait(minMs = 300) {
  const elapsed = Date.now() - _lastCall;
  if (elapsed < minMs) await new Promise(r => setTimeout(r, minMs - elapsed));
  _lastCall = Date.now();
}

// ── searchListingIds ──────────────────────────────────────────────────────────
/**
 * Recherche Etsy — retourne listing_id, shop_id, title, link.
 * Même signature que etsyApi.js : searchListingIds(keyword, limit, offset)
 *
 * omkar.cloud pagine par "page" (48 items/page).
 * On convertit l'offset en numéro de page.
 */
async function searchListingIds(keyword, limit = 100, offset = 0) {
  const PER_PAGE = 48;
  const page = Math.floor(offset / PER_PAGE) + 1;

  await rateWait(400);

  const r = await axios.get(`${BASE}/etsy/search`, {
    params:  { keyword },
    headers: headers(),
    timeout: 30000,
  });

  const listings = r.data.listings || [];
  console.log('[omkarApi] searchListingIds:', listings.length,
    'results | keyword:', keyword, '| page:', page);

  // Pour chaque listing_id on a besoin du shop_id → batch fetch détail
  // On le fait en parallèle par lots de 10 pour rester dans les limites
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < Math.min(listings.length, limit); i += BATCH) {
    const batch = listings.slice(i, i + BATCH);
    const details = await Promise.allSettled(
      batch.map(l => fetchListingDetail(l.listing_id))
    );
    for (let j = 0; j < batch.length; j++) {
      const l = batch[j];
      const d = details[j];
      if (d.status === 'fulfilled' && d.value) {
        results.push({
          listingId: l.listing_id,
          shopId:    d.value.shop_id    || null,
          title:     d.value.name       || l.name || null,
          link:      d.value.url        || `https://www.etsy.com/listing/${l.listing_id}`,
        });
      } else {
        // En cas d'échec on pousse quand même sans shopId
        results.push({
          listingId: l.listing_id,
          shopId:    null,
          title:     l.name || null,
          link:      `https://www.etsy.com/listing/${l.listing_id}`,
        });
      }
    }
  }

  return results;
}

// Alias pour compatibilité
async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

// ── fetchListingDetail (interne) ──────────────────────────────────────────────
/**
 * Récupère les 20+ champs d'un listing via omkar.cloud/etsy/listing
 */
async function fetchListingDetail(listingId) {
  await rateWait(250);
  const r = await axios.get(`${BASE}/etsy/listing`, {
    params:  { listing_id: listingId },
    headers: headers(),
    timeout: 15000,
  });
  return r.data || null;
}

// ── getShopNameAndImage ───────────────────────────────────────────────────────
/**
 * Même signature que etsyApi.js :
 *   getShopNameAndImage(shopId, listingId, listingId2, listingId3, listingId4)
 * → { shopName, shopUrl, image, image2, image3, image4 }
 *
 * omkar.cloud n'a pas d'endpoint /shop — on récupère shopName + images
 * directement depuis les détails de chaque listing.
 */
async function getShopNameAndImage(shopId, listingId, listingId2 = null, listingId3 = null, listingId4 = null) {
  const ids = [listingId, listingId2, listingId3, listingId4];

  // Fetch tous les listings en parallèle
  const fetched = await Promise.allSettled(
    ids.map(id => id ? fetchListingDetail(id) : Promise.resolve(null))
  );

  const data = fetched.map(r => r.status === 'fulfilled' ? r.value : null);
  const [d1, d2, d3, d4] = data;

  // shopName vient du premier listing disponible
  const shopName = d1?.shop_name || d2?.shop_name || d3?.shop_name || d4?.shop_name || null;
  const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;

  const image  = d1 ? cleanImage(d1.full_image_url || d1.thumbnail_url || null) : null;
  const image2 = d2 ? cleanImage(d2.full_image_url || d2.thumbnail_url || null) : null;
  const image3 = d3 ? cleanImage(d3.full_image_url || d3.thumbnail_url || null) : null;
  const image4 = d4 ? cleanImage(d4.full_image_url || d4.thumbnail_url || null) : null;

  console.log('[omkarApi] getShopNameAndImage:', shopName,
    '| image1:', !!image, '| image2:', !!image2,
    '| image3:', !!image3, '| image4:', !!image4);

  return { shopName, shopUrl, image, image2, image3, image4 };
}

// ── getShopListings ───────────────────────────────────────────────────────────
/**
 * Même signature que etsyApi.js : getShopListings(shopIdOrName, limit)
 * → [{ listingId, link, image, shopName, shopUrl, ... }]
 *
 * omkar.cloud n'a pas d'endpoint /shop/listings — on fait une recherche
 * par nom de boutique et on filtre les résultats.
 */
async function getShopListings(shopIdOrName, limit = 5) {
  await rateWait(400);
  // Chercher les listings de cette boutique via keyword = shop name
  const r = await axios.get(`${BASE}/etsy/search`, {
    params:  { keyword: String(shopIdOrName) },
    headers: headers(),
    timeout: 20000,
  });

  const all = r.data.listings || [];
  // Fetch les détails des premiers listings pour obtenir les images
  const candidates = all.slice(0, limit * 2);
  const details = await Promise.allSettled(
    candidates.map(l => fetchListingDetail(l.listing_id))
  );

  const results = [];
  for (let i = 0; i < details.length && results.length < limit; i++) {
    const d = details[i];
    if (d.status !== 'fulfilled' || !d.value) continue;
    const item = d.value;
    // Filtre : ne garder que les listings de cette boutique si on a le shop_name
    if (item.shop_name &&
        String(shopIdOrName).toLowerCase() !== String(item.shop_name).toLowerCase() &&
        String(shopIdOrName) !== String(item.shop_id)) continue;

    results.push(normalizeListing(item));
  }

  return results;
}

// ── getShopInfo ───────────────────────────────────────────────────────────────
/**
 * Même signature que etsyApi.js : getShopInfo(shopIdOrName)
 * → { shopId, shopName, shopUrl, shopAvatar, title, numSales }
 *
 * omkar.cloud n'a pas d'endpoint shop — on retourne ce qu'on peut
 * sans faire de requête supplémentaire.
 */
async function getShopInfo(shopIdOrName) {
  return {
    shopId:     null,
    shopName:   String(shopIdOrName),
    shopUrl:    `https://www.etsy.com/shop/${shopIdOrName}`,
    shopAvatar: null,
    title:      String(shopIdOrName),
    numSales:   0,
  };
}

// ── getListingDetail ──────────────────────────────────────────────────────────
/**
 * Même signature que etsyApi.js : getListingDetail(listingId)
 * → { title, price, images, shopName, shopId }
 */
async function getListingDetail(listingId) {
  const item = await fetchListingDetail(listingId);
  if (!item) return { title: null, price: null, images: [], shopName: null, shopId: null };

  const images = [item.full_image_url, item.thumbnail_url]
    .map(cleanImage)
    .filter(Boolean);

  const price = item.price_usd != null
    ? `USD ${Number(item.price_usd).toFixed(2)}`
    : null;

  console.log('[getListingDetail]', listingId, '| images:', images.length);
  return {
    title:    item.name    || null,
    price,
    images,
    shopName: item.shop_name || null,
    shopId:   item.shop_id   || null,
  };
}

// ── handleEtsyError ───────────────────────────────────────────────────────────
function handleEtsyError(e) {
  const status = e.response?.status;
  // Extrait le vrai message retourné par omkar.cloud dans le body
  const body = e.response?.data;
  const detail = typeof body === 'string'
    ? body.slice(0, 300)
    : body ? JSON.stringify(body).slice(0, 300) : e.message;

  console.error(`[omkarApi] HTTP ${status} — body: ${detail}`);

  if (status === 401) throw new Error(`OMKAR_API_KEY invalide (401) — ${detail}`);
  if (status === 403) throw new Error(`Accès refusé par omkar.cloud (403) — ${detail}`);
  if (status === 429) throw new Error('Quota omkar.cloud dépassé (429) — 5 000 req/mois');
  if (status === 404) throw new Error(`Ressource introuvable (404): ${e.config?.url}`);
  if (status === 400) throw new Error(`omkar.cloud requête invalide (400) — ${detail}`);
  throw new Error(`omkar.cloud API error [${status || e.code}]: ${detail}`);
}

module.exports = {
  searchListings,
  searchListingIds,
  getShopNameAndImage,
  getShopListings,
  getShopInfo,
  getListingDetail,
  normalizeListing,
  handleEtsyError,
};
