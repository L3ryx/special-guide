const axios = require('axios');

async function scrapeEtsy(keyword, maxCount = 10, retries = 3) {
  const etsySearchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`;
  const scraperUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(etsySearchUrl)}&render=true`;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🔍 Scraping Etsy pour: "${keyword}" (tentative ${attempt}/${retries})`);
      const response = await axios.get(scraperUrl, { timeout: 60000 });
      const html = response.data;
      const listings = parseEtsyListings(html);

      if (listings.length === 0 && attempt < retries) {
        console.warn(`⚠️ Aucune annonce trouvée (tentative ${attempt}), retry dans 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      console.log(`✅ ${listings.length} annonces Etsy trouvées`);
      listings.forEach((l, i) => console.log(`  [${i+1}] ${l.link.substring(0,60)} | img: ${l.image ? l.image.substring(0,50) : 'null'}`));
      return listings.slice(0, maxCount);

    } catch (error) {
      lastError = error;
      console.error(`❌ Etsy scrape erreur (tentative ${attempt}): ${error.message}`);
      if (attempt < retries) {
        const wait = attempt * 4000;
        console.log(`⏳ Retry dans ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw new Error(`Failed to scrape Etsy after ${retries} attempts: ${lastError?.message}`);
}

function parseEtsyListings(html) {
  const listings = [];
  const seen = new Set();

  // Stratégie 1 : JSON-LD (le plus fiable — chaque objet contient url + image + name ensemble)
  const jsonLdBlocks = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url = item.url || item['@id'];
        const image = Array.isArray(item.image) ? item.image[0] : item.image;
        const name = item.name;
        if (url?.includes('/listing/') && image && name && !seen.has(url)) {
          seen.add(url);
          const shopName = item.seller?.name || item.brand?.name || extractShopFromUrl(url) || null;
          const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
          // Extract price
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

  if (listings.length >= 4) {
    console.log(`📦 JSON-LD: ${listings.length} annonces`);
    return listings;
  }

  // Stratégie 2 : blocs HTML individuels — chaque annonce contient son propre lien + image
  // On cherche chaque bloc <li> ou <div> qui contient à la fois un href listing ET une image etsystatic
  const blockPattern = /(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi;
  const blocks = [...html.matchAll(blockPattern)];

  for (const block of blocks) {
    const b = block[1];
    const linkMatch = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgMatch  = b.match(/(?:src|data-src)="(https:\/\/i\.etsystatic\.com\/[^"]+\.(jpg|jpeg|png|webp))(?:\?[^"]*)?"/i);
    const nameMatch = b.match(/alt="([^"]{5,120})"/i) || b.match(/<h[23][^>]*>([^<]{5,120})<\/h[23]>/i);

    if (linkMatch && imgMatch && !seen.has(linkMatch[1])) {
      seen.add(linkMatch[1]);
      // Try to extract shop from a data-shop-name attr or nearby text in the block
      const shopAttr = b.match(/data-shop-name="([^"]+)"/i) || b.match(/shop\/([A-Za-z0-9]+)\/listing/i);
      const shopName = shopAttr ? shopAttr[1] : extractShopFromUrl(linkMatch[1]);
      const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
      // Try to extract price from block
      const priceMatch = b.match(/data-price="([^"]+)"/i)
                      || b.match(/class="[^"]*currency[^"]*"[^>]*>([^<]+)</i)
                      || b.match(/(?:USD|EUR|GBP|CAD|AUD)\s*[\d,.]+/i);
      const price = priceMatch ? priceMatch[1].trim() : null;
      listings.push({
        title: nameMatch ? nameMatch[1].trim() : linkMatch[1].split('/').pop().replace(/-/g, ' '),
        link: linkMatch[1],
        image: imgMatch[1],
        source: 'etsy',
        shopName,
        shopUrl,
        price
      });
    }
  }

  if (listings.length >= 2) {
    console.log(`📦 Blocs HTML: ${listings.length} annonces`);
    return listings;
  }

  // Stratégie 3 : association directe lien+image via proximity dans le HTML
  // On extrait tous les couples (listing URL, image Etsy) proches l'un de l'autre
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src)="(https:\/\/i\.etsystatic\.com\/[^"]+\.(jpg|jpeg|png|webp))(?:\?[^"]*)?"/gi)];

  // Trouver la position de chaque élément dans le HTML
  const linkPositions  = allLinks.map(m  => ({ url: m[1], pos: m.index }));
  const imagePositions = allImages.map(m => ({ url: m[1], pos: m.index }));

  for (const link of linkPositions) {
    if (seen.has(link.url)) continue;
    // Trouver l'image la plus proche (avant ou après, dans les 3000 chars)
    let closest = null;
    let minDist = Infinity;
    for (const img of imagePositions) {
      const dist = Math.abs(img.pos - link.pos);
      if (dist < minDist && dist < 3000) { minDist = dist; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      const shopName = extractShopFromUrl(link.url);
      const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
      listings.push({
        title: link.url.split('/').pop().replace(/-/g, ' '),
        link: link.url,
        image: closest.url,
        source: 'etsy',
        shopName,
        shopUrl,
        price: null
      });
    }
  }

  console.log(`📦 Proximity: ${listings.length} annonces`);
  return listings;
}

// Extract shop name from Etsy listing URL
// e.g. https://www.etsy.com/listing/123/title → needs page scrape, but some URLs contain shop
// Fallback: parse from HTML data attributes picked up in strategy 2
function extractShopFromUrl(url) {
  // Some Etsy URLs contain the shop: /shop/ShopName/listing/...
  const m = url.match(/etsy\.com\/shop\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

module.exports = { scrapeEtsy };
