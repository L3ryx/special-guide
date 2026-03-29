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

function headers() {
  return { 'x-api-key': getKey() };
}

function cleanImage(url) {
  if (!url) return null;
  return url.split('?')[0];
}

// L'API Etsy /listings/active n'inclut jamais les images dans les résultats de recherche.
// On construit l'URL image directement depuis le listing_id via le CDN Etsy (format stable).
function buildEtsyImageUrl(listingId) {
  if (!listingId) return null;
  return `https://i.etsystatic.com/iap/listing/${listingId}/f_auto,fl_progressive,q_auto,c_limit,w_570,h_570/listing.jpg`;
}

function normalizeListing(item, shopName = null) {
  // Priorité : images retournées par l'API, sinon URL CDN construite depuis listing_id
  const image =
    item.images?.[0]?.url_fullxfull ||
    item.images?.[0]?.url_570xN ||
    item.images?.[0]?.url_170x135 ||
    buildEtsyImageUrl(item.listing_id);

  const price = item.price
    ? `${item.price.currency_code} ${(item.price.amount / item.price.divisor).toFixed(2)}`
    : null;

  const shopId = item.shop_id || item.shop?.shop_id || null;
  // shop_name rarement retourné dans /listings/active — shop_id utilisé comme identifiant temporaire
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
    headers: headers(),
    timeout: 30000,
  });

  const results = r.data.results || [];
  if (results.length > 0) {
    const s = results[0];
    const norm = normalizeListing(s);
    console.log('[etsyApi] page results:', results.length, '| shop_id:', s.shop_id, '| image built:', !!norm.image, '| shopName:', norm.shopName);
  } else {
    console.log('[etsyApi] 0 results for keyword:', keyword);
  }
  return results.map(item => normalizeListing(item));
}

async function getShopListings(shopIdOrName, limit = 20) {
  const qs = new URLSearchParams({
    limit: String(Math.min(limit, 100)),
  });
  qs.append('includes', 'images');
  qs.append('includes', 'Shop');

  const r = await axios.get(`${BASE}/shops/${encodeURIComponent(shopIdOrName)}/listings/active?${qs.toString()}`, {
    headers: headers(),
    timeout: 30000,
  });

  const results = r.data.results || [];
  const resolvedShopName = results[0]?.shop?.shop_name
    || (typeof shopIdOrName === 'string' && isNaN(shopIdOrName) ? shopIdOrName : null);
  return results.map(item => normalizeListing(item, resolvedShopName));
}

async function getShopInfo(shopIdOrName) {
  const isNumericId = !isNaN(shopIdOrName) && String(shopIdOrName).length > 4;
  let r;
  if (isNumericId) {
    r = await axios.get(`${BASE}/shops`, {
      headers: headers(),
      params: { shop_id: shopIdOrName },
      timeout: 30000,
    });
    const shops = r.data.results || r.data.shops || [];
    const s = shops[0] || r.data;
    return {
      shopId:     s.shop_id,
      shopName:   s.shop_name,
      shopUrl:    `https://www.etsy.com/shop/${s.shop_name}`,
      shopAvatar: cleanImage(s.icon_url_fullxfull || s.icon_url || null),
      title:      s.title || null,
      numSales:   s.num_sales || 0,
    };
  }
  r = await axios.get(`${BASE}/shops/${encodeURIComponent(shopIdOrName)}`, {
    headers: headers(),
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

async function getListingDetail(listingId) {
  const r = await axios.get(`${BASE}/listings/${listingId}`, {
    headers: headers(),
    params:  { includes: 'images,shop' },
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

function handleEtsyError(e) {
  const status = e.response?.status;
  if (status === 401) throw new Error('ETSY_CLIENT_ID invalide (401)');
  if (status === 403) throw new Error('Accès refusé par l\'API Etsy (403) — vérifiez les permissions de votre clé');
  if (status === 429) throw new Error('Quota API Etsy dépassé (429) — réessayez dans quelques secondes');
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

