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
  const resolvedShop = shopName || item.shop_name || null;
  const resolvedUrl  = shopUrl  || (resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null);
  const image = cleanImage(item.full_image_url || item.thumbnail_url || null);
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

// ── Rate limiter ──────────────────────────────────────────────────────────────
let _lastCall = 0;
async function rateWait(minMs = 300) {
  const elapsed = Date.now() - _lastCall;
  if (elapsed < minMs) await new Promise(r => setTimeout(r, minMs - elapsed));
  _lastCall = Date.now();
}

// ── searchListingIds ──────────────────────────────────────────────────────────
// omkar /etsy/search retourne directement shop_id et shop_name dans chaque listing.
// On n'a PAS besoin de fetch /etsy/listing pour obtenir le shop_id.
// L'API n'accepte pas de paramètre "page".
async function searchListingIds(keyword, limit = 100, offset = 0) {
  await rateWait(400);

  const r = await axios.get(`${BASE}/etsy/search`, {
    params:  { keyword },
    headers: headers(),
    timeout: 30000,
  });

  const listings = r.data.listings || [];
  console.log('[omkarApi] searchListingIds:', listings.length,
    'results | keyword:', keyword);

  // Les résultats de /etsy/search contiennent déjà listing_id, name,
  // shop_id et shop_name — pas besoin d'appels supplémentaires.
  const results = listings.slice(0, limit).map(l => ({
    listingId: l.listing_id,
    shopId:    l.shop_id   || null,
    shopName:  l.shop_name || null,
    title:     l.name      || null,
    link:      l.url       || `https://www.etsy.com/listing/${l.listing_id}`,
  }));

  console.log('[omkarApi] shopIds non-nuls:', results.filter(r => r.shopId).length);
  return results;
}

async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

// ── fetchListingDetail (interne) ──────────────────────────────────────────────
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
// Récupère shopName + 2 images via /etsy/listing pour chaque listing fourni.
async function getShopNameAndImage(shopId, listingId, listingId2 = null, listingId3 = null, listingId4 = null) {
  const ids = [listingId, listingId2, listingId3, listingId4];

  const fetched = await Promise.allSettled(
    ids.map(id => id ? fetchListingDetail(id) : Promise.resolve(null))
  );

  const data = fetched.map(r => r.status === 'fulfilled' ? r.value : null);
  const [d1, d2, d3, d4] = data;

  const shopName = d1?.shop_name || d2?.shop_name || d3?.shop_name || d4?.shop_name || null;
  const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;

  const image  = d1 ? cleanImage(d1.full_image_url || d1.thumbnail_url || null) : null;
  const image2 = d2 ? cleanImage(d2.full_image_url || d2.thumbnail_url || null) : null;
  const image3 = d3 ? cleanImage(d3.full_image_url || d3.thumbnail_url || null) : null;
  const image4 = d4 ? cleanImage(d4.full_image_url || d4.thumbnail_url || null) : null;

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
    if (item.shop_name &&
        String(shopIdOrName).toLowerCase() !== String(item.shop_name).toLowerCase() &&
        String(shopIdOrName) !== String(item.shop_id)) continue;
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

  const images = [item.full_image_url, item.thumbnail_url]
    .map(cleanImage)
    .filter(Boolean);

  const price = item.price_usd != null
    ? `USD ${Number(item.price_usd).toFixed(2)}`
    : null;

  return {
    title:    item.name      || null,
    price,
    images,
    shopName: item.shop_name || null,
    shopId:   item.shop_id   || null,
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
