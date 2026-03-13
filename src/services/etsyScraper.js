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

    console.log(`After page ${page}: ${allListings.length}/${maxCount} (shopNames: ${valid.filter(l=>l.shopName).length}/${valid.length})`);

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

// ── Extrait un Map listingId → shopName depuis le JSON global Etsy ──
function extractListingShopMap(html) {
  const map = new Map();

  // Etsy embed a large JSON blob: window.__initial_state__ ou similar
  // Pattern 1: "listing_id":{"shop":{"shop_name":"..."}}
  for (const [, raw] of html.matchAll(/"(\d{8,12})":\s*\{[^{}]{0,2000}"shop_name"\s*:\s*"([^"]+)"/g)) {
    map.set(raw, undefined); // handled below with named groups
  }

  // Pattern 2: recherche plus ciblée — paires listingId/shopName dans le JSON global
  const globalJsonMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) ||
                          html.match(/window\.__initial_state__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) ||
                          html.match(/"listings"\s*:\s*(\{[\s\S]{100,500000}\})\s*[,}]/);

  if (globalJsonMatch) {
    try {
      const obj = JSON.parse(globalJsonMatch[1]);
      // Walk the object looking for listing structures
      walkForShopNames(obj, map);
    } catch {}
  }

  // Pattern 3: "listing_id":NNNN ... "shop_name":"NAME" dans un rayon de 500 chars
  for (const [, listingId, chunk] of html.matchAll(/"listing_id"\s*:\s*(\d+)([\s\S]{0,500})/g)) {
    if (map.has(listingId)) continue;
    const m = chunk.match(/"shop_name"\s*:\s*"([A-Za-z0-9]+)"/);
    if (m) map.set(listingId, m[1]);
  }

  // Pattern 4: data-listing-id + data-shop-name sur le même élément HTML
  for (const [, listingId, shopName] of html.matchAll(/data-listing-id="(\d+)"[^>]*data-shop-name="([^"]+)"/g)) {
    if (!map.has(listingId)) map.set(listingId, shopName);
  }
  for (const [, shopName, listingId] of html.matchAll(/data-shop-name="([^"]+)"[^>]*data-listing-id="(\d+)"/g)) {
    if (!map.has(listingId)) map.set(listingId, shopName);
  }

  // Pattern 5: "shop":{"shop_name":"NAME"} précédé par listing id quelque part proche
  for (const [, shopName] of html.matchAll(/"shop"\s*:\s*\{"shop_name"\s*:\s*"([A-Za-z0-9]+)"/g)) {
    // On ne peut pas associer sans listingId ici, mais c'est un fallback global
    // Stocké sous clé spéciale pour usage global si needed
    if (!map.has('__global__')) map.set('__global__', shopName);
  }

  return map;
}

function walkForShopNames(obj, map, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(i => walkForShopNames(i, map, depth + 1)); return; }
  const lid = obj.listing_id || obj.listingId;
  const sn  = obj.shop_name  || obj.shopName || obj.shop?.shop_name || obj.shop?.shopName;
  if (lid && sn) map.set(String(lid), sn);
  for (const v of Object.values(obj)) walkForShopNames(v, map, depth + 1);
}

function parseEtsyListings(html) {
  const listings = [];
  const seen = new Set();

  // Pré-calcul du map listingId → shopName
  const shopMap = extractListingShopMap(html);
  console.log(`shopMap entries: ${shopMap.size}`);

  // Helper: enrichit un listing avec shopName depuis le map
  function enrichShop(listing) {
    if (listing.shopName) return listing;
    const idMatch = listing.link?.match(/\/listing\/(\d+)\//);
    if (idMatch) {
      const name = shopMap.get(idMatch[1]);
      if (name) {
        listing.shopName = name;
        listing.shopUrl  = `https://www.etsy.com/shop/${name}`;
      }
    }
    // Fallback: premier shopName global
    if (!listing.shopName && shopMap.has('__global__')) {
      // Ne pas utiliser le global — trop imprécis
    }
    return listing;
  }

  // Strategy 1: JSON-LD
  const jsonLdBlocks = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url = item.url || item['@id'];
        const rawImg = Array.isArray(item.image) ? item.image[0] : (typeof item.image === 'string' ? item.image : null);
        const image = cleanEtsyImage(rawImg);
        const name = item.name;
        if (url?.includes('/listing/') && image && name && !seen.has(url)) {
          seen.add(url);
          const shopName = item.seller?.name || item.brand?.name || null;
          const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
          let price = null;
          const offers = item.offers || item.offer;
          if (offers) {
            const offer = Array.isArray(offers) ? offers[0] : offers;
            const p = offer?.price || offer?.lowPrice;
            const cur = offer?.priceCurrency || '';
            if (p) price = cur ? `${cur} ${p}` : String(p);
          }
          listings.push(enrichShop({ title: name, link: url.split('?')[0], image, source: 'etsy', shopName, shopUrl, price }));
        }
      }
    } catch {}
  }
  if (listings.length >= 2) return listings;

  // Strategy 2: data-listing-id blocks
  const blocks = [...html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)];
  for (const block of blocks) {
    const b = block[1];
    const linkMatch = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgMatch  = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    if (linkMatch && imgMatch && !seen.has(linkMatch[1])) {
      seen.add(linkMatch[1]);
      const shopAttr = b.match(/data-shop-name="([^"]+)"/i);
      const shopName = shopAttr ? shopAttr[1] : null;
      const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
      const nameMatch  = b.match(/alt="([^"]{5,120})"/i);
      const priceMatch = b.match(/data-price="([^"]+)"/i) || b.match(/"price"\s*:\s*"([^"]+)"/i);
      listings.push(enrichShop({
        title:    nameMatch ? nameMatch[1].trim() : linkMatch[1].split('/').pop().replace(/-/g, ' '),
        link:     linkMatch[1],
        image:    imgMatch[1].split('?')[0],
        source:   'etsy',
        shopName, shopUrl,
        price:    priceMatch ? priceMatch[1].trim() : null,
      }));
    }
  }
  if (listings.length >= 2) return listings;

  // Strategy 3: proximity (fallback)
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const linkPos = allLinks.map(m => ({ url: m[1].split('?')[0], listingId: m[2], pos: m.index }));
  const imgPos  = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  for (const link of linkPos) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - link.pos);
      if (d < minDist && d < 5000) { minDist = d; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      // ← Utilise le shopMap au lieu de extractShopFromUrl (qui ne marche pas sur /listing/)
      const shopName = shopMap.get(link.listingId) || null;
      listings.push(enrichShop({
        title:    link.url.split('/').pop().replace(/-/g, ' '),
        link:     link.url,
        image:    closest.url,
        source:   'etsy',
        shopName,
        shopUrl:  shopName ? `https://www.etsy.com/shop/${shopName}` : null,
        price:    null,
      }));
    }
  }

  return listings;
}

function extractShopFromUrl(url) {
  const m = url.match(/etsy\.com\/shop\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
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
    const valid = listings.filter(l => l.link && l.image);
    return {
      ok: true,
      htmlLength: html.length,
      validListings: valid.length,
      withShopName: valid.filter(l => l.shopName).length,
      sample: valid[0] || null,
    };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

module.exports = { scrapeEtsy, scrapeEtsyShopNames, debugEtsyHtml };
