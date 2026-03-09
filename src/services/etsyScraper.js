const axios = require('axios');

const ACTOR_ID = 'epctex~etsy-scraper';

async function scrapeEtsy(keyword, maxCount = 10) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN manquant — ajoute-le dans les variables Render');

  console.log(`Apify Etsy Scraper: "${keyword}" (max ${maxCount})`);

  let response;
  try {
    response = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`,
      {
        search:   keyword,
        maxItems: Math.min(maxCount, 100),
        proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
      },
      { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error?.message || err.message;
    if (status === 401) throw new Error('APIFY_TOKEN invalide (401)');
    if (status === 402) throw new Error('Credits Apify epuises (402)');
    if (status === 429) throw new Error('Trop de requetes Apify (429)');
    throw new Error(`Apify erreur ${status || ''}: ${msg}`);
  }

  const items = Array.isArray(response.data) ? response.data : [];
  console.log(`${items.length} items recus depuis Apify`);

  const listings = items
    .map(item => {
      const link   = item.url || item.link || item.productUrl || null;
      const images = item.images || item.imageUrls || [];
      const image  = (Array.isArray(images) ? images[0] : images)
                  || item.image || item.imageUrl || item.thumbnail || null;
      const shopName   = item.shopName   || item.shop?.name   || item.sellerName || null;
      const shopUrl    = item.shopUrl    || item.shop?.url    || (shopName ? `https://www.etsy.com/shop/${shopName}` : null);
      const shopAvatar = item.shopAvatar || item.shop?.avatar || null;
      let price = null;
      if (item.price)      price = typeof item.price === 'string' ? item.price : `${item.currency || 'USD'} ${item.price}`;
      else if (item.priceLabel) price = item.priceLabel;

      return {
        title: item.title || item.name || '',
        link,
        image: typeof image === 'string' ? image : null,
        source: 'etsy',
        shopName, shopUrl, shopAvatar, price,
      };
    })
    .filter(l => l.link && l.image);

  console.log(`${listings.length} listings valides (image + lien)`);
  listings.forEach((l, i) =>
    console.log(`  [${i+1}] ${l.link.substring(0,60)} | img: ${l.image.substring(0,50)}`)
  );
  return listings;
}

async function debugEtsyHtml(keyword) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: false, error: 'APIFY_TOKEN non defini' };
  try {
    const response = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`,
      { search: keyword, maxItems: 2, proxy: { useApifyProxy: true } },
      { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
    );
    const items = Array.isArray(response.data) ? response.data : [];
    return {
      ok: true, count: items.length,
      sample: items[0] ? {
        title:    items[0].title,
        url:      items[0].url,
        image:    (items[0].images || [])[0] || items[0].image || null,
        shopName: items[0].shopName || null,
        price:    items[0].price    || null,
        raw_keys: Object.keys(items[0]),
      } : null,
    };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.response?.data || err.message };
  }
}

module.exports = { scrapeEtsy, debugEtsyHtml };
