const axios = require('axios');

async function scrapeEtsy(keyword, maxCount = 10) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_KEY manquant â€” ajoute-le dans les variables Render');

  console.log(`ScrapingBee Etsy: "${keyword}" (max ${maxCount})`);

  const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar`;

  let response;
  try {
    response = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: {
        api_key:         apiKey,
        url:             etsyUrl,
        render_js:       'true',
        premium_proxy:   'true',
        country_code:    'us',
        wait:            '2000',
      },
      timeout: 60000,
    });
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data || err.message;
    if (status === 401) throw new Error('SCRAPINGBEE_KEY invalide (401)');
    if (status === 429) throw new Error('Credits ScrapingBee epuises (429)');
    throw new Error(`ScrapingBee erreur ${status || ''}: ${msg}`);
  }

  const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  console.log(`HTML recu: ${html.length} chars`);

  const listings = parseEtsyListings(html);
  const valid    = listings.filter(l => l.link && l.image);

  console.log(`${listings.length} annonces dont ${valid.length} valides`);
  valid.forEach((l, i) =>
    console.log(`  [${i+1}] ${l.link.substring(0,60)} | img: ${l.image.substring(0,50)}`)
  );

  if (valid.length === 0) throw new Error('Aucune annonce trouvee â€” Etsy a peut-etre change sa structure');

  return valid.slice(0, maxCount);
}

function parseEtsyListings(html) {
  const listings = [];
  const seen     = new Set();

  // Strategie 1 : JSON-LD
  const jsonLdBlocks = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of jsonLdBlocks) {
    try {
      const data  = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url   = item.url || item['@id'];
        const rawImg = Array.isArray(item.image) ? item.image[0] : (typeof item.image === 'string' ? item.image : null);
        const image = cleanEtsyImage(rawImg);
        const name  = item.name;
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
  if (listings.length >= 2) { console.log(`JSON-LD: ${listings.length}`); return listings; }

  // Strategie 2 : blocs data-listing-id
  const blocks = [...html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)];
  for (const block of blocks) {
    const b         = block[1];
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
        link:  linkMatch[1], image: imgMatch[1].split('?')[0],
        source: 'etsy', shopName, shopUrl,
        price: priceMatch ? priceMatch[1].trim() : null,
      });
    }
  }
  if (listings.length >= 2) { console.log(`Blocs HTML: ${listings.length}`); return listings; }

  // Strategie 3 : proximity liens + images
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const linkPos   = allLinks.map(m  => ({ url: m[1].split('?')[0], pos: m.index }));
  const imgPos    = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  console.log(`Proximity: ${linkPos.length} liens, ${imgPos.length} images`);
  for (const link of linkPos) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - link.pos);
      if (d < minDist && d < 5000) { minDist = d; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      const shopName = extractShopFromUrl(link.url);
      listings.push({ title: link.url.split('/').pop().replace(/-/g, ' '), link: link.url, image: closest.url, source: 'etsy', shopName, shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null, price: null });
    }
  }

  console.log(`Total: ${listings.length}`);
  return listings;
}

function extractShopFromUrl(url) {
  const m = url.match(/etsy\.com\/shop\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

// Nettoie et valide une URL image etsystatic
// Les URLs tronquees comme /c/2142/2142/367/ sont invalides
function cleanEtsyImage(url) {
  if (!url) return null;
  // Retirer les parametres
  url = url.split('?')[0].trim();
  // Doit se terminer par une extension image
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(url)) return url;
  // Essayer d'ajouter il_fullxfull.jpg si l'URL contient un path etsystatic valide
  // Pattern valide: /r/il/HASH/DIGITS/il_...jpg  ou /c/.../il_...jpg
  // Pattern invalide: se termine par un chiffre ou /
  if (url.match(/\/il\/[a-f0-9]+\/\d+$/)) {
    return url + '.jpg';
  }
  return null;
}

async function debugEtsyHtml(keyword) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) return { ok: false, error: 'SCRAPINGBEE_KEY non defini' };
  try {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`;
    const response = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: { api_key: apiKey, url: etsyUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '2000' },
      timeout: 60000,
    });
    const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const listings = parseEtsyListings(html);
    const valid    = listings.filter(l => l.link && l.image);
    return {
      ok: true,
      htmlLength:      html.length,
      listingLinks:    (html.match(/etsy\.com\/listing/g) || []).length,
      etsystatic:      (html.match(/etsystatic\.com/g)    || []).length,
      jsonLd:          (html.match(/application\/ld\+json/g) || []).length,
      dataListingId:   (html.match(/data-listing-id/g)    || []).length,
      validListings:   valid.length,
      sample:          valid[0] || null,
    };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

module.exports = { scrapeEtsy, debugEtsyHtml };
