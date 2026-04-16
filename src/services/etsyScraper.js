/**
 * etsyScraper.js
 * Remplace l'API officielle Etsy par un scraping via le microservice botasaurus (Python).
 *
 * Le microservice Python tourne sur SCRAPER_PORT (défaut 5001).
 * Endpoints disponibles :
 *   POST /search              → liste de listings
 *   POST /shop-info           → info boutique
 *   POST /shop-listings       → listings d'une boutique
 *   POST /listing-detail      → détail d'un listing
 *   POST /shop-name-and-image → shopName + images depuis un shopId
 *   GET  /health              → health check
 */

const axios = require('axios');

const SCRAPER_BASE = `http://localhost:${process.env.SCRAPER_PORT || 5001}`;

/**
 * Appel générique vers le microservice Python.
 */
async function scraperCall(endpoint, body = {}) {
  try {
    const r = await axios.post(`${SCRAPER_BASE}${endpoint}`, body, {
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' },
    });
    return r.data;
  } catch (e) {
    const status = e.response?.status;
    const msg    = e.response?.data?.error || e.message;
    if (status === 400) throw new Error(`Scraper 400: ${msg}`);
    if (status === 503) throw new Error('Scraper indisponible (503) — le service Python est-il démarré ?');
    throw new Error(`Scraper error [${status || e.code}]: ${msg}`);
  }
}

/**
 * Recherche des listings Etsy pour un mot-clé donné.
 * Remplace l'appel à l'API officielle Etsy (searchListingIds).
 *
 * @param {string} keyword
 * @param {number} limit — max de listings par page (défaut 48)
 * @param {number} offset — offset de pagination
 * @returns {Promise<Array>} tableau de { listingId, shopId, title, link, image, shopName, shopUrl, price }
 */
async function searchListingIds(keyword, limit = 48, offset = 0) {
  const data = await scraperCall('/search', { keyword, limit, offset });
  const results = data.results || [];
  console.log(`[etsyScraper] searchListingIds: ${results.length} résultats | keyword: "${keyword}" | offset: ${offset}`);
  return results;
}

/**
 * Alias pour compatibilité avec l'ancien code.
 */
async function searchListings(keyword, limit = 25, offset = 0) {
  return searchListingIds(keyword, limit, offset);
}

/**
 * Récupère le nom de boutique + images depuis un shopId numérique et des listing IDs.
 */
async function getShopNameAndImage(shopId, listingId, listingId2 = null, listingId3 = null, listingId4 = null) {
  const data = await scraperCall('/shop-name-and-image', { shopId, listingId, listingId2, listingId3, listingId4 });
  console.log(`[etsyScraper] getShopNameAndImage: shopId=${shopId} | shopName=${data.shopName} | image=${!!data.image} | image2=${!!data.image2}`);
  return {
    shopName: data.shopName || null,
    shopUrl:  data.shopUrl  || null,
    image:    data.image    || null,
    image2:   data.image2   || null,
    image3:   data.image3   || null,
    image4:   data.image4   || null,
  };
}

/**
 * Récupère les listings d'une boutique (par nom ou ID).
 */
async function getShopListings(shopIdOrName, limit = 20) {
  const data = await scraperCall('/shop-listings', { shopIdOrName, limit });
  const results = data.results || [];
  return results;
}

/**
 * Récupère les informations d'une boutique.
 */
async function getShopInfo(shopIdOrName) {
  const data = await scraperCall('/shop-info', { shopIdOrName });
  return {
    shopId:     data.shopId     || null,
    shopName:   data.shopName   || null,
    shopUrl:    data.shopUrl    || null,
    shopAvatar: data.shopAvatar || null,
    title:      data.title      || null,
    numSales:   data.numSales   || 0,
  };
}

/**
 * Récupère le détail d'un listing (images, prix, titre, boutique).
 */
async function getListingDetail(listingId) {
  const data = await scraperCall('/listing-detail', { listingId });
  return {
    title:    data.title    || null,
    price:    data.price    || null,
    images:   data.images   || [],
    shopName: data.shopName || null,
    shopId:   data.shopId   || null,
  };
}

/**
 * Gestion d'erreur compatible avec l'ancien code.
 */
function handleEtsyError(e) {
  if (e.message.includes('400')) throw new Error(`Scraper: requête invalide — ${e.message}`);
  if (e.message.includes('503')) throw new Error('Le microservice scraper botasaurus est indisponible.');
  throw new Error(`Etsy Scraper error: ${e.message}`);
}

/**
 * Health check du microservice scraper.
 */
async function isScraperAvailable() {
  try {
    const r = await axios.get(`${SCRAPER_BASE}/health`, { timeout: 5000 });
    return r.data?.ok === true;
  } catch {
    return false;
  }
}

module.exports = {
  searchListings,
  searchListingIds,
  getShopNameAndImage,
  getShopListings,
  getShopInfo,
  getListingDetail,
  handleEtsyError,
  isScraperAvailable,
};
