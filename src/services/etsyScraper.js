const axios = require('axios');

async function scrapeEtsy(keyword, maxCount = 10) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_KEY missing');

  console.log(`scrapeEtsy: "${keyword}" (max ${maxCount})`);

  const allListings = [];
  const seen = new Set();
  let page = 1;
  const perPage = 48; // Etsy shows ~48 per page

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

    console.log(`After page ${page}: ${allListings.length}/${maxCount}`);

    if (allListings.length >= maxCount) break;

    // Check if there's a next page
    const hasNextPage = html.includes('pagination-next') || html.includes('"next"') || 
                        html.includes(`page=${page + 1}`) || valid.length >= perPage - 5;
    if (!hasNextPage) {
      console.log(`No next page detected after page ${page}`);
      break;
    }

    page++;
    // Safety limit: max 5 pages
    if (page > 5) break;

    // Small delay between pages
    await new Promise(r => setTimeout(r, 1000));
  }

  if (allListings.length === 0) throw new Error('No Etsy listings found — Etsy may have changed its structure');

  console.log(`Total: ${allListings.length} listings`);
  return allListings.slice(0, maxCount);
}

// Scrape all shop names for a keyword (for competition analysis) — no image needed
async function scrapeEtsyShopNames(keyword) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_KEY missing');

  const allShops = new Set();
  let page = 1;

  while (page <= 20) { // max 20 pages
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
    const shops = listings
      .filter(l => l.shopName)
      .map(l => l.shopName);

    if (shops.length === 0) break;

    shops.forEach(s => allShops.add(s));
    console.log(`Competition page ${page}: +${shops.length} shops, total unique: ${allShops.size}`);

    // Check if there's a next page
    const hasNext = html.includes('pagination-next') || 
                    listings.length >= 40 ||
                    html.includes(`page=${page + 1}`);
    if (!hasNext) break;

    page++;
    await new Promise(r => setTimeout(r, 800));
  }

  return Array.from(allShops);
}

// ── EXTRACTION DU SHOP NAME DEPUIS UNE URL DE LISTING ──
// Etsy listing URLs: https://www.etsy.com/listing/123456/product-name
// On extrait le shopName depuis le contexte HTML autour du lien, ou depuis les blocs JSON.
function extractShopNameFromContext(context) {
  // Ordre de priorité : attributs HTML > JSON inline > URL /shop/
  const m =
    context.match(/data-shop-name="([^"]+)"/i) ||
    context.match(/data-shop_name="([^"]+)"/i) ||
    context.match(/data-seller-name="([^"]+)"/i) ||
    context.match(/"shopName"\s*:\s*"([A-Za-z0-9_-]+)"/i) ||
    context.match(/"sellerName"\s*:\s*"([A-Za-z0-9_-]+)"/i) ||
    context.match(/"seller"\s*:\s*\{[^}]*"name"\s*:\s*"([A-Za-z0-9_-]+)"/i) ||
    context.match(/etsy\.com\/shop\/([A-Za-z0-9]+)/i) ||
    context.match(/\/shop\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

function parseEtsyListings(html) {
  const listings = [];
  const seen = new Set();

  // ── Strategy 1: JSON-LD ──
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
          // seller.name est la source la plus fiable dans JSON-LD
          const shopName = item.seller?.name || item.brand?.name || null;
          const shopUrl = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
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
      }
    } catch {}
  }
  if (listings.length >= 2) return listings;

  // ── Strategy 2: data-listing-id blocks ──
  const blocks = [...html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)];
  for (const block of blocks) {
    const b = block[1];
    const linkMatch = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgMatch = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    if (linkMatch && imgMatch && !seen.has(linkMatch[1])) {
      seen.add(linkMatch[1]);
      // Chercher le shopName dans tout le bloc HTML
      const shopName = extractShopNameFromContext(b);
      const shopUrl = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
      const nameMatch = b.match(/alt="([^"]{5,120})"/i);
      const priceMatch = b.match(/data-price="([^"]+)"/i) || b.match(/"price"\s*:\s*"([^"]+)"/i);
      listings.push({
        title: nameMatch ? nameMatch[1].trim() : linkMatch[1].split('/').pop().replace(/-/g, ' '),
        link: linkMatch[1], image: imgMatch[1].split('?')[0],
        source: 'etsy', shopName, shopUrl,
        price: priceMatch ? priceMatch[1].trim() : null,
      });
    }
  }
  if (listings.length >= 2) return listings;

  // ── Strategy 3: proximity (fallback) ──
  // Extraction globale des shopNames présents dans la page (blocs JSON, data-shop-name, /shop/ URLs)
  const globalShopMap = buildGlobalShopMap(html);

  const allLinks = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const linkPos = allLinks.map(m => ({ url: m[1].split('?')[0], listingId: m[2], pos: m.index }));
  const imgPos = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  for (const link of linkPos) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - link.pos);
      if (d < minDist && d < 5000) { minDist = d; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      // 1) Contexte local autour du lien (2000 chars)
      const contextStart = Math.max(0, link.pos - 1000);
      const contextEnd = Math.min(html.length, link.pos + 1000);
      const context = html.slice(contextStart, contextEnd);
      let shopName = extractShopNameFromContext(context);

      // 2) Si pas trouvé localement, chercher par listing ID dans la map globale
      if (!shopName && link.listingId) {
        shopName = globalShopMap.get(link.listingId) || null;
      }

      listings.push({
        title: link.url.split('/').pop().replace(/-/g, ' '),
        link: link.url, image: closest.url,
        source: 'etsy', shopName,
        shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
        price: null,
      });
    }
  }

  return listings;
}

// Construit une map listingId → shopName en scannant tout le HTML une seule fois
function buildGlobalShopMap(html) {
  const map = new Map();
  // Chercher les blocs JS/JSON qui associent un listingId à un shopName
  // Pattern Etsy typique : "listing_id":123456,"shop_name":"ShopName"
  const patterns = [
    /"listing_id"\s*:\s*(\d+)[^}]{0,200}"shop_name"\s*:\s*"([A-Za-z0-9_-]+)"/gi,
    /"listingId"\s*:\s*(\d+)[^}]{0,200}"shopName"\s*:\s*"([A-Za-z0-9_-]+)"/gi,
    /"id"\s*:\s*(\d+)[^}]{0,200}"seller"\s*:\s*\{[^}]*"name"\s*:\s*"([A-Za-z0-9_-]+)"/gi,
  ];
  for (const pattern of patterns) {
    for (const m of html.matchAll(pattern)) {
      if (!map.has(m[1])) map.set(m[1], m[2]);
    }
  }
  return map;
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
    return { ok: true, htmlLength: html.length, validListings: valid.length, sample: valid[0] || null };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

module.exports = { scrapeEtsy, scrapeEtsyShopNames, debugEtsyHtml };

