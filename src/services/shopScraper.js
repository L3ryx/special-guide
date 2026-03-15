const axios = require('axios');

const cache = new Map();

async function getShopInfo(listing) {
  const key = listing.shopName || listing.link;
  if (cache.has(key)) return cache.get(key);

  // Already have shopName — just build the info
  if (listing.shopName) {
    const info = {
      shopName:   listing.shopName,
      shopUrl:    listing.shopUrl || `https://www.etsy.com/shop/${listing.shopName}`,
      shopAvatar: listing.shopAvatar || null
    };
    cache.set(key, info);
    return info;
  }

  // Retry avec backoff pour eviter les 429
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Tentative 1 : sans render_js (moins de credits, evite les 429)
      // Tentative 2 : avec stealth_proxy
      // Tentative 3 : avec premium_proxy
      const params = {
        api_key:      process.env.SCRAPINGBEE_KEY,
        url:          listing.link,
        render_js:    attempt === 1 ? 'false' : 'true',
        country_code: 'us',
        timeout:      '30000',
      };
      if (attempt === 2) params.stealth_proxy  = 'true';
      if (attempt === 3) params.premium_proxy  = 'true';
      if (attempt > 1)   params.wait           = '2000';

      const res = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params,
        timeout: 60000,
      });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const info = parseShopInfo(html);
      cache.set(key, info);
      if (info.shopName) cache.set(info.shopName, info);
      return info;
    } catch (err) {
      const status = err.response?.status;
      console.error('shopScraper error (attempt ' + attempt + '):', err.message);
      // 429 = rate limit -> attendre avant retry
      if (status === 429 && attempt < 3) {
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      // 401 = cle invalide -> inutile de retry
      if (status === 401) break;
      if (attempt === 3) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return { shopName: listing.shopName || null, shopUrl: listing.shopUrl || null, shopAvatar: null };
}

function parseShopInfo(html) {
  let shopName = null, shopAvatar = null;

  // Strategy 1: JSON-LD
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const items = [].concat(JSON.parse(raw)?.['@graph'] || JSON.parse(raw));
      for (const item of items) {
        shopName = shopName || item.seller?.name || item.brand?.name;
      }
    } catch {}
    if (shopName) break;
  }

  // Strategy 2: multiple HTML/JS patterns
  if (!shopName) {
    const patterns = [
      // Direct href to shop page — most reliable
      /href="https:\/\/www\.etsy\.com\/shop\/([A-Za-z0-9_-]+)/i,
      // Data attributes
      /data-shop-name="([^"]+)"/i,
      // JSON in page JS
      /"shopName"\s*:\s*"([^"]+)"/i,
      /"shop_name"\s*:\s*"([^"]+)"/i,
      /"owner_name"\s*:\s*"([^"]+)"/i,
      // Schema.org Store
      /"@type"\s*:\s*"Store"[^}]{0,200}"name"\s*:\s*"([^"]+)"/i,
      /"name"\s*:\s*"([^"]+)"[^}]{0,200}"@type"\s*:\s*"Store"/i,
      // Etsy internal JS state
      /"shopId"[^}]{0,300}"shopName"\s*:\s*"([^"]+)"/i,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m?.[1]?.length > 1) { shopName = m[1]; break; }
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
    shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
    shopAvatar
  };
}

module.exports = { getShopInfo };
