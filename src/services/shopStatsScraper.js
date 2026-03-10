const axios = require('axios');

// ── Extrait les stats depuis le HTML d'une page listing Etsy déjà scraped ──
// Zéro appel ScrapingBee supplémentaire — on réutilise le HTML qu'on a déjà
function extractStatsFromListingHtml(html) {
  let sales = null;
  let createdAt = null;

  // ── VENTES ──
  const salesPatterns = [
    /"sales_count"\s*:\s*(\d+)/i,
    /"salesCount"\s*:\s*(\d+)/i,
    /"transaction_sold_count"\s*:\s*(\d+)/i,
    /"totalSales"\s*:\s*(\d+)/i,
    /(\d[\d,]+)\s+(?:sales|sale)\b/i,
    /(\d[\d,]+)\s+ventes?\b/i,
    /data-sales="(\d+)"/i,
    />(\d[\d,.]+)\s+[Ss]ales?</,
  ];
  for (const pat of salesPatterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseInt(m[1].replace(/[,.\s]/g, ''));
      if (val > 0) { sales = val; break; }
    }
  }

  // ── DATE DE CRÉATION ──
  const datePatterns = [
    [/"creation_tsz"\s*:\s*(\d{10})/i,               'unix'],
    [/"joined_epoch"\s*:\s*(\d{10})/i,               'unix'],
    [/"create_date"\s*:\s*(\d{10})/i,                'unix'],
    [/"joined"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i,  'iso'],
    [/"shopCreatedDate"\s*:\s*"([^"]+)"/i,           'iso'],
    [/"dateCreated"\s*:\s*"([^"]+)"/i,               'iso'],
    [/[Oo]n\s+Etsy\s+since\s+([A-Za-z]+ \d{4})/i,  'text'],
    [/[Mm]ember\s+since\s+([A-Za-z]+ \d{4})/i,      'text'],
    [/[Ss]elling\s+since\s+([A-Za-z]+ \d{4})/i,     'text'],
    [/since\D{0,20}(\d{4})/i,                        'year'],
  ];
  for (const [pat, type] of datePatterns) {
    const m = html.match(pat);
    if (!m) continue;
    let d = null;
    if (type === 'unix') {
      d = new Date(parseInt(m[1]) * 1000);
    } else if (type === 'year') {
      const y = parseInt(m[1]);
      if (y >= 2005 && y <= new Date().getFullYear()) d = new Date(`${y}-01-01`);
    } else {
      d = new Date(m[1]);
    }
    if (d && !isNaN(d.getTime()) && d.getFullYear() >= 2005) {
      createdAt = d;
      break;
    }
  }

  return { sales, createdAt };
}

// ── Scrape la page boutique via ScrapingBee (fallback si listing ne suffit pas) ──
async function scrapeShopPage(shopUrl, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      // Tentative 1 : render_js=false (rapide, ~2s)
      // Tentative 2+ : render_js=true (lent mais fiable, ~8s)
      const useJs = attempt > 1;
      const reqUrl = `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_KEY}`
        + `&url=${encodeURIComponent(shopUrl)}`
        + `&render_js=${useJs ? 'true' : 'false'}`
        + `&premium_proxy=true`
        + `&country_code=us`
        + (useJs ? '&wait=1500' : '')
        + `&timeout=45000`;

      const res  = await axios.get(reqUrl, { timeout: 120000 });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      console.log(`  📄 boutique (render_js=${useJs}, ${html.length} chars)`);
      return html;

    } catch (err) {
      const status = err.response?.status;
      console.warn(`  ⚠️ scrapeShopPage tentative ${attempt}/${retries + 1}: ${err.message}`);
      if (attempt <= retries && (status === 500 || status === 429 || err.code === 'ECONNABORTED')) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── Point d'entrée principal ──
// listingHtml : HTML de la page listing déjà scraped (peut être null)
// shopUrl     : URL de la boutique pour le fallback
async function scrapeShopStats(shopUrl, listingHtml = null) {
  console.log(`\n── ${shopUrl.split('/').pop()} ──`);

  // 1. Essayer d'extraire depuis le HTML listing (gratuit, immédiat)
  if (listingHtml) {
    const stats = extractStatsFromListingHtml(listingHtml);
    if (stats.sales && stats.createdAt) {
      console.log(`  ✅ listing: ventes=${stats.sales}, créée=${stats.createdAt.toLocaleDateString('fr-FR')}`);
      return { shopUrl, ...stats };
    }
    console.log(`  ⚠️ listing insuffisant (sales=${stats.sales ?? 'null'}, date=${stats.createdAt ?? 'null'}) → fallback boutique`);
  }

  // 2. Fallback : scraper la page boutique
  const html = await scrapeShopPage(shopUrl);
  if (!html) {
    console.log(`  ❌ scraping boutique échoué`);
    return { shopUrl, sales: null, createdAt: null };
  }

  const stats = extractStatsFromListingHtml(html);
  console.log(`  → FINAL: ventes=${stats.sales ?? 'null'}, créée=${stats.createdAt?.toLocaleDateString('fr-FR') ?? 'null'}\n`);
  return { shopUrl, ...stats };
}

// Score : ventes par jour d'existence
function computeScore(stats) {
  if (!stats.sales || !stats.createdAt) return 0;
  const ageMs   = Date.now() - stats.createdAt.getTime();
  const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 1);
  return stats.sales / ageDays;
}

module.exports = { scrapeShopStats, computeScore, extractStatsFromListingHtml };
