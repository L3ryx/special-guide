const axios = require('axios');

const cache = new Map();

async function getShopInfo(listing) {
  const key = listing.shopName || listing.link;
  if (cache.has(key)) return cache.get(key);

  // Si on a déjà le shopName depuis ScrapingBee, on construit juste les infos sans re-scraper
  if (listing.shopName) {
    const info = {
      shopName:   listing.shopName,
      shopUrl:    listing.shopUrl || `https://www.etsy.com/shop/${listing.shopName}`,
      shopAvatar: listing.shopAvatar || null
    };
    cache.set(key, info);
    return info;
  }

  try {
    const url = `http://api.scraperapi.com?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(listing.link)}&render=false`;
    const res  = await axios.get(url, { timeout: 20000 });
    const html = res.data;
    const info = parseShopInfo(html);
    cache.set(key, info);
    if (info.shopName) cache.set(info.shopName, info);
    return info;
  } catch (err) {
    console.error('shopScraper error:', err.message);
    return { shopName: listing.shopName || null, shopUrl: listing.shopUrl || null, shopAvatar: null };
  }
}

function parseShopInfo(html) {
  let shopName = null, shopAvatar = null;

  // JSON-LD
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const items = [].concat(JSON.parse(raw)?.['@graph'] || JSON.parse(raw));
      for (const item of items) {
        shopName = shopName || item.seller?.name || item.brand?.name;
      }
    } catch {}
    if (shopName) break;
  }

  // HTML / JS patterns (multiple fallbacks)
  if (!shopName) {
    const patterns = [
      /data-shop-name="([^"]+)"/i,
      /"shopName"\s*:\s*"([^"]+)"/i,
      /"shop_name"\s*:\s*"([^"]+)"/i,
      /etsy\.com\/shop\/([A-Za-z0-9]+)/i,
      /"ownerName"\s*:\s*"([^"]+)"/i,
      /class="[^"]*shop-name[^"]*"[^>]*>([A-Za-z0-9]+)</i,
      /"name"\s*:\s*"([^"]+)"[^}]*"@type"\s*:\s*"Store"/i,
      /"@type"\s*:\s*"Store"[^}]*"name"\s*:\s*"([^"]+)"/i,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m && m[1] && m[1].length > 1) { shopName = m[1]; break; }
    }
  }

  // Avatar
  const avatarPatterns = [
    /"iconUrl"\s*:\s*"([^"]+)"/i,
    /"shop_icon_url"\s*:\s*"([^"]+)"/i,
    /<img[^>]+class="[^"]*shop-icon[^"]*"[^>]+src="([^"]+)"/i,
    /shop-owner[\s\S]{0,300}?<img[^>]+src="(https:\/\/i\.etsystatic\.com\/iusa\/[^"]+)"/i,
  ];
  for (const pat of avatarPatterns) {
    const m = html.match(pat);
    if (m) { shopAvatar = m[1].replace(/\\u0026/g, '&'); break; }
  }

  return {
    shopName,
    shopUrl:    shopName ? `https://www.etsy.com/shop/${shopName}` : null,
    shopAvatar
  };
}

module.exports = { getShopInfo };
