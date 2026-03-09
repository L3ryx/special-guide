const axios = require('axios');

/**
 * Extrait la vraie image principale d'une page produit AliExpress
 * via ScraperAPI pour contourner le blocage
 */
async function scrapeAliexpressImage(productUrl) {
  try {
    // Extraire l'item ID de l'URL pour construire l'URL canonique
    const itemMatch = productUrl.match(/item\/(\d+)/) || productUrl.match(/(\d{10,})/);
    if (!itemMatch) return null;
    const itemId = itemMatch[1];

    // Utiliser ScraperAPI pour récupérer la page
    const scraperUrl = `http://api.scraperapi.com/?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(`https://www.aliexpress.com/item/${itemId}.html`)}&render=false`;

    const response = await axios.get(scraperUrl, { timeout: 20000 });
    const html = response.data;

    // Stratégie 1 : og:image (toujours l'image principale du produit)
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch && ogMatch[1] && ogMatch[1].includes('ae01.alicdn')) {
      const img = ogMatch[1].replace(/^\/\//, 'https://').split('?')[0] + '_480x480.jpg';
      console.log(`✅ AliExpress image (og): ${img.substring(0, 60)}...`);
      return img;
    }

    // Stratégie 2 : data-src dans la galerie principale
    const galleryMatch = html.match(/class="[^"]*image-view[^"]*"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)=["']([^"']+alicdn[^"']+)["']/i);
    if (galleryMatch && galleryMatch[1]) {
      const img = galleryMatch[1].replace(/^\/\//, 'https://').split('_')[0] + '_480x480.jpg';
      console.log(`✅ AliExpress image (gallery): ${img.substring(0, 60)}...`);
      return img;
    }

    // Stratégie 3 : JSON window.runParams ou __INIT_DATA__
    const jsonMatch = html.match(/"imagePathList"\s*:\s*\[([^\]]+)\]/);
    if (jsonMatch) {
      const firstImg = jsonMatch[1].match(/"(https?:\/\/[^"]+alicdn[^"]+)"/);
      if (firstImg) {
        const img = firstImg[1].split('_')[0] + '_480x480.jpg';
        console.log(`✅ AliExpress image (json): ${img.substring(0, 60)}...`);
        return img;
      }
    }

    console.log(`⚠️ Aucune image trouvée pour ${productUrl.substring(0, 60)}`);
    return null;

  } catch (err) {
    console.error(`❌ scrapeAliexpressImage error: ${err.message}`);
    return null;
  }
}

module.exports = { scrapeAliexpressImage };
