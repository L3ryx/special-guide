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
 * /listings/active ne renvoie PAS images ni shop_name inline.
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
 * Pour un shop_id : récupère shop_name + 2 images via getListingDetail.
 * listingId + listingId2 = deux listings connus de cette boutique.
 */
async function getShopNameAndImage(shopId, listingId, listingId2 = null) {
  // 1. Nom de boutique
  const shopRes = await axios.get(`${BASE}/shops/${shopId}`, {
    headers: headers(), timeout: 15000,
  });
  const shop     = shopRes.data;
  const shopName = shop.shop_name;
  const shopUrl  = `https://www.etsy.com/shop/${shopName}`;

  // 2. Image 1 via /listings/{id}?includes=images
  let image = null;
  if (listingId) {
    try {
      const r = await axios.get(`${BASE}/listings/${listingId}?includes=images`, {
        headers: headers(), timeout: 15000,
      });
      const item = r.data;
      image = cleanImage(
        item.images?.[0]?.url_fullxfull ||
        item.images?.[0]?.url_570xN ||
        item.images?.[0]?.url_170x135 ||
        null
      );
    } catch(e) {
      console.warn('[etsyApi] image1 failed for listing', listingId, ':', e.message);
    }
  }

  // 3. Image 2 via second listing
  let image2 = null;
  if (listingId2) {
    try {
      const r = await axios.get(`${BASE}/listings/${listingId2}?includes=images`, {
        headers: headers(), timeout: 15000,
      });
      const item = r.data;
      image2 = cleanImage(
        item.images?.[0]?.url_fullxfull ||
        item.images?.[0]?.url_570xN ||
        item.images?.[0]?.url_170x135 ||
        null
      );
    } catch(e) {
      console.warn('[etsyApi] image2 failed for listing', listingId2, ':', e.message);
    }
  }

  console.log('[etsyApi] getShopNameAndImage:', shopName, '| image1:', !!image, '| image2:', !!image2);
  return { shopName, shopUrl, image, image2 };
}

async function getShopListings(shopIdOrName, limit = 20) {
  const r = await axios.get(
    `${BASE}/shops/${encodeURIComponent(shopIdOrName)}/listings/active?limit=${Math.min(limit, 100)}&includes=images`,
    { headers: headers(), timeout: 30000 }
  );

  const results = r.data.results || [];
  const resolvedShopName = typeof shopIdOrName === 'string' && isNaN(shopIdOrName) ? shopIdOrName : null;
  return results.map(item => normalizeListing(item, resolvedShopName));
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
  const r = await axios.get(`${BASE}/listings/${listingId}?includes=images%2Cshop`, {
    headers: headers(), timeout: 30000,
  });

  const item = r.data;
  const images = (item.images || [])
    .map(img => cleanImage(img.url_fullxfull || img.url_570xN || null))
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


