const axios = require('axios');
const cache = new Map();

async function getShopInfo(listing) {
  const key = listing.shopName || listing.link;
  if (cache.has(key)) return cache.get(key);

  // Retourner directement les infos disponibles dans le listing
  // ScrapingBee désactivé ici — trop de 429 en parallèle
  const info = {
    shopName:   listing.shopName   || null,
    shopUrl:    listing.shopUrl    || (listing.shopName ? `https://www.etsy.com/shop/${listing.shopName}` : null),
    shopAvatar: listing.shopAvatar || null,
  };
  cache.set(key, info);
  return info;
}

module.exports = { getShopInfo };

