const axios = require('axios');

async function scrapeEtsy(keyword, maxCount = 10, retries = 3) {
  const etsySearchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar`;

  // Premium + US IP + JS render pour contourner le blocage Etsy
  const params = new URLSearchParams({
    api_key: process.env.SCRAPEAPI_KEY,
    url: etsySearchUrl,
    render: 'true',
    premium: 'true',
    country_code: 'us',
  });
  const scraperUrl = `http://api.scraperapi.com?${params.toString()}`;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Scraping Etsy pour: "${keyword}" (tentative ${attempt}/${retries})`);
      const response = await axios.get(scraperUrl, { timeout: 60000 });
      const html = response.data;
      const listings = parseEtsyListings(html);

      const valid = listings.filter(l => l.link && l.image);
      console.log(`${listings.length} annonces dont ${valid.length} valides (image + lien)`);

      if (valid.length === 0) {
        console.warn(`Aucune annonce valide (tentative ${attempt}/${retries})`);
        if (attempt < retries) {
          const wait = attempt * 4000;
          console.log(`Retry dans ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error('Aucune annonce avec image et lien trouvee apres ' + retries + ' tentatives');
      }

      valid.forEach((l, i) => console.log(`  [${i+1}] ${l.link.substring(0,60)} | img: ${l.image.substring(0,50)}`));
      return valid.slice(0, maxCount);

    } catch (error) {
      if (error.message.includes('Aucune annonce')) throw error;
      lastError = error;
      console.error(`Etsy scrape erreur (tentative ${attempt}): ${error.message}`);
      if (attempt < retries) {
        const wait = attempt * 4000;
        console.log(`Retry dans ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw new Error(`Echec scraping Etsy apres ${retries} tentatives: ${lastError?.message}`);
}

function parseEtsyListings(html) {
  const listings = [];
  const seen = new Set();

  // ── Strategie 1 : JSON-LD ──
  const jsonLdBlocks = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url = item.url || item['@id'];
        const image = Array.isArray(item.image) ? item.image[0] : (typeof item.image === 'string' ? item.image : null);
        const name = item.name;
        if (url && url.includes('/listing/') && image && name && !seen.has(url)) {
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

  console.log(`JSON-LD: ${listings.length} annonces`);
  if (listings.length >= 2) return listings;

  // ── Strategie 2 : JSON embarque window.__data ou similaire ──
  const jsonDataMatches = [
    ...html.matchAll(/"listing_id"\s*:\s*(\d+)[\s\S]{0,500}?"url"\s*:\s*"([^"]+\/listing\/[^"]+)"[\s\S]{0,500}?"url"\s*:\s*"(https:\/\/i\.etsystatic\.com\/[^"]+)"/gi),
    ...html.matchAll(/"url"\s*:\s*"(https:\/\/www\.etsy\.com\/listing\/[^"]+)"[\s\S]{0,300}?"url"\s*:\s*"(https:\/\/i\.etsystatic\.com\/[^"]+)"/gi),
  ];
  for (const m of jsonDataMatches) {
    const link = (m[2] || m[1] || '').split('?')[0];
    const image = (m[3] || m[2] || '').split('?')[0];
    if (link.includes('/listing/') && image.includes('etsystatic') && !seen.has(link)) {
      seen.add(link);
      listings.push({ title: 'Produit Etsy', link, image, source: 'etsy', shopName: null, shopUrl: null, price: null });
    }
  }
  console.log(`Apres JSON embarque: ${listings.length} annonces`);
  if (listings.length >= 2) return listings;

  // ── Strategie 3 : blocs HTML avec data-listing-id ──
  const blockPattern = /(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi;
  const blocks = [...html.matchAll(blockPattern)];
  for (const block of blocks) {
    const b = block[1];
    const linkMatch = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgMatch  = b.match(/(?:src|data-src|data-image-url)="(https:\/\/i\.etsystatic\.com\/[^"\s]+)"/i)
                   || b.match(/srcset="(https:\/\/i\.etsystatic\.com\/[^\s"]+)/i);
    if (linkMatch && imgMatch && !seen.has(linkMatch[1])) {
      seen.add(linkMatch[1]);
      const shopAttr = b.match(/data-shop-name="([^"]+)"/i);
      const shopName = shopAttr ? shopAttr[1] : extractShopFromUrl(linkMatch[1]);
      const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
      const nameMatch = b.match(/alt="([^"]{5,120})"/i);
      const priceMatch = b.match(/data-price="([^"]+)"/i) || b.match(/"price"\s*:\s*"([^"]+)"/i);
      listings.push({
        title: nameMatch ? nameMatch[1].trim() : linkMatch[1].split('/').pop().replace(/-/g, ' '),
        link: linkMatch[1], image: imgMatch[1].split('?')[0],
        source: 'etsy', shopName, shopUrl,
        price: priceMatch ? priceMatch[1].trim() : null
      });
    }
  }
  console.log(`Apres blocs HTML: ${listings.length} annonces`);
  if (listings.length >= 2) return listings;

  // ── Strategie 4 : tous les liens listing + toutes les images etsystatic (proximity) ──
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];

  const linkPositions  = allLinks.map(m  => ({ url: m[1].split('?')[0], pos: m.index }));
  const imagePositions = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  console.log(`Proximity: ${linkPositions.length} liens, ${imagePositions.length} images`);

  for (const link of linkPositions) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imagePositions) {
      const dist = Math.abs(img.pos - link.pos);
      if (dist < minDist && dist < 5000) { minDist = dist; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      const shopName = extractShopFromUrl(link.url);
      const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
      listings.push({ title: link.url.split('/').pop().replace(/-/g, ' '), link: link.url, image: closest.url, source: 'etsy', shopName, shopUrl, price: null });
    }
  }

  console.log(`Total final: ${listings.length} annonces`);
  return listings;
}

function extractShopFromUrl(url) {
  const m = url.match(/etsy\.com\/shop\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

// Route debug: expose raw HTML snippet for diagnosis
async function debugEtsyHtml(keyword) {
  const etsySearchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar`;

  // Premium + US IP + JS render pour contourner le blocage Etsy
  const params = new URLSearchParams({
    api_key: process.env.SCRAPEAPI_KEY,
    url: etsySearchUrl,
    render: 'true',
    premium: 'true',
    country_code: 'us',
  });
  const scraperUrl = `http://api.scraperapi.com?${params.toString()}`;
  const response = await axios.get(scraperUrl, { timeout: 60000 });
  const html = response.data;
  return {
    length: html.length,
    hasListingLinks: (html.match(/etsy\.com\/listing/g) || []).length,
    hasEtsystatic: (html.match(/etsystatic\.com/g) || []).length,
    hasJsonLd: (html.match(/application\/ld\+json/g) || []).length,
    hasDataListingId: (html.match(/data-listing-id/g) || []).length,
    snippet: html.substring(0, 500)
  };
}

module.exports = { scrapeEtsy, debugEtsyHtml };
