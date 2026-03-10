const axios = require('axios');

// Scrape les stats d'une boutique Etsy via ScrapingBee
async function scrapeShopStats(shopUrl) {
  try {
    const url = `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_KEY}`
      + `&url=${encodeURIComponent(shopUrl)}`
      + `&render_js=false&premium_proxy=true&country_code=us`;

    const res  = await axios.get(url, { timeout: 30000 });
    const html = res.data;

    // Nombre de ventes
    let sales = null;
    const salesPatterns = [
      /"sales_count"\s*:\s*(\d+)/i,
      /(\d[\d,]+)\s+sales/i,
      /"transaction_sold_count"\s*:\s*(\d+)/i,
      /class="[^"]*shop-sales[^"]*"[^>]*>([\d,]+)/i,
      /"totalSales"\s*:\s*(\d+)/i,
      /(\d[\d,]+)\s+ventes/i,
    ];
    for (const pat of salesPatterns) {
      const m = html.match(pat);
      if (m) {
        sales = parseInt(m[1].replace(/,/g, ''));
        if (sales > 0) break;
        sales = null;
      }
    }

    // Date de création
    let createdAt = null;
    const datePatterns = [
      /"creation_tsz"\s*:\s*(\d+)/i,
      /"joined"\s*:\s*"([^"]+)"/i,
      /On Etsy since\s+([A-Za-z]+ \d{4})/i,
      /Member since\s+([A-Za-z]+ \d{4})/i,
      /"shopCreatedDate"\s*:\s*"([^"]+)"/i,
      /class="[^"]*shop-info[^"]*"[\s\S]{0,200}?(\d{4})/,
    ];
    for (const pat of datePatterns) {
      const m = html.match(pat);
      if (m) {
        if (/^\d{10}$/.test(m[1])) {
          createdAt = new Date(parseInt(m[1]) * 1000);
        } else {
          const d = new Date(m[1]);
          if (!isNaN(d)) createdAt = d;
        }
        if (createdAt) break;
      }
    }

    console.log(`🏪 ${shopUrl.split('/').pop()} — ventes: ${sales}, créée: ${createdAt?.toLocaleDateString('fr-FR') || 'inconnue'}`);
    return { shopUrl, sales, createdAt };

  } catch (err) {
    console.error(`scrapeShopStats error (${shopUrl}): ${err.message}`);
    return { shopUrl, sales: null, createdAt: null };
  }
}

// Score : ventes par jour d'existence (plus c'est élevé = récent + populaire)
function computeScore(stats) {
  if (!stats.sales || !stats.createdAt) return 0;
  const ageMs   = Date.now() - stats.createdAt.getTime();
  const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 1);
  return stats.sales / ageDays;
}

module.exports = { scrapeShopStats, computeScore };
