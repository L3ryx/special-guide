const axios = require('axios');

function extractStatsFromListingHtml(html) {
  let sales     = null;
  let createdAt = null;
  let avgPrice  = null;

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

  // ── DATE ──
  const datePatterns = [
    [/[Oo]n\s+Etsy\s+since[\s\S]{0,60}<span[^>]*>(20[0-2]\d)<\/span>/i, 'year'],
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
    if      (type === 'unix') d = new Date(parseInt(m[1]) * 1000);
    else if (type === 'year') { const y = parseInt(m[1]); if (y >= 2005 && y <= new Date().getFullYear()) d = new Date(`${y}-01-01`); }
    else d = new Date(m[1]);
    if (d && !isNaN(d.getTime()) && d.getFullYear() >= 2005) { createdAt = d; break; }
  }

  // ── PRIX DES LISTINGS (page boutique) ──
  // Etsy embarque les prix dans le JSON __NEXT_DATA__ ou en data-attributes
  // Format typique : "price":{"amount":2500,"divisor":100,"currency_code":"USD"}
  // ou "price":"25.00" ou data-price="25.00"
  const prices = [];

  // JSON structuré : "amount":XXXX,"divisor":100
  const priceStructured = [...html.matchAll(/"amount"\s*:\s*(\d+)\s*,\s*"divisor"\s*:\s*(\d+)/g)];
  for (const m of priceStructured) {
    const val = parseInt(m[1]) / parseInt(m[2]);
    if (val >= 0.5 && val <= 5000) prices.push(val);
  }

  // JSON simple : "price":"25.00" ou "price":25.00
  if (prices.length === 0) {
    const priceSimple = [...html.matchAll(/"price"\s*:\s*"?([\d]+\.?\d*)"?/g)];
    for (const m of priceSimple) {
      const val = parseFloat(m[1]);
      if (val >= 0.5 && val <= 5000) prices.push(val);
    }
  }

  // HTML data-price ou data-listing-price
  if (prices.length === 0) {
    const priceData = [...html.matchAll(/data-(?:listing-)?price="([\d.]+)"/g)];
    for (const m of priceData) {
      const val = parseFloat(m[1]);
      if (val >= 0.5 && val <= 5000) prices.push(val);
    }
  }

  if (prices.length > 0) {
    // Dédupliquer et limiter les outliers (enlever les 10% extrêmes)
    prices.sort((a, b) => a - b);
    const trim = Math.floor(prices.length * 0.1);
    const trimmed = prices.slice(trim, prices.length - trim || undefined);
    avgPrice = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
    console.log(`  💰 ${prices.length} prix trouvés → moyenne: $${avgPrice.toFixed(2)}`);
  } else {
    console.log(`  ❌ prix non trouvés`);
  }

  return { sales, createdAt, avgPrice };
}

async function scrapeShopPage(shopUrl, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
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

async function scrapeShopStats(shopUrl, listingHtml = null) {
  console.log(`\n── ${shopUrl.split('/').pop()} ──`);

  if (listingHtml) {
    const stats = extractStatsFromListingHtml(listingHtml);
    if (stats.sales && stats.createdAt) {
      console.log(`  ✅ listing: ventes=${stats.sales}, créée=${stats.createdAt.toLocaleDateString('fr-FR')}`);
      // Même si listing suffit pour les stats de base, on scrape quand même la boutique pour les prix
    }
  }

  // Toujours scraper la page boutique pour récupérer les prix des listings
  const html = await scrapeShopPage(shopUrl);
  if (!html) {
    console.log(`  ❌ scraping boutique échoué`);
    // Fallback sur le listingHtml si dispo
    if (listingHtml) {
      const stats = extractStatsFromListingHtml(listingHtml);
      return { shopUrl, ...stats, avgPrice: null };
    }
    return { shopUrl, sales: null, createdAt: null, avgPrice: null };
  }

  const stats = extractStatsFromListingHtml(html);

  // Si la page boutique n'a pas les ventes/date, essayer le listingHtml
  if (listingHtml) {
    const fallback = extractStatsFromListingHtml(listingHtml);
    if (!stats.sales && fallback.sales)       stats.sales     = fallback.sales;
    if (!stats.createdAt && fallback.createdAt) stats.createdAt = fallback.createdAt;
  }

  console.log(`  → FINAL: ventes=${stats.sales ?? 'null'}, créée=${stats.createdAt?.toLocaleDateString('fr-FR') ?? 'null'}, prixMoyen=${stats.avgPrice ? '$'+stats.avgPrice.toFixed(2) : 'null'}\n`);
  return { shopUrl, ...stats };
}

function computeScore(stats) {
  if (!stats.sales || !stats.createdAt) return 0;
  const ageMs   = Date.now() - stats.createdAt.getTime();
  const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 1);
  return stats.sales / ageDays;
}

module.exports = { scrapeShopStats, computeScore, extractStatsFromListingHtml };
