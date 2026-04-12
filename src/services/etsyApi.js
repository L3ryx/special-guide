/**
 * etsyApi.js
 * Wrapper pour l'API officielle Etsy v3
 *
 * Stratégie :
 *  - /listings/active                              → listing_id + shop_id (pas d'images ni shop_name)
 *  - /shops/{shopId}                               → shop_name
 *  - /shops/{shopId}/listings/active?includes=images → images
 */

const axios = require('axios');

const BASE = 'https://api.etsy.com/v3/application';

function getKey() {
  const id     = process.env.ETSY_CLIENT_ID;
  const secret = process.env.ETSY_CLIENT_SECRET;
  if (!id) throw new Error('ETSY_CLIENT_ID not configured');
  return secret ? `${id}:${secret}` : id;
}

function headers() {
  return { 'x-api-key': getKey() };
}

function cleanImage(url) {
  if (!url) return null;
  return url.split('?')[0];
}

function normalizeListing(item, shopName = null, shopUrl = null) {
  const image =
    item.images?.[0]?.url_fullxfull ||
    item.images?.[0]?.url_570xN ||
    item.images?.[0]?.url_170x135 ||
    null;

  const price = item.price
    ? `${item.price.currency_code} ${(item.price.amount / item.price.divisor).toFixed(2)}`
    : null;

  const shopId = item.shop_id || item.shop?.shop_id || null;
  const resolvedShop = shopName || item.shop?.shop_name || null;
  const resolvedUrl  = shopUrl || (resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null);

  return {
    title:    item.title || null,
    link:     `https://www.etsy.com/listing/${item.listing_id}`,
    image:    cleanImage(image),
    source:   'etsy',
    shopName: resolvedShop,
    shopUrl:  resolvedUrl,
    price,
    listingId: item.listing_id,
    shopId,
  };
}

/**
 * Recherche — retourne uniquement listing_id, shop_id, title, link.
 */
async function searchListingIds(keyword, limit = 100, offset = 0) {
  const qs = new URLSearchParams({
    keywords:   keyword,
    limit:      String(Math.min(limit, 100)),
    offset:     String(offset),
    sort_on:    'score',
    sort_order: 'desc',
  });

  const r = await axios.get(`${BASE}/listings/active?${qs.toString()}`, {
    headers: headers(),
    timeout: 30000,
  });

  const results = r.data.results || [];
  console.log('[etsyApi] searchListingIds:', results.length, 'results | keyword:', keyword, '| offset:', offset);
  return results.map(item => ({
    listingId: item.listing_id,
    shopId:    item.shop_id || null,
    title:     item.title || null,
    link:      `https://www.etsy.com/listing/${item.listing_id}`,
  }));
}

// Alias pour compatibilité avec l'ancien code
async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

/**
 * Pour un shop_id : récupère shop_name + 3 images de listings différents.
 *
 * Stratégie :
 *  - Image 1 : première image du listing trouvé dans la recherche Etsy (listingId)
 *  - Images 2 & 3 : première image de 2 autres listings actifs de la boutique
 *
 * Les 3 images sont ensuite testées sur AliExpress via Serper Lens.
 * Si la boutique a moins de 3 listings, on retourne ce qu'on a.
 */
async function getShopNameAndImage(shopId, listingId) {
  // 1. Nom de boutique
  const shopRes = await axios.get(`${BASE}/shops/${shopId}`, {
    headers: headers(), timeout: 15000,
  });
  const shop     = shopRes.data;
  const shopName = shop.shop_name;
  const shopUrl  = `https://www.etsy.com/shop/${shopName}`;

  const images = [];

  // Image 1 : première image du listing de l'annonce trouvée dans la recherche
  if (listingId) {
    try {
      const r = await axios.get(`${BASE}/listings/${listingId}?includes=images`, {
        headers: headers(), timeout: 15000,
      });
      const img = cleanImage(
        r.data.images?.[0]?.url_fullxfull ||
        r.data.images?.[0]?.url_570xN ||
        r.data.images?.[0]?.url_170x135 ||
        null
      );
      if (img) images.push(img);
      console.log('[etsyApi] image1 (listing', listingId, '):', !!img);
    } catch(e) {
      console.warn('[etsyApi] image1 failed for listing', listingId, ':', e.message);
    }
  }

  // Images 2 & 3 : premières images de 2 autres listings actifs de la boutique
  try {
    const r = await axios.get(
      `${BASE}/shops/${shopId}/listings/active?limit=10&includes=images`,
      { headers: headers(), timeout: 15000 }
    );
    const results = r.data.results || [];
    for (const item of results) {
      if (images.length >= 3) break;
      if (String(item.listing_id) === String(listingId)) continue; // déjà en image 1
      const img = cleanImage(
        item.images?.[0]?.url_fullxfull ||
        item.images?.[0]?.url_570xN ||
        item.images?.[0]?.url_170x135 ||
        null
      );
      if (img && !images.includes(img)) {
        images.push(img);
        console.log('[etsyApi] image' + images.length + ' (listing', item.listing_id, '):', !!img);
      }
    }
  } catch(e) {
    console.warn('[etsyApi] shop listings failed for shop', shopId, ':', e.message);
  }

  const image = images[0] || null;
  console.log('[etsyApi] getShopNameAndImage:', shopName, '| total images:', images.length);
  return { shopName, shopUrl, image, images };
}

/**
 * Récupère les listings d'une boutique.
 * L'API Etsy v3 n'accepte que des shop_id numériques pour ce endpoint.
 * Si un nom est fourni, on résout d'abord via /shops?shop_name=
 */
async function getShopListings(shopIdOrName, limit = 20) {
  let shopId   = shopIdOrName;
  let shopName = null;

  if (isNaN(shopIdOrName)) {
    // Résoudre le nom → shop_id numérique
    const infoRes = await axios.get(
      `${BASE}/shops?shop_name=${encodeURIComponent(shopIdOrName)}`,
      { headers: headers(), timeout: 15000 }
    );
    const found = infoRes.data.results || [];
    if (!found.length) throw new Error(`Shop "${shopIdOrName}" introuvable sur Etsy`);
    shopId   = found[0].shop_id;
    shopName = found[0].shop_name;
  }

  const r = await axios.get(
    `${BASE}/shops/${shopId}/listings/active?limit=${Math.min(limit, 100)}&includes=images`,
    { headers: headers(), timeout: 30000 }
  );

  const results = r.data.results || [];
  return results.map(item => normalizeListing(item, shopName));
}

async function getShopInfo(shopIdOrName) {
  const r = await axios.get(`${BASE}/shops/${encodeURIComponent(shopIdOrName)}`, {
    headers: headers(), timeout: 30000,
  });
  const s = r.data;
  return {
    shopId:     s.shop_id,
    shopName:   s.shop_name,
    shopUrl:    `https://www.etsy.com/shop/${s.shop_name}`,
    shopAvatar: cleanImage(s.icon_url_fullxfull || s.icon_url || null),
    title:      s.title || null,
    numSales:   s.num_sales || 0,
  };
}

async function getListingDetail(listingId) {
  const r = await axios.get(`${BASE}/listings/${listingId}?includes=images`, {
    headers: headers(), timeout: 30000,
  });

  const item = r.data;
  console.log('[getListingDetail]', listingId, '| images in response:', item.images?.length, '| keys:', Object.keys(item).join(','));
  const images = (item.images || [])
    .map(img => cleanImage(img.url_fullxfull || img.url_570xN || img.url_170x135 || null))
    .filter(Boolean)
    .slice(0, 5);

  const price = item.price
    ? `${item.price.currency_code} ${(item.price.amount / item.price.divisor).toFixed(2)}`
    : null;

  return {
    title:    item.title || null,
    price,
    images,
    shopName: item.shop?.shop_name || null,
    shopId:   item.shop_id || null,
  };
}

function handleEtsyError(e) {
  const status = e.response?.status;
  if (status === 401) throw new Error('ETSY_CLIENT_ID invalide (401)');
  if (status === 403) throw new Error("Acces refuse par l'API Etsy (403)");
  if (status === 429) throw new Error('Quota API Etsy depasse (429)');
  if (status === 404) throw new Error(`Ressource Etsy introuvable (404): ${e.config?.url}`);
  throw new Error(`Etsy API error [${status || e.code}]: ${e.message}`);
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




