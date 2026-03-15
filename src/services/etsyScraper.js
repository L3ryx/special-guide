const axios = require('axios');

// ════════════════════════════════════════════════════════════════
// HELPER : fetch avec fallback ZenRows si ScrapingBee échoue
// ════════════════════════════════════════════════════════════════
async function fetchHtml(targetUrl, sbParams = {}) {
  const sbKey = process.env.SCRAPINGBEE_KEY;

  // ── Tentative ScrapingBee ──
  if (sbKey) {
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: sbKey, url: targetUrl, country_code: 'us', timeout: '45000', ...sbParams },
        timeout: 120000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) return html;
    } catch (e) {
      console.warn('ScrapingBee failed (' + e.response?.status + ') — trying ZenRows:', e.message.slice(0, 80));
    }
  }

  // ── Fallback ZenRows — 2 tentatives max, timeout 60s ──
  const zrKey = process.env.ZENROWS_API_KEY;
  if (!zrKey) throw new Error('ScrapingBee failed and ZENROWS_API_KEY is not set');

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log('ZenRows fallback attempt', attempt, ':', targetUrl);
      const r = await axios.get('https://api.zenrows.com/v1/', {
        params: {
          apikey:        zrKey,
          url:           targetUrl,
          js_render:     'true',
          premium_proxy: 'true',
          wait_for:      sbParams.wait || '2000',
        },
        timeout: 60000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length < 500) throw new Error('ZenRows returned empty response');
      console.log('ZenRows OK (' + html.length + ' chars)');
      return html;
    } catch (e) {
      console.warn('ZenRows attempt', attempt, 'failed:', e.message.slice(0, 80));
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('ZenRows failed after 2 attempts');
}

// ════════════════════════════════════════════════════════════════
async function scrapeEtsy(keyword, maxCount = 10) {
  if (!process.env.SCRAPINGBEE_KEY && !process.env.ZENROWS_API_KEY) {
    throw new Error('SCRAPINGBEE_KEY or ZENROWS_API_KEY required');
  }

  console.log(`scrapeEtsy: "${keyword}" (max ${maxCount})`);

  const allListings = [];
  const seen = new Set();
  let page = 1;
  const perPage = 48;

  while (allListings.length < maxCount) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

    let html;
    try {
      html = await fetchHtml(etsyUrl, {
        render_js:     'true',
        premium_proxy: 'true',
        wait:          '3000',
        block_ads:     'true',
      });
    } catch (err) {
      throw new Error(`Scraping failed: ${err.message}`);
    }

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

// ════════════════════════════════════════════════════════════════
async function scrapeEtsyShopNames(keyword) {
  if (!process.env.SCRAPINGBEE_KEY && !process.env.ZENROWS_API_KEY) {
    throw new Error('SCRAPINGBEE_KEY or ZENROWS_API_KEY required');
  }

  const allShops = new Set();
  let page = 1;

  while (page <= 20) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

    let html;
    try {
      html = await fetchHtml(etsyUrl, {
        render_js:     'true',
        premium_proxy: 'true',
        wait:          '2000',
        block_ads:     'true',
      });
    } catch (e) {
      console.warn(`Page ${page} error:`, e.message);
      break;
    }

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

// ════════════════════════════════════════════════════════════════
function parseEtsyListings(html) {
  const listings = [];
  const seen = new Set();

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
          const shopName = item.seller?.name || item.brand?.name || extractShopFromUrl(url) || null;
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

  // Strategy 2: data-listing-id blocks
  const blocks = [...html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)];
  for (const block of blocks) {
    const b = block[1];
    const linkMatch = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgMatch  = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    if (linkMatch && imgMatch && !seen.has(linkMatch[1])) {
      seen.add(linkMatch[1]);
      const shopAttr = b.match(/data-shop-name="([^"]+)"/i);
      const shopName = shopAttr ? shopAttr[1] : extractShopFromUrl(linkMatch[1]);
      const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
      const nameMatch  = b.match(/alt="([^"]{5,120})"/i);
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

  // Strategy 3: proximity
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const linkPos   = allLinks.map(m  => ({ url: m[1].split('?')[0], pos: m.index }));
  const imgPos    = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  for (const link of linkPos) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - link.pos);
      if (d < minDist && d < 5000) { minDist = d; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      const ctx      = html.slice(Math.max(0, link.pos - 1000), link.pos + 1000);
      const shopAttr = ctx.match(/data-shop-name="([^"]+)"/i)
                    || ctx.match(/data-shop_name="([^"]+)"/i)
                    || ctx.match(/"shopName"\s*:\s*"([^"]+)"/i)
                    || ctx.match(/etsy\.com\/shop\/([A-Za-z0-9]+)/i);
      const shopName = shopAttr ? shopAttr[1] : null;
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
  try {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`;
    const html = await fetchHtml(etsyUrl, { render_js: 'true', premium_proxy: 'true', wait: '2000' });
    const listings = parseEtsyListings(html);
    const valid = listings.filter(l => l.link && l.image);
    return { ok: true, htmlLength: html.length, validListings: valid.length, sample: valid[0] || null };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

module.exports = { scrapeEtsy, scrapeEtsyShopNames, debugEtsyHtml };

