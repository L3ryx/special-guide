/**
 * etsyApi.js
 * Wrapper pour l'API officielle Etsy v3 (Open API)
 * Remplace ScraperAPI pour toutes les requêtes vers Etsy.
 *
 * Variables d'environnement requises :
 *   ETSY_API_KEY  — clé API Etsy (keystring), obtenue sur https://www.etsy.com/developers
 *
 * Endpoints utilisés :
 *   GET /v3/application/listings/active          → recherche de listings
 *   GET /v3/application/listings/{listing_id}    → détail d'un listing
 *   GET /v3/application/shops/{shop_id_or_name}  → infos boutique
 *   GET /v3/application/shops/{shop_id}/listings/active → listings d'une boutique
 */

const axios = require('axios');

const BASE = 'https://openapi.etsy.com/v3/application';

function getKey() {
  const key = process.env.ETSY_CLIENT_ID;
  if (!key) throw new Error('ETSY_CLIENT_ID not configured');
  return key;
}

function headers() {
  return { 'x-api-key': getKey() };
}

// ── Utilitaire : normalise une image Etsy vers URL propre ──
function cleanImage(url) {
  if (!url) return null;
  return url.split('?')[0];
}

// ── Normalise un listing brut de l'API en objet unifié ──
function normalizeListing(item, shopName = null) {
  const image =
    item.images?.[0]?.url_fullxfull ||
    item.images?.[0]?.url_570xN ||
    item.images?.[0]?.url_170x135 ||
    null;

  const price = item.price
    ? `${item.price.currency_code} ${(item.price.amount / item.price.divisor).toFixed(2)}`
    : null;

  const resolvedShop = shopName || item.shop?.shop_name || null;

  return {
    title:    item.title || null,
    link:     `https://www.etsy.com/listing/${item.listing_id}`,
    image:    cleanImage(image),
    source:   'etsy',
    shopName: resolvedShop,
    shopUrl:  resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null,
    price,
    listingId: item.listing_id,
    shopId:    item.shop_id || item.shop?.shop_id || null,
  };
}

/**
 * Recherche de listings Etsy par mot-clé.
 * Remplace le scraping de https://www.etsy.com/search?q=…
 *
 * @param {string} keyword
 * @param {number} limit      — nombre de résultats (max 100 par appel)
 * @param {number} offset     — pagination
 * @returns {Promise<Array>}  — tableau de listings normalisés
 */
async function searchListings(keyword, limit = 25, offset = 0) {
  const r = await axios.get(`${BASE}/listings/active`, {
    headers: headers(),
    params: {
      keywords:    keyword,
      limit:       Math.min(limit, 100),
      offset,
      includes:    'images,shop',
      sort_on:     'score',
      sort_order:  'desc',
    },
    timeout: 30000,
  });

  const results = r.data.results || [];
  return results.map(item => normalizeListing(item));
}

/**
 * Récupère les listings actifs d'une boutique Etsy.
 * Remplace le scraping de https://www.etsy.com/shop/{shopName}
 *
 * @param {string|number} shopIdOrName
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getShopListings(shopIdOrName, limit = 20) {
  // L'API accepte shop_id (number) ou shop_name (string) dans le path
  const r = await axios.get(`${BASE}/shops/${encodeURIComponent(shopIdOrName)}/listings/active`, {
    headers: headers(),
    params: {
      limit:    Math.min(limit, 100),
      includes: 'images',
    },
    timeout: 30000,
  });

  const results = r.data.results || [];
  return results.map(item => normalizeListing(item, typeof shopIdOrName === 'string' ? shopIdOrName : null));
}

/**
 * Récupère les informations d'une boutique Etsy.
 * Remplace le scraping de https://www.etsy.com/shop/{shopName}
 *
 * @param {string|number} shopIdOrName
 * @returns {Promise<Object>}  — { shopId, shopName, shopUrl, shopAvatar, title, numSales }
 */
async function getShopInfo(shopIdOrName) {
  const r = await axios.get(`${BASE}/shops/${encodeURIComponent(shopIdOrName)}`, {
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

/**
 * Récupère le détail complet d'un listing (titre, prix, images).
 * Remplace le scraping de https://www.etsy.com/listing/{id}/...
 *
 * @param {number|string} listingId
 * @returns {Promise<Object>}  — { title, price, images: string[] }
 */
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
    title:  item.title || null,
    price,
    images,
    shopName: item.shop?.shop_name || null,
    shopId:   item.shop_id || null,
  };
}

/**
 * Gestion centralisée des erreurs API Etsy
 */
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

