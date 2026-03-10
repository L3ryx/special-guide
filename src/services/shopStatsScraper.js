const axios = require('axios');

async function scrapeShopStats(shopUrl, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const reqUrl = `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_KEY}`
        + `&url=${encodeURIComponent(shopUrl)}`
        + `&render_js=false`
        + `&premium_proxy=true`
        + `&country_code=us`
        + `&timeout=45000`;

      const res  = await axios.get(reqUrl, { timeout: 120000 });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      console.log(`\n── ${shopUrl.split('/').pop()} (${html.length} chars) ──`);

      // ── VENTES ──
      let sales = null;
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
          if (val > 0) { sales = val; console.log(`  ✅ ventes: ${sales}`); break; }
        }
      }
      if (!sales) console.log(`  ❌ ventes non trouvées`);

      // ── DATE DE CRÉATION ──
      let createdAt = null;
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
          console.log(`  ✅ date: ${createdAt.toLocaleDateString('fr-FR')}`);
          break;
        }
      }
      if (!createdAt) console.log(`  ❌ date non trouvée`);

      // ── FALLBACK /about ──
      if (!sales || !createdAt) {
        try {
          const aboutUrl    = shopUrl.replace(/\/$/, '') + '/about';
          const aboutReqUrl = `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_KEY}`
            + `&url=${encodeURIComponent(aboutUrl)}`
            + `&render_js=false&premium_proxy=true&country_code=us&timeout=30000`;
          const aboutRes  = await axios.get(aboutReqUrl, { timeout: 90000 });
          const aboutHtml = typeof aboutRes.data === 'string' ? aboutRes.data : JSON.stringify(aboutRes.data);
          console.log(`  📄 /about: ${aboutHtml.length} chars`);

          if (!sales) {
            for (const pat of salesPatterns) {
              const m = aboutHtml.match(pat);
              if (m) {
                const val = parseInt(m[1].replace(/[,.\s]/g, ''));
                if (val > 0) { sales = val; console.log(`  ✅ ventes /about: ${sales}`); break; }
              }
            }
          }
          if (!createdAt) {
            for (const [pat, type] of datePatterns) {
              const m = aboutHtml.match(pat);
              if (!m) continue;
              let d = null;
              if (type === 'unix') d = new Date(parseInt(m[1]) * 1000);
              else if (type === 'year') { const y = parseInt(m[1]); if (y >= 2005 && y <= new Date().getFullYear()) d = new Date(`${y}-01-01`); }
              else d = new Date(m[1]);
              if (d && !isNaN(d.getTime()) && d.getFullYear() >= 2005) {
                createdAt = d;
                console.log(`  ✅ date /about: ${createdAt.toLocaleDateString('fr-FR')}`);
                break;
              }
            }
          }
        } catch (e) {
          console.log(`  ⚠️ /about échoué: ${e.message}`);
        }
      }

      console.log(`  → FINAL: ventes=${sales ?? 'null'}, créée=${createdAt?.toLocaleDateString('fr-FR') ?? 'null'}\n`);
      return { shopUrl, sales, createdAt };

    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || (err.message || '').includes('timeout');
      console.warn(`scrapeShopStats tentative ${attempt}/${retries + 1} (${shopUrl.split('/').pop()}): ${err.message}`);
      if (attempt <= retries && isTimeout) {
        const wait = attempt * 3000;
        console.log(`⏳ Retry dans ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error(`scrapeShopStats échoué (${shopUrl}): ${err.message}`);
      return { shopUrl, sales: null, createdAt: null };
    }
  }
}

function computeScore(stats) {
  if (!stats.sales || !stats.createdAt) return 0;
  const ageMs   = Date.now() - stats.createdAt.getTime();
  const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 1);
  return stats.sales / ageDays;
}

module.exports = { scrapeShopStats, computeScore };
