const express = require('express');
const router = express.Router();

const { scrapeEtsy, debugEtsyHtml } = require('../services/etsyScraper');
const { reverseImageSearch } = require('../services/reverseImageSearch');
const { compareEtsyWithAliexpress } = require('../services/imageSimilarity');
const { getShopInfo } = require('../services/shopScraper');
const { scrapeShopStats, computeScore } = require('../services/shopStatsScraper');

async function parallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

router.get('/debug', (req, res) => {
  const keys = ['SCRAPEAPI_KEY', 'SERPER_API_KEY', 'ANTHROPIC_API_KEY', 'IMGBB_API_KEY'];
  const status = {};
  for (const key of keys) {
    const val = process.env[key];
    status[key] = !val ? 'UNDEFINED' : val.includes('your_') ? 'DEFAUT' : `OK (${val.substring(0, 6)}...)`;
  }
  res.json({ keys: status });
});

router.post('/search', async (req, res) => {
  const { keyword, maxCount = 10 } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Mot-clé requis' });

  const missing = ['SCRAPEAPI_KEY','SERPER_API_KEY','ANTHROPIC_API_KEY','IMGBB_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: 'Clés manquantes: ' + missing.join(', ') });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (step, msg) => res.write('data: ' + JSON.stringify({ step, message: msg }) + '\n\n');
  const sendError = msg => { res.write('data: ' + JSON.stringify({ step: 'error', message: msg }) + '\n\n'); res.end(); };
  const sendComplete = r => { res.write('data: ' + JSON.stringify({ step: 'complete', results: r }) + '\n\n'); res.end(); };

  try {
    send('scraping_etsy', `🔍 Scraping Etsy pour "${keyword}"...`);
    const listings = await scrapeEtsy(keyword, maxCount);
    if (!listings.length) return sendError('Aucune annonce Etsy trouvée');
    send('etsy_done', `✅ ${listings.length} annonces trouvées`);

    // Enrich listings with shop info (avatar + confirmed shop name) — parallel, max 5
    send('reverse_search', `🏪 Récupération des infos boutiques...`);
    await parallel(listings, 5, async (listing) => {
      try {
        const shopInfo = await getShopInfo(listing);
        listing.shopName   = shopInfo.shopName   || listing.shopName;
        listing.shopUrl    = shopInfo.shopUrl    || listing.shopUrl;
        listing.shopAvatar = shopInfo.shopAvatar || null;
      } catch {}
    });

    send('reverse_search', `🔎 Analyse de ${listings.length} annonces en parallèle...`);

    let done = 0;
    const allResults = [];

    // 5 recherches en parallèle (Serper + ImgBB + Claude Vision)
    await parallel(
      listings.filter(l => l.image),
      5,
      async (listing) => {
        try {
          const matches = await reverseImageSearch(listing.image, listing.title || '');
          done++;
          send('comparing', `🤖 ${done}/${listings.length} analysées`);
          if (!matches.length) return;

          const comparisons = await compareEtsyWithAliexpress(listing, matches);
          if (comparisons.length > 0) {
            allResults.push(...comparisons);
            send('match_found', `✅ ${allResults.length} correspondance(s)`);
          }
        } catch (err) {
          console.error('Erreur listing:', err.message);
          done++;
        }
      }
    );

    send('finalizing', `📊 Terminé — ${allResults.length} résultat(s)`);

    // Dédupliquer par lien AliExpress, trier par similarité
    const seen = new Set();
    const deduped = allResults
      .sort((a, b) => b.similarity - a.similarity)
      .filter(r => {
        const k = r.aliexpress.link || '';
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    // Enrichir avec les infos boutique (en parallèle, max 3)
    await parallel(deduped, 3, async (result) => {
      try {
        const shop = await getShopInfo(result.etsy);
        result.etsy.shopName   = shop.shopName   || result.etsy.shopName   || null;
        result.etsy.shopUrl    = shop.shopUrl     || result.etsy.shopUrl    || null;
        result.etsy.shopAvatar = shop.shopAvatar  || null;
      } catch {}
    });

    sendComplete(deduped);

  } catch (err) {
    sendError(err.message || 'Erreur inattendue');
  }
});

router.get('/debug-etsy', async (req, res) => {
  const keyword = req.query.q || 'neon sign';
  try {
    const info = await debugEtsyHtml(keyword);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shop-stats — scrape stats de chaque boutique et retourne le winner
router.post('/shop-stats', async (req, res) => {
  const { results } = req.body;
  if (!results?.length) return res.status(400).json({ error: 'Aucun résultat fourni' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  try {
    const shops = [...new Map(
      results.map(r => [r.etsy.shopUrl || r.etsy.shopName, {
        shopUrl:  r.etsy.shopUrl,
        shopName: r.etsy.shopName,
        listingUrl: r.etsy.link
      }])
    ).values()].filter(s => s.shopUrl);

    send({ step: 'start', total: shops.length, message: `Analyse de ${shops.length} boutique(s)...` });

    const statsArr = [];
    for (let i = 0; i < shops.length; i++) {
      const shop = shops[i];
      send({ step: 'scraping', index: i, shopName: shop.shopName, message: `Scraping ${shop.shopName}...` });
      const stats = await scrapeShopStats(shop.shopUrl);
      stats.shopName   = shop.shopName;
      stats.listingUrl = shop.listingUrl;
      stats.score      = computeScore(stats);
      statsArr.push(stats);
      send({ step: 'done', index: i, shopName: shop.shopName, stats: {
        sales: stats.sales,
        createdAt: stats.createdAt,
        score: stats.score
      }});
    }

    // Winner = meilleur score (ventes/jour)
    const withScore = statsArr.filter(s => s.score > 0);
    withScore.sort((a, b) => b.score - a.score);
    const winner = withScore[0] || statsArr[0];

    send({ step: 'complete', winner, all: statsArr.map(s => ({
      shopName:  s.shopName,
      shopUrl:   s.shopUrl,
      sales:     s.sales,
      createdAt: s.createdAt,
      score:     s.score
    }))});
    res.end();

  } catch (err) {
    send({ step: 'error', message: err.message });
    res.end();
  }
});

router.get('/health', (req, res) => {
  const keys = {
    SCRAPEAPI_KEY:     !!process.env.SCRAPEAPI_KEY,
    SERPER_API_KEY:    !!process.env.SERPER_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    IMGBB_API_KEY:     !!process.env.IMGBB_API_KEY
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

module.exports = router;
