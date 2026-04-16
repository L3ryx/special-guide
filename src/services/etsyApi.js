/**
 * etsyApi.js
 * Remplace les appels à l'API officielle Etsy v3 par des appels
 * au microservice Python Scrapling (scrapling_service/app.py).
 *
 * URL du microservice : variable d'env SCRAPLING_SERVICE_URL
 * (défaut : http://localhost:5001)
 */

const axios = require('axios');

function serviceUrl() {
  return (process.env.SCRAPLING_SERVICE_URL || 'http://localhost:5001').replace(/\/$/, '');
}

async function call(endpoint, body = {}) {
  const url = `${serviceUrl()}${endpoint}`;
  try {
    const r = await axios.post(url, body, { timeout: 60000 });
    return r.data;
  } catch (e) {
    const status = e.response?.status;
    const msg    = e.response?.data?.error || e.message;
    throw new Error(`Scrapling service error [${status || e.code}] on ${endpoint}: ${msg}`);
  }
}

// ── Helpers identiques à l'ancien etsyApi.js ─────────────────────────────────

function cleanImage(url) {
  if (!url) return null;
  return url.split('?')[0];
}

function normalizeListing(item, shopName = null, shopUrl = null) {
  const image = item.image || null;
  const resolvedShop = shopName || item.shopName || null;
  const resolvedUrl  = shopUrl || (resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null);

  return {
    title:     item.title || null,
    link:      item.link || `https://www.etsy.com/listing/${item.listingId}`,
    image:     cleanImage(image),
    source:    'etsy',
    shopName:  resolvedShop,
    shopUrl:   resolvedUrl,
    price:     item.price || null,
    listingId: item.listingId || null,
    shopId:    item.shopId || null,
  };
}

// ── API publique (même signature que l'ancien etsyApi.js) ─────────────────────

async function searchListingIds(keyword, limit = 100, offset = 0) {
  const results = await call('/search', { keyword, limit, offset });
  if (!Array.isArray(results)) throw new Error('Scrapling /search: unexpected response');
  console.log('[etsyApi→scrapling] searchListingIds:', results.length, 'results | keyword:', keyword, '| offset:', offset);
  return results.map(item => ({
    listingId: item.listingId,
    shopId:    item.shopId || null,
    title:     item.title  || null,
    link:      item.link   || `https://www.etsy.com/listing/${item.listingId}`,
  }));
}

async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

async function getShopNameAndImage(shopId, listingId, listingId2 = null, listingId3 = null, listingId4 = null) {
  const data = await call('/shop-info', { shopName: String(shopId) });

  console.log('[etsyApi→scrapling] getShopNameAndImage:', data.shopName,
    '| image1:', !!data.image, '| image2:', !!data.image2,
    '| image3:', !!data.image3, '| image4:', !!data.image4);

  return {
    shopName: data.shopName,
    shopUrl:  data.shopUrl,
    image:    cleanImage(data.image),
    image2:   cleanImage(data.image2),
    image3:   cleanImage(data.image3),
    image4:   cleanImage(data.image4),
  };
}

async function getShopListings(shopIdOrName, limit = 20) {
  const results = await call('/shop-listings', { shopName: String(shopIdOrName), limit });
  if (!Array.isArray(results)) throw new Error('Scrapling /shop-listings: unexpected response');
  return results.map(item => normalizeListing(item));
}

async function getShopInfo(shopIdOrName) {
  const data = await call('/shop-info', { shopName: String(shopIdOrName) });
  return {
    shopId:     data.shopId    || null,
    shopName:   data.shopName,
    shopUrl:    data.shopUrl,
    shopAvatar: cleanImage(data.shopAvatar || null),
    title:      data.title     || null,
    numSales:   data.numSales  || 0,
  };
}

async function getListingDetail(listingId) {
  const data = await call('/listing-detail', { listingId });
  console.log('[etsyApi→scrapling] getListingDetail', listingId, '| images:', data.images?.length);
  return {
    title:    data.title    || null,
    price:    data.price    || null,
    images:   (data.images || []).map(cleanImage).filter(Boolean).slice(0, 5),
    shopName: data.shopName || null,
    shopId:   data.shopId   || null,
  };
}

function handleEtsyError(e) {
  throw e;
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
