const { scraperApiFetch } = require('./scrapingFetch');

async function scrapeEtsy(keyword, maxCount = 10) {
  if (!process.env.SCRAPEAPI_KEY) throw new Error('SCRAPEAPI_KEY missing');

  console.log(`scrapeEtsy: "${keyword}" (max ${maxCount})`);

  const allListings = [];
  const seen        = new Set();
  let   page        = 1;
  const perPage     = 48;

  while (allListings.length < maxCount) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

    let html;
    try {
      html = await scraperApiFetch(etsyUrl);
    } catch (err) {
      // Erreurs fatales (401/403) remontées telles quelles
      if (err.message.includes('401') || err.message.includes('403')) throw err;
      console.warn(`scrapeEtsy page ${page} failed:`, err.message);
      break;
    }

    console.log(`Page ${page}: ${html.length} chars`);

    const listings = parseEtsyListings(html);
    const valid    = listings.filter(l => l.link && l.image && !seen.has(l.link));

    if (valid.length === 0) { console.log(`Page ${page}: no new listings, stopping`); break; }

    for (const l of valid) {
      if (allListings.length >= maxCount) break;
      seen.add(l.link);
      allListings.push(l);
    }

    console.log(`After page ${page}: ${allListings.length}/${maxCount}`);
    if (allListings.length >= maxCount) break;

    const hasNextPage = html.includes('pagination-next') || html.includes('"next"') ||
                        html.includes(`page=${page + 1}`) || valid.length >= perPage - 5;
    if (!hasNextPage) { console.log(`No next page after page ${page}`); break; }

    page++;
    if (page > 5) break;

    await new Promise(r => setTimeout(r, 800));
  }

  if (allListings.length === 0) throw new Error('No Etsy listings found — Etsy may have changed its structure');

  console.log(`Total: ${allListings.length} listings`);
  return allListings.slice(0, maxCount);
}

function parseEtsyListings(html) {
  const listings = [];
  const seen = new Set();

  // Strategy 1: JSON-LD
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data  = JSON.parse(raw);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url    = item.url || item['@id'];
        const rawImg = Array.isArray(item.image) ? item.image[0] : (typeof item.image === 'string' ? item.image : null);
        const image  = cleanEtsyImage(rawImg);
        const name   = item.name;
        if (url?.includes('/listing/') && image && name && !seen.has(url)) {
          seen.add(url);
          const shopName = item.seller?.name || item.brand?.name || extractShopFromUrl(url) || null;
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
      }
    } catch {}
  }
  if (listings.length >= 2) return listings;

  // Strategy 2: data-listing-id blocks
  for (const [, b] of html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)) {
    const linkMatch = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgMatch  = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    if (linkMatch && imgMatch && !seen.has(linkMatch[1])) {
      seen.add(linkMatch[1]);
      const shopAttr = b.match(/data-shop-name="([^"]+)"/i);
      const shopName = shopAttr ? shopAttr[1] : extractShopFromUrl(linkMatch[1]);
      const nameMatch  = b.match(/alt="([^"]{5,120})"/i);
      const priceMatch = b.match(/data-price="([^"]+)"/i) || b.match(/"price"\s*:\s*"([^"]+)"/i);
      listings.push({
        title:    nameMatch ? nameMatch[1].trim() : linkMatch[1].split('/').pop().replace(/-/g, ' '),
        link:     linkMatch[1],
        image:    imgMatch[1].split('?')[0],
        source:   'etsy',
        shopName,
        shopUrl:  shopName ? `https://www.etsy.com/shop/${shopName}` : null,
        price:    priceMatch ? priceMatch[1].trim() : null,
      });
    }
  }
  if (listings.length >= 2) return listings;

  // Strategy 3: proximity matching
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
        title:   link.url.split('/').pop().replace(/-/g, ' '),
        link:    link.url,
        image:   closest.url,
        source:  'etsy',
        shopName,
        shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null,
        price:   null,
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

module.exports = { scrapeEtsy };



