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
 * Pour un shop_id : récupère shop_name + 4 images via 4 listing IDs distincts.
 */
async function getShopNameAndImage(shopId, listingId, listingId2 = null, listingId3 = null, listingId4 = null) {
  // 1. Nom de boutique
  const shopRes = await axios.get(`${BASE}/shops/${shopId}`, {
    headers: headers(), timeout: 15000,
  });
  const shop     = shopRes.data;
  const shopName = shop.shop_name;
  const shopUrl  = `https://www.etsy.com/shop/${shopName}`;

  // Helper : fetch 1 image pour un listingId donné
  async function fetchImage(lid, label) {
    if (!lid) return null;
    try {
      const r = await axios.get(`${BASE}/listings/${lid}?includes=images`, {
        headers: headers(), timeout: 15000,
      });
      const item = r.data;
      return cleanImage(
        item.images?.[0]?.url_fullxfull ||
        item.images?.[0]?.url_570xN ||
        item.images?.[0]?.url_170x135 ||
        null
      );
    } catch(e) {
      console.warn(`[etsyApi] ${label} failed for listing`, lid, ':', e.message);
      return null;
    }
  }

  // 2. Récupérer les 4 images en parallèle
  const [image, image2, image3, image4] = await Promise.all([
    fetchImage(listingId,  'image1'),
    fetchImage(listingId2, 'image2'),
    fetchImage(listingId3, 'image3'),
    fetchImage(listingId4, 'image4'),
  ]);

  console.log('[etsyApi] getShopNameAndImage:', shopName,
    '| image1:', !!image, '| image2:', !!image2,
    '| image3:', !!image3, '| image4:', !!image4);
  return { shopName, shopUrl, image, image2, image3, image4 };
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
  // L'API Etsy v3 /shops/{id} n'accepte que des IDs numériques.
  // Si un nom est fourni, on résout d'abord via /shops?shop_name=
  let resolvedId = shopIdOrName;
  if (isNaN(shopIdOrName)) {
    const lookup = await axios.get(
      `${BASE}/shops?shop_name=${encodeURIComponent(shopIdOrName)}`,
      { headers: headers(), timeout: 15000 }
    );
    const found = lookup.data.results || [];
    if (!found.length) throw new Error(`Shop "${shopIdOrName}" introuvable sur Etsy`);
    resolvedId = found[0].shop_id;
  }
  const r = await axios.get(`${BASE}/shops/${resolvedId}`, {
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
  // Étape 1 : récupérer le listing (shop_id est toujours présent dans la réponse v3)
  // Note: includes=shop n'est PAS supporté par l'API Etsy v3 sur /listings/{id}
  const r = await axios.get(`${BASE}/listings/${listingId}?includes=images`, {
    headers: headers(), timeout: 20000,
  });

  const item = r.data;
  const shopId = item.shop_id || null;
  console.log(`[getListingDetail] listing ${listingId} | shop_id: ${shopId}`);

  const images = (item.images || [])
    .map(img => cleanImage(img.url_fullxfull || img.url_570xN || img.url_170x135 || null))
    .filter(Boolean)
    .slice(0, 5);

  const price = item.price
    ? `${item.price.currency_code} ${(item.price.amount / item.price.divisor).toFixed(2)}`
    : null;

  // Étape 2 : résoudre shop_name via /shops/{shop_id} (endpoint fiable)
  let shopName = null;
  if (shopId) {
    try {
      const shopRes = await axios.get(`${BASE}/shops/${shopId}`, {
        headers: headers(), timeout: 15000,
      });
      shopName = shopRes.data.shop_name || null;
      console.log(`[getListingDetail] shop_id ${shopId} → shop_name: ${shopName}`);
    } catch(e) {
      console.warn(`[getListingDetail] /shops/${shopId} failed:`, e.message);
    }
  }

  return { title: item.title || null, price, images, shopName, shopId };
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



