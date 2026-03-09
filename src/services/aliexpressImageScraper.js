const axios = require('axios');

/**
 * Scrape la vraie image principale d'un produit AliExpress
 * et la retourne en data URL base64 (pour éviter tout problème CORS/proxy côté browser)
 */
async function scrapeAliexpressImage(productUrl) {
  try {
    const itemMatch = productUrl.match(/item\/(\d+)/) || productUrl.match(/[?&]productId=(\d+)/) || productUrl.match(/(\d{10,})/);
    if (!itemMatch) { console.log(`⚠️ Pas d'itemId dans: ${productUrl}`); return null; }
    const itemId = itemMatch[1];
    const canonicalUrl = `https://www.aliexpress.com/item/${itemId}.html`;

    console.log(`🔍 Scrape AliExpress item ${itemId}...`);
    const scraperUrl = `http://api.scraperapi.com/?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(canonicalUrl)}&render=false`;
    const response = await axios.get(scraperUrl, { timeout: 25000 });
    const html = response.data;

    let imgUrl = null;

    // Stratégie 1 : og:image
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (og?.[1]?.includes('alicdn')) {
      imgUrl = og[1].replace(/^\/\//, 'https://').split('?')[0];
      console.log(`✅ og:image trouvée`);
    }

    // Stratégie 2 : imagePathList dans le JSON embarqué
    if (!imgUrl) {
      const jsonMatch = html.match(/"imagePathList"\s*:\s*\["([^"]+)"/);
      if (jsonMatch?.[1]) {
        imgUrl = jsonMatch[1].replace(/^\/\//, 'https://').replace(/\\u002F/g, '/');
        console.log(`✅ imagePathList trouvée`);
      }
    }

    // Stratégie 3 : première image alicdn dans les balises img
    if (!imgUrl) {
      const imgTag = html.match(/(?:src|data-src)=["'](https?:\/\/ae\d*\.alicdn\.com\/[^"'?]+)["']/i);
      if (imgTag?.[1]) {
        imgUrl = imgTag[1];
        console.log(`✅ img tag trouvée`);
      }
    }

    if (!imgUrl) { console.log(`❌ Aucune image trouvée pour item ${itemId}`); return null; }

    // Nettoyer l'URL (retirer les suffixes de taille pour avoir la pleine résolution)
    imgUrl = imgUrl.replace(/_\d+x\d+\.(jpg|webp|png)/i, '.$1').replace(/_(Q\d+|q\d+)\./, '.');
    // Forcer HTTPS et taille raisonnable
    imgUrl = imgUrl.replace(/^\/\//, 'https://');
    if (!imgUrl.includes('_')) imgUrl = imgUrl; // déjà clean

    console.log(`🖼 Image AliExpress: ${imgUrl.substring(0, 80)}`);

    // Télécharger et convertir en data URL pour éviter CORS dans le browser
    const imgResponse = await axios.get(imgUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.aliexpress.com/',
        'Accept': 'image/webp,image/jpeg,image/*'
      }
    });

    const contentType = imgResponse.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(imgResponse.data).toString('base64');
    const dataUrl = `data:${contentType};base64,${base64}`;
    console.log(`✅ Image convertie en base64 (${Math.round(base64.length / 1024)}kb)`);
    return dataUrl;

  } catch (err) {
    console.error(`❌ scrapeAliexpressImage: ${err.message}`);
    return null;
  }
}

module.exports = { scrapeAliexpressImage };
