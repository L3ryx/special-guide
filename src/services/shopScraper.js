const axios = require('axios');

// Cache to avoid re-scraping the same shop
const shopCache = new Map();

/**
 * Given an Etsy listing object, returns { shopName, shopUrl, shopAvatar }
 * Scrapes the listing page to find the shop name + avatar if not already known.
 */
async function getShopInfo(listing) {
  // If we already have shopName from the search page, try to get avatar only
  const cacheKey = listing.shopName || listing.link;
  if (shopCache.has(cacheKey)) return shopCache.get(cacheKey);

  try {
    const listingUrl = listing.link;
    const scraperUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(listingUrl)}&render=false`;

    const response = await axios.get(scraperUrl, { timeout: 30000 });
    const html = response.data;

    const info = parseShopInfo(html, listing.shopName);
    shopCache.set(cacheKey, info);
    if (info.shopName) shopCache.set(info.shopName, info);
    return info;
  } catch (err) {
    console.error('shopScraper error:', err.message);
    const fallback = {
      shopName: listing.shopName || null,
      shopUrl:  listing.shopUrl  || null,
      shopAvatar: null
    };
    return fallback;
  }
}

function parseShopInfo(html, knownShopName) {
  let shopName = knownShopName || null;
  let shopUrl  = null;
  let shopAvatar = null;

  // ── 1. Shop name from JSON-LD (seller.name or brand.name) ──
  const jsonLdBlocks = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const seller = item.seller?.name || item.brand?.name || item.offers?.seller?.name;
        if (seller && !shopName) shopName = seller;
      }
    } catch {}
  }

  // ── 2. Shop name from HTML meta / data attributes ──
  if (!shopName) {
    const m = html.match(/data-shop-name="([^"]+)"/i)
           || html.match(/"shopName"\s*:\s*"([^"]+)"/i)
           || html.match(/etsy\.com\/shop\/([A-Za-z0-9]+)/i);
    if (m) shopName = m[1];
  }

  // ── 3. Shop URL ──
  if (shopName) shopUrl = `https://www.etsy.com/shop/${shopName}`;

  // ── 4. Shop avatar — look for shop owner profile image ──
  // Pattern A: data-src or src on an img near shop-owner / shop-icon context
  const avatarPatterns = [
    /shop-owner[^>]*>[\s\S]{0,500}?<img[^>]+(?:src|data-src)="(https:\/\/i\.etsystatic\.com\/iusa\/[^"]+)"/i,
    /<img[^>]+class="[^"]*shop-icon[^"]*"[^>]+(?:src|data-src)="([^"]+)"/i,
    /<img[^>]+(?:src|data-src)="([^"]+)"[^>]+class="[^"]*shop-icon[^"]*"/i,
    /shopAvatar[^"]*"[^"]*"[^"]*"([^"]+etsystatic[^"]+)"/i,
    /"iconUrl"\s*:\s*"([^"]+)"/i,
    /"shop_icon_url"\s*:\s*"([^"]+)"/i,
    /shop[_-]?icon[^>]*(?:src|data-src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
  ];
  for (const pat of avatarPatterns) {
    const m = html.match(pat);
    if (m) { shopAvatar = m[1].replace(/\\u0026/g, '&'); break; }
  }

  // Pattern B: look for owner image via JSON embedded data
  if (!shopAvatar) {
    const jsonMatch = html.match(/"owner"[\s\S]{0,200}?"image_url_[^"]*"\s*:\s*"([^"]+)"/i)
                   || html.match(/"seller_avatar_url"\s*:\s*"([^"]+)"/i)
                   || html.match(/"shop_banner_url"\s*:\s*"([^"]+)"/i);
    if (jsonMatch) shopAvatar = jsonMatch[1].replace(/\\u0026/g, '&');
  }

  return { shopName, shopUrl, shopAvatar };
}

module.exports = { getShopInfo };
