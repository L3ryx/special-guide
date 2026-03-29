/**
 * etsyApi.js
 * Wrapper pour l'API officielle Etsy v3 (Open API)
 */

const axios = require('axios');

const BASE = 'https://openapi.etsy.com/v3/application';

function getKey() {
  const id     = process.env.ETSY_CLIENT_ID;
  const secret = process.env.ETSY_CLIENT_SECRET;
  if (!id) throw new Error('ETSY_CLIENT_ID not configured');
  return secret ? `${id}:${secret}` : id;
}

function headers(accessToken = null) {
  const h = { 'x-api-key': getKey() };
  if (accessToken) h['Authorization'] = 'Bearer ' + accessToken;
  return h;
}

function cleanImage(url) {
  if (!url) return null;
  return url.split('?')[0];
}

// Format URL image Etsy valide : recupere l'image via l'endpoint listing direct
// On ne construit plus d'URL CDN — on appelle getListingDetail pour avoir les vraies images
function normalizeListing(item, shopName = null) {
  const image =
    item.images?.[0]?.url_fullxfull ||
    item.images?.[0]?.url_570xN ||
    item.images?.[0]?.url_170x135 ||
    null; // pas de fallback CDN — sera recupere via getShopListings qui inclut les images

  const price = item.price
    ? `${item.price.currency_code} ${(item.price.amount / item.price.divisor).toFixed(2)}`
    : null;

  const shopId = item.shop_id || item.shop?.shop_id || null;
  const resolvedShop = shopName || item.shop?.shop_name || (shopId ? String(shopId) : null);

  return {
    title:    item.title || null,
    link:     `https://www.etsy.com/listing/${item.listing_id}`,
    image:    cleanImage(image),
    source:   'etsy',
    shopName: resolvedShop,
    shopUrl:  item.shop?.shop_name
      ? `https://www.etsy.com/shop/${item.shop.shop_name}`
      : (shopId ? `https://www.etsy.com/shop?shop_id=${shopId}` : null),
    price,
    listingId: item.listing_id,
    shopId,
  };
}

async function searchListings(keyword, limit = 25, offset = 0) {
  const qs = new URLSearchParams({
    keywords:   keyword,
    limit:      String(Math.min(limit, 100)),
    offset:     String(offset),
    sort_on:    'score',
    sort_order: 'desc',
  });
  qs.append('includes', 'images');
  qs.append('includes', 'shop');

  const r = await axios.get(`${BASE}/listings/active?${qs.toString()}`, {
    headers: headers(), // pas besoin d'OAuth pour la recherche publique
    timeout: 30000,
  });

  const results = r.data.results || [];
  if (results.length > 0) {
    const s = results[0];
    const norm = normalizeListing(s);
    console.log('[etsyApi] page results:', results.length, '| shop_id:', s.shop_id, '| image:', !!norm.image, '| shopName:', norm.shopName);
  } else {
    console.log('[etsyApi] 0 results for keyword:', keyword);
  }
  return results.map(item => normalizeListing(item));
}

async function getShopListings(shopIdOrName, limit = 20, accessToken = null) {
  const qs = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
  qs.append('includes', 'images');

  const r = await axios.get(`${BASE}/shops/${encodeURIComponent(shopIdOrName)}/listings/active?${qs.toString()}`, {
    headers: headers(accessToken),
    timeout: 30000,
  });

  const results = r.data.results || [];
  const resolvedShopName = typeof shopIdOrName === 'string' && isNaN(shopIdOrName) ? shopIdOrName : null;
  return results.map(item => normalizeListing(item, resolvedShopName));
}

async function getShopInfo(shopIdOrName, accessToken = null) {
  const r = await axios.get(`${BASE}/shops/${encodeURIComponent(shopIdOrName)}`, {
    headers: headers(accessToken),
    timeout: 30000,
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

async function getListingDetail(listingId, accessToken = null) {
  const qs = new URLSearchParams();
  qs.append('includes', 'images');
  qs.append('includes', 'shop');

  const r = await axios.get(`${BASE}/listings/${listingId}?${qs.toString()}`, {
    headers: headers(accessToken),
    timeout: 30000,
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
  const qs = new URLSearchParams({
    keywords:   keyword,
    limit:      String(Math.min(limit, 100)),
    offset:     String(offset),
    sort_on:    'score',
    sort_order: 'desc',
  });
  qs.append('includes', 'images');
  qs.append('includes', 'shop');

  const r = await axios.get(`${BASE}/listings/active?${qs.toString()}`, {
    headers: headers(),
    timeout: 30000,
  });

  const results = r.data.results || [];
  if (results.length > 0) {
    const s = results[0];
    const norm = normalizeListing(s);
    console.log('[etsyApi] page results:', results.length, '| shop_id:', s.shop_id, '| image:', !!norm.image, '| shopName:', norm.shopName);
  } else {
    console.log('[etsyApi] 0 results for keyword:', keyword);
  }
  return results.map(item => normalizeListing(item));
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
  getShopListings,
  getShopInfo,
  getListingDetail,
  normalizeListing,
  handleEtsyError,
};


