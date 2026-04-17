'use strict';

const axios = require('axios');

const BASE = 'https://etsy-scraper.omkar.cloud';

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

function normalizeListing(item, shopName = null, shopUrl = null) {
  const resolvedShop = shopName || item.shop?.name || item.shop_name || null;
  const resolvedUrl  = shopUrl  || (resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null);
  const image = cleanImage(item.images?.full || item.full_image_url || item.thumbnail_url || null);
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
    shopId:    item.shop?.shop_id || item.shop_id || null,
  };
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
let _lastCall = 0;
async function rateWait(minMs = 300) {
  const elapsed = Date.now() - _lastCall;
  if (elapsed < minMs) await new Promise(r => setTimeout(r, minMs - elapsed));
  _lastCall = Date.now();
}

// ── fetchListingDetail (interne) ──────────────────────────────────────────────
// /etsy/listing retourne les champs complets : shop.shop_id, shop.name, images.full, etc.
async function fetchListingDetail(listingId) {
  await rateWait(250);
  const r = await axios.get(`${BASE}/etsy/listing`, {
    params:  { listing_id: listingId },
    headers: headers(),
    timeout: 15000,
  });
  return r.data || null;
}

// ── searchListingIds ──────────────────────────────────────────────────────────
// CORRECTIF : /etsy/search retourne UNIQUEMENT listing_id + name (pas shop_id ni shop_name).
// On fetch /etsy/listing en parallèle (par batch) pour résoudre shop_id, shop_name et images.
// Paramètres : limit = 70 listings par appel, 5 pages max dans fetchListingsForDropship.
async function searchListingIds(keyword, limit = 70, offset = 0) {
  await rateWait(400);

  const r = await axios.get(`${BASE}/etsy/search`, {
    params:  { keyword },
    headers: headers(),
    timeout: 30000,
  });

  const listings = r.data.listings || [];
  console.log('[omkarApi] searchListingIds raw:', listings.length, 'results | keyword:', keyword);

  const subset = listings.slice(0, limit);

  // Résolution des détails en parallèle par batch de 10 pour éviter le rate limit
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < subset.length; i += BATCH) {
    const batch = subset.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(
      batch.map(async (l) => {
        const detail = await fetchListingDetail(l.listing_id);
        return {
          listingId: l.listing_id,
          shopId:    detail?.shop?.shop_id  || null,
          shopName:  detail?.shop?.name     || null,
          title:     detail?.name           || l.name || null,
          link:      detail?.url            || `https://www.etsy.com/listing/${l.listing_id}`,
          // On stocke aussi les images pour éviter des appels redondants plus tard
          image:     cleanImage(detail?.images?.full || detail?.images?.thumbnail || null),
        };
      })
    );

    for (const res of resolved) {
      if (res.status === 'fulfilled') results.push(res.value);
      else console.warn('[omkarApi] fetchListingDetail failed:', res.reason?.message);
    }
  }

  console.log('[omkarApi] shopIds non-nuls:', results.filter(r => r.shopId).length, '/', results.length);
  return results;
}

async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

// ── getShopNameAndImage ───────────────────────────────────────────────────────
// Récupère shopName + images via /etsy/listing.
// Utilise les champs shop.name et images.full retournés par l'API.
async function getShopNameAndImage(shopId, listingId, listingId2 = null, listingId3 = null, listingId4 = null) {
  const ids = [listingId, listingId2, listingId3, listingId4];

  const fetched = await Promise.allSettled(
    ids.map(id => id ? fetchListingDetail(id) : Promise.resolve(null))
  );

  const data = fetched.map(r => r.status === 'fulfilled' ? r.value : null);
  const [d1, d2, d3, d4] = data;

  // shop_name est dans shop.name selon la doc Omkar
  const shopName =
    d1?.shop?.name || d2?.shop?.name || d3?.shop?.name || d4?.shop?.name ||
    d1?.shop_name  || d2?.shop_name  || d3?.shop_name  || d4?.shop_name  || null;

  const shopUrl = shopName ? `https://www.etsy.com/shop/${shopName}` : null;

  // images sont dans images.full ou images.thumbnail selon la doc Omkar
  const image  = d1 ? cleanImage(d1.images?.full || d1.images?.thumbnail || d1.full_image_url || d1.thumbnail_url || null) : null;
  const image2 = d2 ? cleanImage(d2.images?.full || d2.images?.thumbnail || d2.full_image_url || d2.thumbnail_url || null) : null;
  const image3 = d3 ? cleanImage(d3.images?.full || d3.images?.thumbnail || d3.full_image_url || d3.thumbnail_url || null) : null;
  const image4 = d4 ? cleanImage(d4.images?.full || d4.images?.thumbnail || d4.full_image_url || d4.thumbnail_url || null) : null;

  console.log('[omkarApi] getShopNameAndImage:', shopName,
    '| image1:', !!image, '| image2:', !!image2);

  return { shopName, shopUrl, image, image2, image3, image4 };
}

// ── getShopListings ───────────────────────────────────────────────────────────
// Recherche par nom de boutique, récupère les détails pour avoir les images.
async function getShopListings(shopIdOrName, limit = 5) {
  await rateWait(400);
  const r = await axios.get(`${BASE}/etsy/search`, {
    params:  { keyword: String(shopIdOrName) },
    headers: headers(),
    timeout: 20000,
  });

  const all = r.data.listings || [];
  const candidates = all.slice(0, limit * 2);
  const details = await Promise.allSettled(
    candidates.map(l => fetchListingDetail(l.listing_id))
  );

  const results = [];
  for (let i = 0; i < details.length && results.length < limit; i++) {
    const d = details[i];
    if (d.status !== 'fulfilled' || !d.value) continue;
    const item = d.value;
    // Compatibilité ancienne structure (shop_name) et nouvelle (shop.name)
    const itemShopName = item.shop?.name || item.shop_name || null;
    const itemShopId   = item.shop?.shop_id || item.shop_id || null;
    if (itemShopName &&
        String(shopIdOrName).toLowerCase() !== String(itemShopName).toLowerCase() &&
        String(shopIdOrName) !== String(itemShopId)) continue;
    results.push(normalizeListing(item));
  }

  return results;
}

// ── getShopInfo ───────────────────────────────────────────────────────────────
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
async function getListingDetail(listingId) {
  const item = await fetchListingDetail(listingId);
  if (!item) return { title: null, price: null, images: [], shopName: null, shopId: null };

  // Compatibilité ancienne structure et nouvelle structure Omkar
  const images = [
    item.images?.full,
    item.images?.thumbnail,
    item.full_image_url,
    item.thumbnail_url,
  ].map(cleanImage).filter(Boolean);

  const price = item.price_usd != null
    ? `USD ${Number(item.price_usd).toFixed(2)}`
    : null;

  return {
    title:    item.name                               || null,
    price,
    images,
    shopName: item.shop?.name     || item.shop_name  || null,
    shopId:   item.shop?.shop_id  || item.shop_id    || null,
  };
}

// ── handleEtsyError ───────────────────────────────────────────────────────────
function handleEtsyError(e) {
  const status = e.response?.status;
  const body   = e.response?.data;
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
