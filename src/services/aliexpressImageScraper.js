const axios = require('axios');

async function scrapeAliexpressImage(productUrl) {
  try {
    const m = productUrl.match(/\/item\/(\d+)/);
    if (!m) return null;
    const itemId = m[1];

    const url = `http://api.scraperapi.com/?api_key=${process.env.SCRAPEAPI_KEY}&url=${encodeURIComponent(`https://www.aliexpress.com/item/${itemId}.html`)}&render=false`;
    const res  = await axios.get(url, { timeout: 25000 });
    const html = res.data;

    // Image
    let rawUrl = null;
    const imgPatterns = [
      /"imagePathList"\s*:\s*\[\s*"([^"]+)"/,
      /property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /["'](https?:\/\/ae\d*\.alicdn\.com\/kf\/[^"'?]+\.(jpg|webp|png))["']/i,
    ];
    for (const pat of imgPatterns) {
      const match = html.match(pat);
      if (match?.[1]?.includes('alicdn') || pat.source.includes('imagePathList')) {
        rawUrl = match[1].replace(/\\u002F/g, '/').replace(/^\/\//, 'https://');
        break;
      }
    }
    if (!rawUrl) return null;
    rawUrl = rawUrl.split('?')[0];

    // Prix
    let price = null;
    const pricePatterns = [
      /"minActivityAmount"\s*:\s*\{"value"\s*:\s*"([^"]+)","currency"\s*:\s*"([^"]+)"/,
      /"salePrice"\s*:\s*\{"minAmount"\s*:\s*\{"value"\s*:\s*"([^"]+)","currency"\s*:\s*"([^"]+)"/,
      /"formattedPrice"\s*:\s*"([^"]+)"/,
    ];
    for (const pat of pricePatterns) {
      const match = html.match(pat);
      if (match) {
        price = match[2] ? `${match[2]} ${match[1]}` : match[1].trim();
        if (/\d/.test(price)) break;
        price = null;
      }
    }

    // Télécharger l'image en base64
    const imgRes = await axios.get(rawUrl, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.aliexpress.com/', 'Accept': 'image/*' }
    });
    const ct  = imgRes.headers['content-type']?.split(';')[0] || 'image/jpeg';
    const b64 = Buffer.from(imgRes.data).toString('base64');

    return { rawUrl, dataUrl: `data:${ct};base64,${b64}`, price };
  } catch (err) {
    console.error(`scrapeAliexpressImage error: ${err.message}`);
    return null;
  }
}

module.exports = { scrapeAliexpressImage };
