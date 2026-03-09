const axios = require('axios');

/**
 * Scrape la vraie image principale d'une page produit AliExpress.
 * Retourne { imageUrl, dataUrl } — imageUrl pour vérification, dataUrl pour affichage sans CORS.
 */
async function scrapeAliexpressImage(productUrl) {
  try {
    // Extraire l'item ID
    const itemMatch = productUrl.match(/\/item\/(\d+)/)
                   || productUrl.match(/[?&]productId=(\d+)/)
                   || productUrl.match(/(\d{10,})/);
    if (!itemMatch) { console.log(`⚠️ Pas d'itemId dans: ${productUrl}`); return null; }

    const itemId = itemMatch[1];
    const canonicalUrl = `https://www.aliexpress.com/item/${itemId}.html`;
    console.log(`🔍 Scrape AliExpress item ${itemId}...`);

    const scraperUrl = `http://api.scraperapi.com/?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(canonicalUrl)}&render=false`;
    const response = await axios.get(scraperUrl, { timeout: 25000 });
    const html = response.data;

    let imgUrl = null;

    // Stratégie 1 : imagePathList dans le JSON (image officielle du produit, variant principal)
    const pathListMatch = html.match(/"imagePathList"\s*:\s*\[\s*"([^"]+)"/);
    if (pathListMatch?.[1]) {
      imgUrl = pathListMatch[1].replace(/\\u002F/g, '/').replace(/^\/\//, 'https://');
      console.log(`✅ Stratégie imagePathList`);
    }

    // Stratégie 2 : og:image
    if (!imgUrl) {
      const og = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (og?.[1]?.includes('alicdn')) {
        imgUrl = og[1].replace(/^\/\//, 'https://');
        console.log(`✅ Stratégie og:image`);
      }
    }

    // Stratégie 3 : première URL alicdn dans le HTML
    if (!imgUrl) {
      const cdn = html.match(/["'](https?:\/\/ae\d*\.alicdn\.com\/kf\/[^"'?]+\.(jpg|webp|png))["']/i);
      if (cdn?.[1]) {
        imgUrl = cdn[1];
        console.log(`✅ Stratégie alicdn tag`);
      }
    }

    if (!imgUrl) { console.log(`❌ Aucune image trouvée pour item ${itemId}`); return null; }

    // Nettoyer : retirer les suffixes de taille pour obtenir l'image originale
    imgUrl = imgUrl
      .split('?')[0]
      .replace(/_\d+x\d+[qQ]?\d*\.(jpg|jpeg|webp|png)/i, '.$1')
      .replace(/_[qQ]\d+\.(jpg|jpeg|webp|png)/i, '.$1');

    console.log(`🖼 URL finale: ${imgUrl.substring(0, 80)}`);

    // Télécharger et encoder en base64 data URL (pas de CORS dans le browser)
    const imgRes = await axios.get(imgUrl, {
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
    console.log(`✅ Image encodée (${Math.round(b64.length / 1024)}kb, ${ct})`);
    return `data:${ct};base64,${b64}`;

  } catch (err) {
    console.error(`❌ scrapeAliexpressImage: ${err.message}`);
    return null;
  }
}

module.exports = { scrapeAliexpressImage };
