const axios = require('axios');

async function scrapeEtsy(keyword, maxCount = 10) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_KEY missing');

  console.log(`scrapeEtsy: "${keyword}" (max ${maxCount})`);

  const allListings = [];
  const seen = new Set();
  let page = 1;
  const perPage = 48;

  while (allListings.length < maxCount) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

    let response;
    try {
      response = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: {
          api_key:       apiKey,
          url:           etsyUrl,
          render_js:     'true',
          premium_proxy: 'true',
          country_code:  'us',
          wait:          '3000',
          block_ads:     'true',
          timeout:       '45000',
        },
        timeout: 120000,
      });
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) throw new Error('SCRAPINGBEE_KEY invalid (401)');
      if (status === 429) throw new Error('ScrapingBee credits exhausted (429)');
      throw new Error(`ScrapingBee error ${status || ''}: ${err.message}`);
    }

    const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    console.log(`Page ${page}: ${html.length} chars`);

    const listings = parseEtsyListings(html);
    const valid = listings.filter(l => l.link && l.image && !seen.has(l.link));

    if (valid.length === 0) {
      console.log(`Page ${page}: no new listings, stopping`);
      break;
    }

    for (const l of valid) {
      if (allListings.length >= maxCount) break;
      seen.add(l.link);
      allListings.push(l);
    }

    console.log(`After page ${page}: ${allListings.length}/${maxCount} | shopNames: ${valid.filter(l => l.shopName).length}/${valid.length}`);

    if (allListings.length >= maxCount) break;

    const hasNextPage = html.includes('pagination-next') || html.includes('"next"') ||
                        html.includes(`page=${page + 1}`) || valid.length >= perPage - 5;
    if (!hasNextPage) {
      console.log(`No next page detected after page ${page}`);
      break;
    }

    page++;
    if (page > 5) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (allListings.length === 0) throw new Error('No Etsy listings found — Etsy may have changed its structure');

  console.log(`Total: ${allListings.length} listings`);
  return allListings.slice(0, maxCount);
}

async function scrapeEtsyShopNames(keyword) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_KEY missing');

  const allShops = new Set();
  let page = 1;

  while (page <= 20) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

    let response;
    try {
      response = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: {
          api_key:       apiKey,
          url:           etsyUrl,
          render_js:     'true',
          premium_proxy: 'true',
          country_code:  'us',
          wait:          '2000',
          block_ads:     'true',
          timeout:       '45000',
        },
        timeout: 120000,
      });
    } catch (err) {
      console.warn(`Page ${page} error:`, err.message);
      break;
    }

    const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const listings = parseEtsyListings(html);
    const shops = listings.filter(l => l.shopName).map(l => l.shopName);

    if (shops.length === 0) break;

    shops.forEach(s => allShops.add(s));
    console.log(`Competition page ${page}: +${shops.length} shops, total unique: ${allShops.size}`);

    const hasNext = html.includes('pagination-next') ||
                    listings.length >= 40 ||
                    html.includes(`page=${page + 1}`);
    if (!hasNext) break;

    page++;
    await new Promise(r => setTimeout(r, 800));
  }

  return Array.from(allShops);
}

// ─────────────────────────────────────────────────────────────────
// MAP GLOBALE : scanne tout le HTML une seule fois et construit
// une map  listingId (string) → shopName (string)
//
// Etsy injecte les données de chaque listing dans des blobs JSON
// de la forme :
//   "listing_id":123456,"shop_name":"ShopName"
//   "listingId":"123456","shopName":"ShopName"
// ainsi que des liens href="/shop/ShopName" proches du listing.
// ─────────────────────────────────────────────────────────────────
function buildListingShopMap(html) {
  const map = new Map();

  // ── 1. Patterns JSON inline ──
  // listing_id puis shop_name dans un rayon de 500 chars
  for (const m of html.matchAll(/"listing_id"\s*:\s*"?(\d+)"?[\s\S]{0,500}?"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  // shop_name puis listing_id (ordre inverse)
  for (const m of html.matchAll(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"[\s\S]{0,500}?"listing_id"\s*:\s*"?(\d+)"?/g)) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }
  // camelCase variants
  for (const m of html.matchAll(/"listingId"\s*:\s*"?(\d+)"?[\s\S]{0,500}?"shopName"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  for (const m of html.matchAll(/"shopName"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"[\s\S]{0,500}?"listingId"\s*:\s*"?(\d+)"?/g)) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }

  // ── 2. JSON-LD global ──
  for (const block of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url = item.url || item['@id'] || '';
        const idMatch = url.match(/\/listing\/(\d+)\//);
        if (!idMatch) continue;
        const shopName = item.seller?.name || item.brand?.name;
        if (shopName && !map.has(idMatch[1])) map.set(idMatch[1], shopName);
      }
    } catch {}
  }

  // ── 3. Liens /listing/ID voisins d'un lien /shop/Name dans le HTML ──
  // Etsy affiche souvent "href=/shop/Name" juste à côté du lien produit
  for (const m of html.matchAll(/href="[^"]*\/listing\/(\d+)\/[^"]*"[\s\S]{0,800}?href="[^"]*\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|")[^"]*"/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  for (const m of html.matchAll(/href="[^"]*\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|")[^"]*"[\s\S]{0,800}?href="[^"]*\/listing\/(\d+)\/[^"]*"/g)) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }

  console.log(`[buildListingShopMap] ${map.size} listingId→shopName mappings found`);
  return map;
}

// ─────────────────────────────────────────────────────────────────
// PARSING PRINCIPAL
// ─────────────────────────────────────────────────────────────────
function parseEtsyListings(html) {
  const listings = [];
  const seen = new Set();

  // Construire la map globale UNE SEULE FOIS
  const shopMap = buildListingShopMap(html);

  // Résout le shopName : map globale en priorité, puis contexte local
  function resolveShopName(listingId, localCtx) {
    if (listingId && shopMap.has(listingId)) return shopMap.get(listingId);
    if (!localCtx) return null;
    const m = localCtx.match(/data-shop-name="([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i)
           || localCtx.match(/data-shop_name="([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i)
           || localCtx.match(/href="[^"]*\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|")"/i)
           || localCtx.match(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i)
           || localCtx.match(/"shopName"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i);
    return m ? m[1] : null;
  }

  // ── Strategy 1 : JSON-LD ──
  for (const block of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url = item.url || item['@id'];
        const rawImg = Array.isArray(item.image) ? item.image[0] : (typeof item.image === 'string' ? item.image : null);
        const image = cleanEtsyImage(rawImg);
        const name = item.name;
        if (!url?.includes('/listing/') || !image || !name || seen.has(url)) continue;

        seen.add(url);
        const idMatch = url.match(/\/listing\/(\d+)\//);
        const listingId = idMatch ? idMatch[1] : null;
        const shopName = item.seller?.name || item.brand?.name || resolveShopName(listingId, null);
        const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;

        let price = null;
        const offers = item.offers || item.offer;
        if (offers) {
          const offer = Array.isArray(offers) ? offers[0] : offers;
          const p = offer?.price || offer?.lowPrice;
          const cur = offer?.priceCurrency || '';
          if (p) price = cur ? `${cur} ${p}` : String(p);
        }
        listings.push({ title: name, link: url.split('?')[0], image, source: 'etsy', shopName, shopUrl, price });
      }
    } catch {}
  }
  if (listings.length >= 2) return listings;

  // ── Strategy 2 : data-listing-id blocks ──
  for (const block of html.matchAll(/(<(?:li|div)[^>]*data-listing-id="(\d+)"[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)) {
    const b = block[1];
    const listingId = block[2];
    const linkMatch = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgMatch  = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    if (!linkMatch || !imgMatch || seen.has(linkMatch[1])) continue;

    seen.add(linkMatch[1]);
    const shopName   = resolveShopName(listingId, b);
    const shopUrl    = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
    const nameMatch  = b.match(/alt="([^"]{5,120})"/i);
    const priceMatch = b.match(/data-price="([^"]+)"/i) || b.match(/"price"\s*:\s*"([^"]+)"/i);

    listings.push({
      title:  nameMatch ? nameMatch[1].trim() : linkMatch[1].split('/').pop().replace(/-/g, ' '),
      link:   linkMatch[1],
      image:  imgMatch[1].split('?')[0],
      source: 'etsy', shopName, shopUrl,
      price:  priceMatch ? priceMatch[1].trim() : null,
    });
  }
  if (listings.length >= 2) return listings;

  // ── Strategy 3 : proximity (fallback) ──
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const linkPos   = allLinks.map(m  => ({ url: m[1].split('?')[0], listingId: m[2], pos: m.index }));
  const imgPos    = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  for (const link of linkPos) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - link.pos);
      if (d < minDist && d < 5000) { minDist = d; closest = img; }
    }
    if (!closest) continue;

    seen.add(link.url);
    const ctxStart = Math.max(0, link.pos - 1000);
    const ctxEnd   = Math.min(html.length, link.pos + 1000);
    const context  = html.slice(ctxStart, ctxEnd);
    const shopName = resolveShopName(link.listingId, context);

    listings.push({
      title:   link.url.split('/').pop().replace(/-/g, ' '),
      link:    link.url,
      image:   closest.url,
      source:  'etsy',
      shopName,
      shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
      price:   null,
    });
  }

  return listings;
}

function cleanEtsyImage(url) {
  if (!url) return null;
  url = url.split('?')[0].trim();
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(url)) return url;
  if (url.match(/\/il\/[a-f0-9]+\/\d+$/)) return url + '.jpg';
  return null;
}

async function debugEtsyHtml(keyword) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) return { ok: false, error: 'SCRAPINGBEE_KEY not defined' };
  try {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`;
    const response = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: { api_key: apiKey, url: etsyUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '2000', timeout: '45000' },
      timeout: 120000,
    });
    const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const listings = parseEtsyListings(html);
    const valid    = listings.filter(l => l.link && l.image);
    const withShop = valid.filter(l => l.shopName);
    return {
      ok: true,
      htmlLength: html.length,
      validListings: valid.length,
      withShopName: withShop.length,
      sample: valid[0] || null,
    };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

module.exports = { scrapeEtsy, scrapeEtsyShopNames, debugEtsyHtml };

