const axios = require('axios');

/**
 * Scrape la vraie image principale d'un produit AliExpress.
 * Retourne { rawUrl, dataUrl } :
 *   - rawUrl   : URL directe alicdn (pour ImgBB upload)
 *   - dataUrl  : base64 data URL (pour OpenAI comparison)
 */
async function scrapeAliexpressImage(productUrl) {
  try {
    const itemMatch = productUrl.match(/\/item\/(\d+)/)
                   || productUrl.match(/[?&]productId=(\d+)/)
                   || productUrl.match(/(\d{10,})/);
    if (!itemMatch) { console.log(`⚠️ Pas d'itemId: ${productUrl}`); return null; }

    const itemId = itemMatch[1];
    const canonicalUrl = `https://www.aliexpress.com/item/${itemId}.html`;
    console.log(`🔍 Scrape item ${itemId}...`);

    const scraperUrl = `http://api.scraperapi.com/?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(canonicalUrl)}&render=false`;
    const response = await axios.get(scraperUrl, { timeout: 25000 });
    const html = response.data;

    let rawUrl = null;

    // Stratégie 1 : imagePathList (image officielle, variant principal)
    const pathList = html.match(/"imagePathList"\s*:\s*\[\s*"([^"]+)"/);
    if (pathList?.[1]) {
      rawUrl = pathList[1].replace(/\\u002F/g, '/').replace(/^\/\//, 'https://');
      console.log(`✅ imagePathList`);
    }

    // Stratégie 2 : og:image
    if (!rawUrl) {
      const og = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (og?.[1]?.includes('alicdn')) {
        rawUrl = og[1].replace(/^\/\//, 'https://');
        console.log(`✅ og:image`);
      }
    }

    // Stratégie 3 : première URL alicdn
    if (!rawUrl) {
      const cdn = html.match(/["'](https?:\/\/ae\d*\.alicdn\.com\/kf\/[^"'?]+\.(jpg|webp|png))["']/i);
      if (cdn?.[1]) { rawUrl = cdn[1]; console.log(`✅ alicdn tag`); }
    }

    if (!rawUrl) { console.log(`❌ Aucune image pour item ${itemId}`); return null; }

    // Extract price from HTML
    let price = null;
    const pricePatterns = [
      /"minActivityAmount"\s*:\s*\{"value"\s*:\s*"([^"]+)","currency"\s*:\s*"([^"]+)"/,
      /"salePrice"\s*:\s*\{"minAmount"\s*:\s*\{"value"\s*:\s*"([^"]+)","currency"\s*:\s*"([^"]+)"/,
      /"discountPrice"\s*:\s*"([^"]+)"/,
      /"formattedPrice"\s*:\s*"([^"]+)"/,
      /class="[^"]*product-price-value[^"]*"[^>]*>([^<]+)</,
      /"price"\s*:\s*"([\d.,]+)"\s*,\s*"currency"\s*:\s*"([^"]+)"/,
    ];
    for (const pat of pricePatterns) {
      const m = html.match(pat);
      if (m) {
        price = m[2] ? `${m[2]} ${m[1]}` : m[1].trim();
        // Clean up HTML entities
        price = price.replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();
        if (price.match(/[\d]/)) break;
        else price = null;
      }
    }
    if (price) console.log(`💰 AliExpress price: ${price}`);

    // Nettoyer l'URL (retirer les suffixes de taille)
    rawUrl = rawUrl.split('?')[0]
      .replace(/_\d+x\d+[qQ]?\d*\.(jpg|jpeg|webp|png)/i, '.$1')
      .replace(/_[qQ]\d+\.(jpg|jpeg|webp|png)/i, '.$1');

    console.log(`🖼 rawUrl: ${rawUrl.substring(0, 80)}`);

    // Télécharger pour la comparaison OpenAI (base64)
    const imgRes = await axios.get(rawUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.aliexpress.com/',
        'Accept': 'image/webp,image/jpeg,image/*'
      }
    });

    const ct = imgRes.headers['content-type']?.split(';')[0] || 'image/jpeg';
    const b64 = Buffer.from(imgRes.data).toString('base64');
    const dataUrl = `data:${ct};base64,${b64}`;
    console.log(`✅ Encodée (${Math.round(b64.length / 1024)}kb)`);

    return { rawUrl, dataUrl, price };

  } catch (err) {
    console.error(`❌ scrapeAliexpressImage: ${err.message}`);
    return null;
  }
}

module.exports = { scrapeAliexpressImage };
